/**
 * Plugin settings: schema, defaults and validation.
 *
 * One Zigbee2MQTT instance runs per coordinator, because Zigbee2MQTT drives
 * exactly one coordinator. Several coordinators therefore mean several
 * independent Zigbee networks, each with its own MQTT base topic and
 * frontend port. They are never merged.
 */

export const PLUGIN_ID = "signalk-zigbee";

export const MOSQUITTO_IMAGE = "eclipse-mosquitto";
export const MOSQUITTO_DEFAULT_TAG = "2.0.22";

export const Z2M_OFFICIAL_IMAGE = "ghcr.io/koenkk/zigbee2mqtt";
export const Z2M_OFFICIAL_DEFAULT_TAG = "2.14.2";
/**
 * Zigbee2MQTT patched for ESP32 coordinators reached over TCP: longer
 * timeouts and working coordinator backup/restore. Published as `latest`
 * and `sha-*` tags only.
 */
export const Z2M_ESPOS_IMAGE = "ghcr.io/tostmann/zigbee2mqtt-esp32";
export const Z2M_ESPOS_DEFAULT_TAG = "latest";

/** TCP port an espOS Zigbee coordinator serves the ZBOSS NCP protocol on. */
export const ESPOS_COORDINATOR_PORT = 6638;
/** Adapter driver Zigbee2MQTT uses for an espOS coordinator. */
export const ESPOS_ADAPTER = "zboss";
/**
 * mDNS service type espOS Zigbee coordinators advertise, without the
 * leading underscore and protocol (bonjour-service form).
 */
export const ESPOS_MDNS_SERVICE = "espos-zigbee";

export const ADAPTERS = [
  "ember",
  "zstack",
  "deconz",
  "zigate",
  "zboss",
] as const;
export type Adapter = (typeof ADAPTERS)[number];

export type CoordinatorKind = "usb" | "espos";

export const DEFAULT_BROKER_PORT = 1883;
export const DEFAULT_FRONTEND_PORT = 8099;
export const DEFAULT_CHANNEL = 11;
export const DEFAULT_PATH_TEMPLATE = "zigbee.{network}.{name}";

/** Network ids become container names, topics and path segments. */
const NETWORK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

export interface NetworkConfig {
  id: string;
  enabled: boolean;
  coordinator: CoordinatorKind;
  /** USB: host path of the coordinator, ideally a /dev/serial/by-id link. */
  serialPort: string;
  adapter: Adapter;
  baudrate: number;
  rtscts: boolean;
  /**
   * espOS: an IPv4 address, a hostname, or the mDNS instance name / espOS
   * device id the coordinator advertises.
   */
  esposAddress: string;
  /** Empty means the default image for the coordinator kind. */
  image: string;
  /** Empty means the default tag for the chosen image. */
  imageTag: string;
  /** Only applied when the network is first formed. */
  channel: number;
  frontendPort: number;
}

export interface DeviceOverride {
  ieeeAddress: string;
  /** Replaces the path template for this device. */
  basePath: string;
  enabled: boolean;
}

export interface Settings {
  brokerPort: number;
  mosquittoTag: string;
  pathTemplate: string;
  networks: NetworkConfig[];
  devices: DeviceOverride[];
}

type Raw = Record<string, unknown>;

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : fallback;
}

function int(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function records(value: unknown): Raw[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Raw => typeof entry === "object" && entry !== null,
      )
    : [];
}

function network(raw: Raw, index: number): NetworkConfig {
  const coordinator: CoordinatorKind =
    raw.coordinator === "espos" ? "espos" : "usb";
  const adapter = ADAPTERS.includes(raw.adapter as Adapter)
    ? (raw.adapter as Adapter)
    : "ember";
  return {
    id: str(raw.id, index === 0 ? "main" : `net${index + 1}`),
    enabled: bool(raw.enabled, true),
    coordinator,
    serialPort: str(raw.serialPort, ""),
    adapter: coordinator === "espos" ? ESPOS_ADAPTER : adapter,
    baudrate: int(raw.baudrate, 115200),
    rtscts: bool(raw.rtscts, false),
    esposAddress: str(raw.esposAddress, ""),
    image: str(raw.image, ""),
    imageTag: str(raw.imageTag, ""),
    channel: int(raw.channel, DEFAULT_CHANNEL),
    frontendPort: int(raw.frontendPort, DEFAULT_FRONTEND_PORT + index),
  };
}

/** Signal K does not seed schema defaults into start(); this does. */
export function applyDefaults(raw: Raw): Settings {
  return {
    brokerPort: int(raw.brokerPort, DEFAULT_BROKER_PORT),
    mosquittoTag: str(raw.mosquittoTag, MOSQUITTO_DEFAULT_TAG),
    pathTemplate: str(raw.pathTemplate, DEFAULT_PATH_TEMPLATE),
    networks: records(raw.networks).map(network),
    devices: records(raw.devices)
      .map((entry) => ({
        ieeeAddress: str(entry.ieeeAddress, "").toLowerCase(),
        basePath: str(entry.basePath, ""),
        enabled: bool(entry.enabled, true),
      }))
      .filter((entry) => entry.ieeeAddress !== ""),
  };
}

/** The image and tag a network runs. */
export function z2mImage(net: NetworkConfig): { image: string; tag: string } {
  const image =
    net.image ||
    (net.coordinator === "espos" ? Z2M_ESPOS_IMAGE : Z2M_OFFICIAL_IMAGE);
  const defaultTag =
    image === Z2M_ESPOS_IMAGE
      ? Z2M_ESPOS_DEFAULT_TAG
      : image === Z2M_OFFICIAL_IMAGE
        ? Z2M_OFFICIAL_DEFAULT_TAG
        : "latest";
  return { image, tag: net.imageTag || defaultTag };
}

export function baseTopic(networkId: string): string {
  return `zigbee2mqtt-${networkId}`;
}

/** Problems that make the configuration unusable, one sentence each. */
export function validate(settings: Settings): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const ports = new Map<number, string>([[settings.brokerPort, "the broker"]]);

  for (const net of settings.networks) {
    if (!NETWORK_ID_PATTERN.test(net.id)) {
      problems.push(
        `Network id "${net.id}" must be lowercase letters, digits and dashes.`,
      );
    }
    if (ids.has(net.id)) problems.push(`Network id "${net.id}" is used twice.`);
    ids.add(net.id);

    if (!net.enabled) continue;
    const portOwner = ports.get(net.frontendPort);
    if (portOwner !== undefined) {
      problems.push(
        `Network "${net.id}" uses port ${net.frontendPort}, which ${portOwner} already uses.`,
      );
    }
    ports.set(net.frontendPort, `network "${net.id}"`);

    if (net.coordinator === "usb" && !net.serialPort.startsWith("/dev/")) {
      problems.push(
        `Network "${net.id}" needs the serial port of its USB coordinator.`,
      );
    }
    if (net.coordinator === "espos" && net.esposAddress === "") {
      problems.push(
        `Network "${net.id}" needs the address or mDNS name of its espOS coordinator.`,
      );
    }
  }
  return problems;
}

export const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    networks: {
      type: "array",
      title: "Zigbee networks",
      description:
        "One entry per coordinator. Each coordinator forms its own Zigbee " +
        "network and gets its own Zigbee2MQTT container; devices pair with " +
        "exactly one of them.",
      items: {
        type: "object",
        required: ["id", "coordinator"],
        properties: {
          id: {
            type: "string",
            title: "Network id",
            description:
              "Short name, e.g. main or flybridge. Used in container names, " +
              "MQTT topics and the default Signal K paths.",
            default: "main",
          },
          enabled: { type: "boolean", title: "Enabled", default: true },
          coordinator: {
            type: "string",
            title: "Coordinator",
            enum: ["usb", "espos"],
            enumNames: [
              "USB stick on this host",
              "espOS device on the network",
            ],
            default: "usb",
          },
          serialPort: {
            type: "string",
            title: "Serial port (USB)",
            description:
              "Prefer the /dev/serial/by-id/… link, it survives replugging. " +
              "When Signal K runs in a container the stick must also be " +
              "passed to that container (universal installer: signalk " +
              "hardware rescan).",
          },
          adapter: {
            type: "string",
            title: "Adapter driver (USB)",
            description:
              "ember: Silicon Labs EFR32 (Sonoff ZBDongle-E, SkyConnect). " +
              "zstack: TI CC26xx (Sonoff ZBDongle-P). espOS coordinators " +
              "always use zboss.",
            enum: [...ADAPTERS],
            default: "ember",
          },
          baudrate: {
            type: "integer",
            title: "Baud rate (USB)",
            default: 115200,
          },
          rtscts: {
            type: "boolean",
            title: "Hardware flow control (USB)",
            default: false,
          },
          esposAddress: {
            type: "string",
            title: "espOS coordinator",
            description:
              "IPv4 address, hostname, or the name / device id the " +
              "coordinator advertises over mDNS. The coordinator accepts a " +
              "single connection, which Zigbee2MQTT holds.",
          },
          image: {
            type: "string",
            title: "Zigbee2MQTT image",
            description:
              `Empty: ${Z2M_OFFICIAL_IMAGE} for USB, ${Z2M_ESPOS_IMAGE} for ` +
              "espOS (longer TCP timeouts, coordinator backup and restore).",
            examples: [Z2M_OFFICIAL_IMAGE, Z2M_ESPOS_IMAGE],
          },
          imageTag: {
            type: "string",
            title: "Image tag",
            description: `Empty: ${Z2M_OFFICIAL_DEFAULT_TAG} for the official image, ${Z2M_ESPOS_DEFAULT_TAG} for the espOS image.`,
          },
          channel: {
            type: "integer",
            title: "Zigbee channel",
            description:
              "Used only when the network is formed for the first time.",
            minimum: 11,
            maximum: 26,
            default: DEFAULT_CHANNEL,
          },
          frontendPort: {
            type: "integer",
            title: "Zigbee2MQTT web interface port",
            default: DEFAULT_FRONTEND_PORT,
          },
        },
      },
    },
    pathTemplate: {
      type: "string",
      title: "Signal K path template",
      description:
        "Where a device's values land unless the device has its own base " +
        "path below. Placeholders: {network}, {name} (Zigbee2MQTT friendly " +
        "name, camelCased) and {ieee}.",
      default: DEFAULT_PATH_TEMPLATE,
    },
    devices: {
      type: "array",
      title: "Per-device paths",
      description:
        "Give a device a meaningful place in Signal K, e.g. " +
        "environment.inside.saloon for a climate sensor.",
      items: {
        type: "object",
        required: ["ieeeAddress"],
        properties: {
          ieeeAddress: {
            type: "string",
            title: "IEEE address",
            description: "As shown by Zigbee2MQTT, e.g. 0x00124b0029fd1234.",
          },
          basePath: { type: "string", title: "Base path" },
          enabled: {
            type: "boolean",
            title: "Publish to Signal K",
            default: true,
          },
        },
      },
    },
    brokerPort: {
      type: "integer",
      title: "MQTT broker port",
      description: "Mosquitto listens on 127.0.0.1 only.",
      default: DEFAULT_BROKER_PORT,
    },
    mosquittoTag: {
      type: "string",
      title: "Mosquitto image tag",
      default: MOSQUITTO_DEFAULT_TAG,
    },
  },
} as const;

export const UI_SCHEMA = {
  "ui:order": [
    "networks",
    "pathTemplate",
    "devices",
    "brokerPort",
    "mosquittoTag",
  ],
} as const;
