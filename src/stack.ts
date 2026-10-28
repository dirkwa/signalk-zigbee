/**
 * Container and file definitions for Mosquitto and the Zigbee2MQTT
 * instances. Pure builders plus the two file writers, so the shape of what
 * gets started is unit-testable.
 *
 * Both containers use host networking: Zigbee2MQTT reaches the broker on
 * 127.0.0.1, Signal K (bare metal or the universal installer's host-network
 * container) reaches both the same way, and the Zigbee2MQTT web interface
 * is directly reachable on the LAN for pairing.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerConfig } from "signalk-container-helper";
import {
  baseTopic,
  MOSQUITTO_IMAGE,
  type NetworkConfig,
  type Settings,
} from "./config.js";

export const MOSQUITTO_CONTAINER = "zigbee-mosquitto";
/**
 * The Mosquitto image declares VOLUMEs at these paths. Left alone, the
 * runtime attaches anonymous volumes there, which signalk-container counts
 * as volume drift and recreates the broker on every start. Binding the
 * plugin's data directory over both keeps the live mounts equal to the
 * requested ones.
 */
export const MOSQUITTO_DATA_MOUNT = "/mosquitto/data";
const MOSQUITTO_LOG_MOUNT = "/mosquitto/log";
/**
 * The image's `mosquitto` user. Running as it, rather than as root, matters
 * because the image entrypoint runs `chown -R mosquitto /mosquitto` when
 * started as root, which would hand the whole bind-mounted data directory
 * (Zigbee network keys included) to an unmapped uid.
 */
const MOSQUITTO_UID = 1883;
export const Z2M_CONTAINER_PREFIX = "zigbee2mqtt-";
/** Where a USB coordinator appears inside its Zigbee2MQTT container. */
export const COORDINATOR_DEVICE = "/dev/zigbee";

const FRONTEND_TOKEN_FILE = "frontend-token";
const FRONTEND_TOKEN_BYTES = 16;

const MOSQUITTO_MEMORY = "128m";
const Z2M_MEMORY = "512m";

export function z2mContainerName(networkId: string): string {
  return `${Z2M_CONTAINER_PREFIX}${networkId}`;
}

export function mqttServer(settings: Settings): string {
  return `mqtt://127.0.0.1:${settings.brokerPort}`;
}

/**
 * Loopback only and anonymous: the broker exists for Zigbee2MQTT and this
 * plugin. Persistence keeps Zigbee2MQTT's retained device list across a
 * broker restart.
 */
export function mosquittoConf(port: number, dataDir: string): string {
  return [
    `listener ${port} 127.0.0.1`,
    "allow_anonymous true",
    "persistence true",
    `persistence_location ${dataDir}/`,
    "log_dest stdout",
    "",
  ].join("\n");
}

export function mosquittoContainer(
  settings: Settings,
  tag: string,
  mount: { source: string; containerPath: string },
): ContainerConfig {
  const dir = `${mount.containerPath}/mosquitto`;
  return {
    image: MOSQUITTO_IMAGE,
    tag,
    networkMode: "host",
    volumes: {
      [MOSQUITTO_DATA_MOUNT]: mount.source,
      [MOSQUITTO_LOG_MOUNT]: mount.source,
    },
    command: ["mosquitto", "-c", `${dir}/mosquitto.conf`],
    // signalk-container maps this uid to the Signal K user, so files the
    // broker writes stay owned by that user on the host.
    user: { inImageUid: MOSQUITTO_UID, inImageGid: MOSQUITTO_UID },
    resources: { memory: MOSQUITTO_MEMORY },
  };
}

/**
 * Written once, when the network directory is new. Zigbee2MQTT rewrites
 * this file itself (generated keys, device names), so it must never be
 * overwritten; everything the plugin controls is passed as environment
 * overrides instead.
 */
export function initialZ2mConfig(net: NetworkConfig): string {
  return [
    "version: 5",
    "homeassistant:",
    "  enabled: false",
    "frontend:",
    "  enabled: true",
    "advanced:",
    `  channel: ${net.channel}`,
    "  network_key: GENERATE",
    "  pan_id: GENERATE",
    "  ext_pan_id: GENERATE",
    "",
  ].join("\n");
}

export function z2mEnv(
  net: NetworkConfig,
  settings: Settings,
  dataDir: string,
  serialPort: string,
  frontendToken: string,
): Record<string, string> {
  const env: Record<string, string> = {
    ZIGBEE2MQTT_DATA: dataDir,
    ZIGBEE2MQTT_CONFIG_MQTT_SERVER: mqttServer(settings),
    ZIGBEE2MQTT_CONFIG_MQTT_BASE_TOPIC: baseTopic(net.id),
    ZIGBEE2MQTT_CONFIG_SERIAL_PORT: serialPort,
    ZIGBEE2MQTT_CONFIG_SERIAL_ADAPTER: net.adapter,
    ZIGBEE2MQTT_CONFIG_FRONTEND_ENABLED: "true",
    ZIGBEE2MQTT_CONFIG_FRONTEND_AUTH_TOKEN: frontendToken,
    ZIGBEE2MQTT_CONFIG_FRONTEND_PORT: String(net.frontendPort),
    ZIGBEE2MQTT_CONFIG_HOMEASSISTANT_ENABLED: "false",
  };
  if (net.coordinator === "usb") {
    env.ZIGBEE2MQTT_CONFIG_SERIAL_BAUDRATE = String(net.baudrate);
    env.ZIGBEE2MQTT_CONFIG_SERIAL_RTSCTS = String(net.rtscts);
  }
  return env;
}

/**
 * Why a USB coordinator cannot be handed to Zigbee2MQTT, or undefined.
 *
 * signalk-container checks a device from inside Signal K's own process and
 * drops one it cannot see, so a containerized Signal K needs the stick
 * passed in too; otherwise Zigbee2MQTT would start without its coordinator.
 * `onHost` is the host-side probe (undefined when it could not run).
 */
export function usbCoordinatorProblem(
  serialPort: string,
  onHost: boolean | undefined,
  visibleToSignalK: boolean,
): string | undefined {
  if (onHost === false) {
    return `${serialPort} is not plugged in; plug it in and restart the plugin`;
  }
  if (visibleToSignalK) return undefined;
  const what =
    onHost === true
      ? `${serialPort} is plugged in, but the Signal K container cannot see it`
      : `${serialPort} is not visible to Signal K (unplugged, or not passed to its container)`;
  return (
    `${what}. With the universal installer, run "signalk hardware rescan" ` +
    "(it restarts Signal K); otherwise pass the device to the Signal K container."
  );
}

export interface CoordinatorAccess {
  /** What Zigbee2MQTT opens: /dev/zigbee or tcp://ip:port. */
  serialPort: string;
  devices?: string[];
  groupAdd?: string[];
}

export function z2mContainer(
  net: NetworkConfig,
  settings: Settings,
  image: string,
  tag: string,
  mount: { source: string; containerPath: string },
  access: CoordinatorAccess,
  frontendToken: string,
): ContainerConfig {
  const config: ContainerConfig = {
    image,
    tag,
    networkMode: "host",
    volumes: { "/data": mount.source },
    env: z2mEnv(
      net,
      settings,
      `${mount.containerPath}/networks/${net.id}`,
      access.serialPort,
      frontendToken,
    ),
    resources: { memory: Z2M_MEMORY },
  };
  if (access.devices) config.devices = access.devices;
  if (access.groupAdd) config.groupAdd = access.groupAdd;
  return config;
}

/** The plugin owns mosquitto.conf; it is rewritten on every start. */
export async function writeMosquittoFiles(
  hostDataDir: string,
  settings: Settings,
  containerDataDir: string,
): Promise<void> {
  const dir = join(hostDataDir, "mosquitto");
  await mkdir(join(dir, "data"), { recursive: true });
  await writeFile(
    join(dir, "mosquitto.conf"),
    mosquittoConf(settings.brokerPort, `${containerDataDir}/mosquitto/data`),
  );
}

/**
 * Seeds a new network directory and returns its web interface token.
 *
 * Host networking puts the Zigbee2MQTT interface on the LAN, where it would
 * give anyone full control of the Zigbee network; the token closes that.
 * It is generated once per network and kept next to Zigbee2MQTT's data.
 */
export async function ensureZ2mFiles(
  hostDataDir: string,
  net: NetworkConfig,
): Promise<{ frontendToken: string }> {
  const dir = join(hostDataDir, "networks", net.id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "configuration.yaml");
  if (!existsSync(file)) await writeFile(file, initialZ2mConfig(net));

  const tokenFile = join(dir, FRONTEND_TOKEN_FILE);
  if (existsSync(tokenFile)) {
    const stored = (await readFile(tokenFile, "utf8")).trim();
    if (stored !== "") return { frontendToken: stored };
  }
  const frontendToken = randomBytes(FRONTEND_TOKEN_BYTES).toString("hex");
  await writeFile(tokenFile, `${frontendToken}\n`, { mode: 0o600 });
  return { frontendToken };
}
