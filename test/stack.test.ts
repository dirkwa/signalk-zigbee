import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyDefaults } from "../src/config.js";
import {
  ensureZ2mFiles,
  initialZ2mConfig,
  mosquittoConf,
  mosquittoContainer,
  usbCoordinatorProblem,
  writeMosquittoFiles,
  z2mContainer,
} from "../src/stack.js";

const MOUNT = {
  source: "/var/lib/signalk/plugin-config-data/signalk-zigbee",
  containerPath: "/data",
};
const USB = "/dev/serial/by-id/usb-stick-if00-port0";

const settings = applyDefaults({
  networks: [
    { id: "main", serialPort: USB, rtscts: false },
    { id: "fly", coordinator: "espos", esposAddress: "zb-gw" },
  ],
});
const [usbNet, esposNet] = settings.networks;

describe("mosquitto", () => {
  it("listens on loopback only and persists", () => {
    const conf = mosquittoConf(1883, "/data/mosquitto/data");
    expect(conf).toContain("listener 1883 127.0.0.1");
    expect(conf).toContain("persistence_location /data/mosquitto/data/");
    expect(conf).not.toContain("user root");
  });

  it("runs on the host network with the plugin's config", () => {
    const brokerMount = { ...MOUNT, containerPath: "/mosquitto/data" };
    expect(mosquittoContainer(settings, "2.0.22", brokerMount)).toMatchObject({
      image: "eclipse-mosquitto",
      tag: "2.0.22",
      networkMode: "host",
      volumes: {
        "/mosquitto/data": MOUNT.source,
        "/mosquitto/log": MOUNT.source,
      },
      command: ["mosquitto", "-c", "/mosquitto/data/mosquitto/mosquitto.conf"],
      user: { inImageUid: 1883, inImageGid: 1883 },
    });
  });

  it("writes its files into the data dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skz-"));
    await writeMosquittoFiles(dir, settings, "/data");
    expect(
      readFileSync(join(dir, "mosquitto", "mosquitto.conf"), "utf8"),
    ).toContain("persistence_location /data/mosquitto/data/");
  });
});

describe("zigbee2mqtt", () => {
  it("passes a USB coordinator as /dev/zigbee", () => {
    const config = z2mContainer(
      usbNet!,
      settings,
      "ghcr.io/koenkk/zigbee2mqtt",
      "2.14.2",
      MOUNT,
      {
        serialPort: "/dev/zigbee",
        devices: [`${USB}:/dev/zigbee`],
        groupAdd: ["dialout"],
      },
      "tok-main",
    );
    expect(config).toMatchObject({
      networkMode: "host",
      devices: [`${USB}:/dev/zigbee`],
      groupAdd: ["dialout"],
    });
    expect(config.env).toEqual({
      ZIGBEE2MQTT_DATA: "/data/networks/main",
      ZIGBEE2MQTT_CONFIG_MQTT_SERVER: "mqtt://127.0.0.1:1883",
      ZIGBEE2MQTT_CONFIG_MQTT_BASE_TOPIC: "zigbee2mqtt-main",
      ZIGBEE2MQTT_CONFIG_SERIAL_PORT: "/dev/zigbee",
      ZIGBEE2MQTT_CONFIG_SERIAL_ADAPTER: "ember",
      ZIGBEE2MQTT_CONFIG_SERIAL_BAUDRATE: "115200",
      ZIGBEE2MQTT_CONFIG_SERIAL_RTSCTS: "false",
      ZIGBEE2MQTT_CONFIG_FRONTEND_ENABLED: "true",
      ZIGBEE2MQTT_CONFIG_FRONTEND_AUTH_TOKEN: "tok-main",
      ZIGBEE2MQTT_CONFIG_FRONTEND_PORT: "8099",
      ZIGBEE2MQTT_CONFIG_HOMEASSISTANT_ENABLED: "false",
    });
  });

  it("points an espOS network at the coordinator over TCP", () => {
    const config = z2mContainer(
      esposNet!,
      settings,
      "ghcr.io/tostmann/zigbee2mqtt-esp32",
      "latest",
      MOUNT,
      { serialPort: "tcp://192.168.0.77:6638" },
      "tok-fly",
    );
    expect(config.devices).toBeUndefined();
    expect(config.env).toMatchObject({
      ZIGBEE2MQTT_CONFIG_SERIAL_PORT: "tcp://192.168.0.77:6638",
      ZIGBEE2MQTT_CONFIG_SERIAL_ADAPTER: "zboss",
      ZIGBEE2MQTT_CONFIG_MQTT_BASE_TOPIC: "zigbee2mqtt-fly",
      ZIGBEE2MQTT_CONFIG_FRONTEND_PORT: "8100",
      ZIGBEE2MQTT_CONFIG_FRONTEND_AUTH_TOKEN: "tok-fly",
    });
    expect(config.env).not.toHaveProperty("ZIGBEE2MQTT_CONFIG_SERIAL_BAUDRATE");
  });

  it("seeds a new network once and never overwrites Zigbee2MQTT's file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skz-"));
    await ensureZ2mFiles(dir, usbNet!);
    const file = join(dir, "networks", "main", "configuration.yaml");
    expect(readFileSync(file, "utf8")).toBe(initialZ2mConfig(usbNet!));
    expect(readFileSync(file, "utf8")).toContain("network_key: GENERATE");

    writeFileSync(file, "version: 5\nadvanced:\n  network_key: [1, 2, 3]\n");
    await ensureZ2mFiles(dir, usbNet!);
    expect(readFileSync(file, "utf8")).toContain("network_key: [1, 2, 3]");
  });

  it("generates a web interface token once and keeps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skz-"));
    const first = await ensureZ2mFiles(dir, usbNet!);
    expect(first.frontendToken).toMatch(/^[0-9a-f]{32}$/);
    expect(await ensureZ2mFiles(dir, usbNet!)).toEqual(first);
    const other = await ensureZ2mFiles(dir, esposNet!);
    expect(other.frontendToken).not.toBe(first.frontendToken);
  });
});

describe("usbCoordinatorProblem", () => {
  it("accepts a stick Signal K can see", () => {
    expect(usbCoordinatorProblem(USB, true, true)).toBeUndefined();
    // The host probe could not run, but the stick is right here.
    expect(usbCoordinatorProblem(USB, undefined, true)).toBeUndefined();
  });

  it("reports a stick that is not plugged in", () => {
    expect(usbCoordinatorProblem(USB, false, false)).toMatch(
      /is not plugged in/,
    );
  });

  it("accepts a stick only the host sees", () => {
    expect(usbCoordinatorProblem(USB, true, false)).toBeUndefined();
  });

  it("names both causes when the host could not be probed", () => {
    const problem = usbCoordinatorProblem(USB, undefined, false);
    expect(problem).toMatch(/unplugged, or not passed to its container/);
    expect(problem).toContain("signalk hardware rescan");
  });
});
