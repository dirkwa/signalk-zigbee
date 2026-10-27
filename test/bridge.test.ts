import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionResult } from "@signalk/server-api";
import {
  ZigbeeBridge,
  type BridgeApp,
  type MqttClientLike,
} from "../src/bridge.js";
import type { Expose } from "../src/exposes.js";

const snzb02d = JSON.parse(
  readFileSync(
    new URL("./fixtures/snzb02d-exposes.json", import.meta.url),
    "utf8",
  ),
) as { exposes: Expose[] };

const BASE = "zigbee2mqtt-main";

class FakeMqtt extends EventEmitter implements MqttClientLike {
  subscribed: string[] = [];
  published: { topic: string; message: string }[] = [];
  failPublish = false;

  subscribe(topic: string | string[], callback?: (err?: Error | null) => void) {
    this.subscribed.push(...(Array.isArray(topic) ? topic : [topic]));
    callback?.(null);
    return this;
  }

  publish(
    topic: string,
    message: string,
    _opts: { qos: 0 | 1 },
    callback?: (err?: Error) => void,
  ) {
    this.published.push({ topic, message });
    callback?.(this.failPublish ? new Error("broker gone") : undefined);
    return this;
  }

  end(_force?: boolean, callback?: () => void) {
    callback?.();
    return this;
  }

  deliver(topic: string, body: unknown) {
    this.emit("message", topic, Buffer.from(JSON.stringify(body)));
  }
}

type PutCallback = (
  context: string,
  path: string,
  value: unknown,
  callback: (result: ActionResult) => void,
) => ActionResult;

class FakeApp implements BridgeApp {
  deltas: { updates: Record<string, unknown>[] }[] = [];
  errors: string[] = [];
  puts = new Map<string, PutCallback>();
  debug() {}
  error(msg: string) {
    this.errors.push(msg);
  }
  handleMessage(_id: string, delta: object) {
    this.deltas.push(delta as { updates: Record<string, unknown>[] });
  }
  registerPutHandler(_context: string, path: string, callback: PutCallback) {
    this.puts.set(path, callback);
  }
  values(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const delta of this.deltas) {
      for (const update of delta.updates) {
        for (const v of (update.values ?? []) as {
          path: string;
          value: unknown;
        }[]) {
          out[v.path] = v.value;
        }
      }
    }
    return out;
  }
}

function sensor(name: string, ieee = "0x00124b0029fd1234") {
  return {
    ieee_address: ieee,
    friendly_name: name,
    type: "EndDevice",
    supported: true,
    definition: {
      model: "SNZB-02D",
      vendor: "SONOFF",
      exposes: snzb02d.exposes,
    },
  };
}

const COORDINATOR = {
  ieee_address: "0x0000",
  friendly_name: "Coordinator",
  type: "Coordinator",
};

describe("ZigbeeBridge", () => {
  let app: FakeApp;
  let mqtt: FakeMqtt;
  let bridge: ZigbeeBridge;

  function makeBridge(
    overrides: {
      ieeeAddress: string;
      basePath: string;
      enabled: boolean;
    }[] = [],
  ) {
    bridge = new ZigbeeBridge(app, {
      url: "mqtt://127.0.0.1:1883",
      networks: [{ id: "main", baseTopic: BASE }],
      pathTemplate: "zigbee.{network}.{name}",
      overrides,
      connect: () => mqtt,
    });
    bridge.start();
    mqtt.emit("connect");
  }

  beforeEach(() => {
    app = new FakeApp();
    mqtt = new FakeMqtt();
  });

  it("subscribes to every network's topics", () => {
    makeBridge();
    expect(mqtt.subscribed).toEqual([`${BASE}/#`]);
    expect(bridge.isConnected).toBe(true);
  });

  it("maps device state to Signal K values with meta", () => {
    makeBridge();
    mqtt.deliver(`${BASE}/bridge/devices`, [
      COORDINATOR,
      sensor("Salon Klima"),
    ]);
    mqtt.deliver(`${BASE}/Salon Klima`, {
      battery: 100,
      humidity: 55.2,
      temperature: 21.3,
      linkquality: 120,
    });

    const values = app.values();
    expect(values["zigbee.main.salonKlima.temperature"]).toBeCloseTo(294.45, 6);
    expect(values["zigbee.main.salonKlima.relativeHumidity"]).toBeCloseTo(
      0.552,
      6,
    );
    expect(values["zigbee.main.salonKlima.battery"]).toBe(1);

    const metaUpdate = app.deltas[0]!.updates[0]!;
    expect(metaUpdate.$source).toBe("signalk-zigbee.main");
    expect(metaUpdate.meta).toContainEqual({
      path: "zigbee.main.salonKlima.temperature",
      value: {
        displayName: "Temperature",
        description: "Measured temperature value",
        units: "K",
      },
    });
  });

  it("uses a per-device base path", () => {
    makeBridge([
      {
        ieeeAddress: "0x00124b0029fd1234",
        basePath: "environment.inside.saloon",
        enabled: true,
      },
    ]);
    mqtt.deliver(`${BASE}/bridge/devices`, [sensor("Salon Klima")]);
    mqtt.deliver(`${BASE}/Salon Klima`, { temperature: 20 });
    expect(app.values()).toEqual({
      "environment.inside.saloon.temperature": 293.15,
    });
  });

  it("follows a rename in Zigbee2MQTT", () => {
    makeBridge();
    mqtt.deliver(`${BASE}/bridge/devices`, [sensor("0x00124b0029fd1234")]);
    mqtt.deliver(`${BASE}/bridge/devices`, [sensor("Cockpit")]);
    mqtt.deliver(`${BASE}/0x00124b0029fd1234`, { temperature: 1 });
    mqtt.deliver(`${BASE}/Cockpit`, { temperature: 20 });
    expect(app.values()).toEqual({ "zigbee.main.cockpit.temperature": 293.15 });
    expect(bridge.status()[0]!.devices.map((d) => d.basePath)).toEqual([
      "zigbee.main.cockpit",
    ]);
  });

  it("ignores disabled devices, coordinator and non-state topics", () => {
    makeBridge([
      { ieeeAddress: "0x00124b0029fd1234", basePath: "", enabled: false },
    ]);
    mqtt.deliver(`${BASE}/bridge/devices`, [COORDINATOR, sensor("Salon")]);
    mqtt.deliver(`${BASE}/Salon`, { temperature: 20 });
    mqtt.deliver(`${BASE}/Salon/availability`, { state: "online" });
    mqtt.deliver(`${BASE}/bridge/logging`, { message: "hi" });
    expect(app.values()).toEqual({});
  });

  it("refuses a path two devices would share", () => {
    makeBridge();
    mqtt.deliver(`${BASE}/bridge/devices`, [
      sensor("salon"),
      sensor("Salon", "0x00124b0029fd9999"),
    ]);
    expect(app.errors[0]).toMatch(/claimed by both salon and Salon/);
    expect(bridge.status()[0]!.devices[1]!.paths).toEqual([]);
  });

  it("tracks Zigbee2MQTT's bridge state", () => {
    makeBridge();
    expect(bridge.status()[0]!.online).toBeUndefined();
    mqtt.deliver(`${BASE}/bridge/state`, { state: "online" });
    expect(bridge.status()[0]!.online).toBe(true);
    mqtt.emit("message", `${BASE}/bridge/state`, Buffer.from("offline"));
    expect(bridge.status()[0]!.online).toBe(false);
  });

  describe("PUT", () => {
    beforeEach(() => {
      makeBridge();
      mqtt.deliver(`${BASE}/bridge/devices`, [sensor("Salon")]);
    });

    function put(path: string, value: unknown): Promise<ActionResult> {
      const handler = app.puts.get(path);
      if (handler === undefined) throw new Error(`no PUT handler for ${path}`);
      return new Promise((resolve) => {
        const immediate = handler("vessels.self", path, value, resolve);
        if (immediate.state !== "PENDING") resolve(immediate);
      });
    }

    it("registers handlers for writable values only", () => {
      expect(app.puts.has("zigbee.main.salon.comfortTemperatureMax")).toBe(
        true,
      );
      expect(app.puts.has("zigbee.main.salon.temperature")).toBe(false);
    });

    it("publishes a converted /set request", async () => {
      const result = await put(
        "zigbee.main.salon.comfortTemperatureMax",
        299.15,
      );
      expect(result).toEqual({ state: "COMPLETED", statusCode: 200 });
      expect(mqtt.published).toEqual([
        {
          topic: `${BASE}/Salon/set`,
          message: '{"comfort_temperature_max":26}',
        },
      ]);
    });

    it("rejects invalid values without publishing", async () => {
      const result = await put("zigbee.main.salon.temperatureUnits", "kelvin");
      expect(result.statusCode).toBe(400);
      expect(mqtt.published).toEqual([]);
    });

    it("reports a broker failure", async () => {
      mqtt.failPublish = true;
      const result = await put("zigbee.main.salon.temperatureUnits", "celsius");
      expect(result).toMatchObject({ statusCode: 502, message: "broker gone" });
    });

    it("answers 404 once the device is gone", async () => {
      mqtt.deliver(`${BASE}/bridge/devices`, []);
      const result = await put("zigbee.main.salon.temperatureUnits", "celsius");
      expect(result.statusCode).toBe(404);
    });
  });

  it("opens pairing through the bridge request API", async () => {
    makeBridge();
    await bridge.permitJoin("main", 254);
    expect(mqtt.published).toEqual([
      { topic: `${BASE}/bridge/request/permit_join`, message: '{"time":254}' },
    ]);
    await expect(bridge.permitJoin("nope", 10)).rejects.toThrow(
      /unknown network/,
    );
  });
});
