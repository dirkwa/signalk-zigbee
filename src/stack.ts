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

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerConfig } from "signalk-container-helper";
import {
  baseTopic,
  MOSQUITTO_IMAGE,
  type NetworkConfig,
  type Settings,
} from "./config.js";

export const MOSQUITTO_CONTAINER = "zigbee-mosquitto";
export const Z2M_CONTAINER_PREFIX = "zigbee2mqtt-";
/** Where a USB coordinator appears inside its Zigbee2MQTT container. */
export const COORDINATOR_DEVICE = "/dev/zigbee";

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
 * broker restart. `user root` stops Mosquitto from dropping to its image
 * user, which could not write the bind-mounted data directory.
 */
export function mosquittoConf(port: number, dataDir: string): string {
  return [
    `listener ${port} 127.0.0.1`,
    "allow_anonymous true",
    "user root",
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
    volumes: { "/data": mount.source },
    command: ["mosquitto", "-c", `${dir}/mosquitto.conf`],
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
): Record<string, string> {
  const env: Record<string, string> = {
    ZIGBEE2MQTT_DATA: dataDir,
    ZIGBEE2MQTT_CONFIG_MQTT_SERVER: mqttServer(settings),
    ZIGBEE2MQTT_CONFIG_MQTT_BASE_TOPIC: baseTopic(net.id),
    ZIGBEE2MQTT_CONFIG_SERIAL_PORT: serialPort,
    ZIGBEE2MQTT_CONFIG_SERIAL_ADAPTER: net.adapter,
    ZIGBEE2MQTT_CONFIG_FRONTEND_ENABLED: "true",
    ZIGBEE2MQTT_CONFIG_FRONTEND_PORT: String(net.frontendPort),
    ZIGBEE2MQTT_CONFIG_HOMEASSISTANT_ENABLED: "false",
  };
  if (net.coordinator === "usb") {
    env.ZIGBEE2MQTT_CONFIG_SERIAL_BAUDRATE = String(net.baudrate);
    env.ZIGBEE2MQTT_CONFIG_SERIAL_RTSCTS = String(net.rtscts);
  }
  return env;
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

export async function ensureZ2mFiles(
  hostDataDir: string,
  net: NetworkConfig,
): Promise<void> {
  const dir = join(hostDataDir, "networks", net.id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "configuration.yaml");
  if (!existsSync(file)) await writeFile(file, initialZ2mConfig(net));
}
