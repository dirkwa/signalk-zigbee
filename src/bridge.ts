/**
 * MQTT side: follows every Zigbee2MQTT instance on the broker, keeps the
 * device list per network, turns device state into Signal K deltas and
 * Signal K PUTs into Zigbee2MQTT `/set` requests.
 */

import { randomBytes } from "node:crypto";
import mqtt from "mqtt";
import type { ActionResult } from "@signalk/server-api";
import { PLUGIN_ID, type DeviceOverride } from "./config.js";
import {
  deviceMappings,
  devicePath,
  type PathMapping,
  type PathMeta,
  type Z2mDevice,
} from "./exposes.js";

export interface BridgeApp {
  debug(msg: string): void;
  error(msg: string): void;
  handleMessage(id: string, delta: object): void;
  registerPutHandler(
    context: string,
    path: string,
    callback: (
      context: string,
      path: string,
      value: unknown,
      callback: (result: ActionResult) => void,
    ) => ActionResult,
  ): void;
}

/** The slice of an MQTT.js client the bridge uses. */
export interface MqttClientLike {
  on(event: "connect", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(
    event: "message",
    listener: (topic: string, payload: Buffer) => void,
  ): unknown;
  subscribe(
    topic: string | string[],
    callback?: (err?: Error | null) => void,
  ): unknown;
  publish(
    topic: string,
    message: string,
    opts: { qos: 0 | 1 },
    callback?: (err?: Error) => void,
  ): unknown;
  end(force?: boolean, callback?: () => void): unknown;
}

export type MqttConnect = (url: string, opts: object) => MqttClientLike;

export interface BridgeNetwork {
  id: string;
  baseTopic: string;
}

export interface BridgeOptions {
  url: string;
  networks: BridgeNetwork[];
  pathTemplate: string;
  overrides: DeviceOverride[];
  connect?: MqttConnect;
  /** Called whenever the reportable state changes. */
  onChange?: () => void;
  /** How long to wait for Zigbee2MQTT to answer a bridge request. */
  requestTimeoutMs?: number;
}

/** A refused request, with the HTTP status that describes it. */
export class BridgeRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

export interface DeviceStatus {
  ieeeAddress: string;
  friendlyName: string;
  model?: string;
  vendor?: string;
  description?: string;
  basePath: string;
  enabled: boolean;
  paths: { path: string; writable: boolean; units?: string }[];
}

export interface NetworkStatus {
  id: string;
  baseTopic: string;
  /** Zigbee2MQTT's own bridge/state; undefined until it reported once. */
  online: boolean | undefined;
  devices: DeviceStatus[];
}

interface DeviceEntry {
  device: Z2mDevice;
  basePath: string;
  enabled: boolean;
  mappings: PathMapping[];
}

interface NetworkState extends BridgeNetwork {
  online: boolean | undefined;
  /** Keyed by friendly name, which is what state topics carry. */
  devices: Map<string, DeviceEntry>;
  /**
   * Device state that arrived before the device list, by friendly name.
   * Retained messages come in topic order after subscribing, so a sensor's
   * last state can beat bridge/devices.
   */
  earlyState: Map<string, ReportedState>;
  /** Whether the retain/last_seen options were already requested. */
  optionsRequested: boolean;
}

interface ReportedState {
  body: Record<string, unknown>;
  /** When the device reported it, as an ISO timestamp. */
  timestamp: string;
}

interface PathTarget {
  network: NetworkState;
  entry: DeviceEntry;
  mapping: PathMapping;
}

interface PendingRequest {
  resolve(data: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const SELF = "vessels.self";
const RECONNECT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Bounds earlyState against topics that never become devices (groups). */
const MAX_EARLY_STATES = 256;
/** Zigbee2MQTT echoes this field in the matching bridge/response. */
const TRANSACTION_BYTES = 6;
const DEVICE_TOPIC_SUFFIXES = ["/set", "/get", "/availability"];

/**
 * Zigbee2MQTT's last_seen (ISO_8601, ISO_8601_local or epoch ms) when
 * present, so a retained state keeps the time it was really reported.
 */
function reportedAt(body: Record<string, unknown>): string {
  const seen = body.last_seen;
  const ms =
    typeof seen === "number"
      ? seen
      : typeof seen === "string"
        ? Date.parse(seen)
        : Number.NaN;
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function jsonPayload(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return undefined;
  }
}

export class ZigbeeBridge {
  private client: MqttClientLike | undefined;
  private readonly networks = new Map<string, NetworkState>();
  /** Every path currently served, for PUT dispatch and collision checks. */
  private readonly paths = new Map<string, PathTarget>();
  /** Paths a PUT handler was registered for; the server cannot unregister. */
  private readonly putPaths = new Set<string>();
  /** Bridge requests awaiting their response, by transaction id. */
  private readonly pending = new Map<string, PendingRequest>();
  private connected = false;

  constructor(
    private readonly app: BridgeApp,
    private readonly options: BridgeOptions,
  ) {
    for (const net of options.networks) {
      this.networks.set(net.baseTopic, {
        ...net,
        online: undefined,
        devices: new Map(),
        earlyState: new Map(),
        optionsRequested: false,
      });
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    const connect = this.options.connect ?? (mqtt.connect as MqttConnect);
    const client = connect(this.options.url, {
      clientId: `${PLUGIN_ID}-${randomBytes(4).toString("hex")}`,
      reconnectPeriod: RECONNECT_MS,
      clean: true,
    });
    this.client = client;
    client.on("connect", () => {
      this.connected = true;
      const topics = [...this.networks.keys()].map((topic) => `${topic}/#`);
      if (topics.length > 0) {
        client.subscribe(topics, (err) => {
          if (err) this.app.error(`MQTT subscribe failed: ${err.message}`);
        });
      }
      this.app.debug(`MQTT connected to ${this.options.url}`);
      this.options.onChange?.();
    });
    client.on("close", () => {
      if (!this.connected) return;
      this.connected = false;
      this.options.onChange?.();
    });
    client.on("error", (err) => {
      this.app.debug(`MQTT: ${err.message}`);
    });
    client.on("message", (topic, payload) => this.onMessage(topic, payload));
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    for (const [transaction, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error("stopped"));
      this.pending.delete(transaction);
    }
    if (client === undefined) return;
    await new Promise<void>((resolve) => client.end(true, resolve));
  }

  status(): NetworkStatus[] {
    return [...this.networks.values()].map((net) => ({
      id: net.id,
      baseTopic: net.baseTopic,
      online: net.online,
      devices: [...net.devices.values()].map((entry) => ({
        ieeeAddress: entry.device.ieee_address,
        friendlyName: entry.device.friendly_name,
        model: entry.device.definition?.model,
        vendor: entry.device.definition?.vendor,
        description: entry.device.definition?.description,
        basePath: entry.basePath,
        enabled: entry.enabled,
        paths: entry.mappings.map((mapping) => ({
          path: mapping.path,
          writable: mapping.writable,
          units: mapping.meta.units,
        })),
      })),
    }));
  }

  /** Open the network for pairing; 0 closes it again. */
  permitJoin(networkId: string, seconds: number): Promise<void> {
    const net = this.findNetwork(networkId);
    if (net === undefined) {
      return Promise.reject(new Error(`unknown network "${networkId}"`));
    }
    return this.publish(`${net.baseTopic}/bridge/request/permit_join`, {
      time: seconds,
    });
  }

  /**
   * Rename a device in Zigbee2MQTT. With the default path template the
   * Signal K path follows the new name; a configured base path stays.
   * Resolves once Zigbee2MQTT confirmed the rename.
   */
  async renameDevice(
    networkId: string,
    ieeeAddress: string,
    name: string,
  ): Promise<{ friendlyName: string; basePath: string }> {
    const net = this.findNetwork(networkId);
    if (net === undefined) {
      throw new BridgeRequestError(`unknown network "${networkId}"`, 404);
    }
    const ieee = ieeeAddress.toLowerCase();
    const entry = [...net.devices.values()].find(
      (e) => e.device.ieee_address.toLowerCase() === ieee,
    );
    if (entry === undefined) {
      throw new BridgeRequestError(
        `no device ${ieeeAddress} in ${net.id}`,
        404,
      );
    }
    const to = name.trim();
    if (to === "") throw new BridgeRequestError("the name is empty", 400);

    const { basePath } = this.basePathFor(net, {
      ...entry.device,
      friendly_name: to,
    });
    if (to === entry.device.friendly_name)
      return { friendlyName: to, basePath };
    for (const other of this.networks.values()) {
      for (const e of other.devices.values()) {
        if (e !== entry && e.enabled && e.basePath === basePath) {
          throw new BridgeRequestError(
            `${basePath} is already used by ${e.device.friendly_name}`,
            409,
          );
        }
      }
    }

    await this.request(net, "device/rename", {
      from: entry.device.ieee_address,
      to,
    });
    return { friendlyName: to, basePath };
  }

  private findNetwork(networkId: string): NetworkState | undefined {
    return [...this.networks.values()].find((n) => n.id === networkId);
  }

  /** A bridge request whose bridge/response decides the outcome. */
  private request(
    net: NetworkState,
    name: string,
    body: object,
  ): Promise<unknown> {
    const transaction = randomBytes(TRANSACTION_BYTES).toString("hex");
    const timeoutMs = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(transaction);
        reject(
          new BridgeRequestError(`Zigbee2MQTT did not answer ${name}`, 504),
        );
      }, timeoutMs);
      this.pending.set(transaction, { resolve, reject, timer });
      this.publish(`${net.baseTopic}/bridge/request/${name}`, {
        ...body,
        transaction,
      }).catch((err: Error) => {
        clearTimeout(timer);
        this.pending.delete(transaction);
        reject(err);
      });
    });
  }

  private onResponse(payload: Buffer): void {
    const body = jsonPayload(payload) as
      | {
          status?: unknown;
          data?: unknown;
          error?: unknown;
          transaction?: unknown;
        }
      | undefined;
    if (typeof body !== "object" || body === null) return;
    if (typeof body.transaction !== "string") return;
    const request = this.pending.get(body.transaction);
    if (request === undefined) return;
    this.pending.delete(body.transaction);
    clearTimeout(request.timer);
    if (body.status === "ok") {
      request.resolve(body.data);
    } else {
      const message =
        typeof body.error === "string" ? body.error : "request failed";
      request.reject(new BridgeRequestError(message, 400));
    }
  }

  private publish(topic: string, body: object): Promise<void> {
    const client = this.client;
    if (client === undefined || !this.connected) {
      return Promise.reject(new Error("MQTT broker not connected"));
    }
    return new Promise((resolve, reject) => {
      client.publish(topic, JSON.stringify(body), { qos: 1 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  private onMessage(topic: string, payload: Buffer): void {
    const slash = topic.indexOf("/");
    if (slash < 0) return;
    const net = this.networks.get(topic.slice(0, slash));
    if (net === undefined) return;
    const rest = topic.slice(slash + 1);

    if (rest === "bridge/state") {
      const body = jsonPayload(payload);
      const state =
        typeof body === "object" && body !== null
          ? (body as { state?: unknown }).state
          : payload.toString("utf8");
      net.online = state === "online";
      this.options.onChange?.();
      return;
    }
    if (rest === "bridge/devices") {
      const body = jsonPayload(payload);
      if (Array.isArray(body)) this.updateDevices(net, body as Z2mDevice[]);
      return;
    }
    if (rest === "bridge/info") {
      this.ensureOptions(net, jsonPayload(payload));
      return;
    }
    if (rest.startsWith("bridge/response/")) {
      this.onResponse(payload);
      return;
    }
    if (rest.startsWith("bridge/")) return;
    if (DEVICE_TOPIC_SUFFIXES.some((suffix) => rest.endsWith(suffix))) return;

    const body = jsonPayload(payload);
    if (typeof body !== "object" || body === null) {
      // An empty retained message clears the topic, e.g. after a rename.
      net.earlyState.delete(rest);
      return;
    }
    const state: ReportedState = {
      body: body as Record<string, unknown>,
      timestamp: reportedAt(body as Record<string, unknown>),
    };
    const entry = net.devices.get(rest);
    if (entry === undefined) {
      net.earlyState.delete(rest);
      if (net.earlyState.size >= MAX_EARLY_STATES) {
        const oldest = net.earlyState.keys().next().value;
        if (oldest !== undefined) net.earlyState.delete(oldest);
      }
      net.earlyState.set(rest, state);
      return;
    }
    if (entry.enabled) this.emitState(net, entry, state);
  }

  /**
   * Zigbee2MQTT does not retain device state by default, so after a
   * Signal K restart a sensor's paths would stay empty until it reports
   * again, which can take an hour. Retained state plus last_seen gives the
   * last values back right away, with the time they were reported.
   */
  private ensureOptions(net: NetworkState, info: unknown): void {
    if (net.optionsRequested) return;
    const config = (
      info as
        | {
            config?: {
              device_options?: { retain?: unknown };
              advanced?: { last_seen?: unknown };
            };
          }
        | undefined
    )?.config;
    if (typeof config !== "object" || config === null) return;
    const options: Record<string, unknown> = {};
    if (config.device_options?.retain !== true) {
      options.device_options = { retain: true };
    }
    const lastSeen = config.advanced?.last_seen;
    if (typeof lastSeen !== "string" || lastSeen === "disable") {
      options.advanced = { last_seen: "ISO_8601" };
    }
    if (Object.keys(options).length === 0) return;
    net.optionsRequested = true;
    this.request(net, "options", { options }).then(
      () =>
        this.app.debug(
          `${net.id}: Zigbee2MQTT now retains device state with last_seen`,
        ),
      (err: Error) => {
        // Let the next bridge/info try again. It is retained, so an MQTT
        // reconnect or a Zigbee2MQTT restart delivers one.
        net.optionsRequested = false;
        if (this.client === undefined) return;
        this.app.error(
          `${net.id}: could not enable retained device state: ${err.message}`,
        );
      },
    );
  }

  private basePathFor(
    net: NetworkState,
    device: Pick<Z2mDevice, "friendly_name" | "ieee_address">,
  ): {
    basePath: string;
    enabled: boolean;
  } {
    const ieee = device.ieee_address.toLowerCase();
    const override = this.options.overrides.find((o) => o.ieeeAddress === ieee);
    return {
      basePath:
        override?.basePath ||
        devicePath(this.options.pathTemplate, net.id, device),
      enabled: override?.enabled ?? true,
    };
  }

  private updateDevices(net: NetworkState, devices: Z2mDevice[]): void {
    for (const [path, target] of this.paths) {
      if (target.network === net) this.paths.delete(path);
    }
    net.devices.clear();

    const meta: { path: string; value: PathMeta }[] = [];
    for (const device of devices) {
      if (device.type === "Coordinator" || device.disabled) continue;
      if (!device.definition) continue;
      const { basePath, enabled } = this.basePathFor(net, device);
      const entry: DeviceEntry = { device, basePath, enabled, mappings: [] };
      net.devices.set(device.friendly_name, entry);
      if (!enabled) continue;

      for (const mapping of deviceMappings(device, basePath)) {
        const owner = this.paths.get(mapping.path);
        if (owner !== undefined) {
          this.app.error(
            `${mapping.path} is claimed by both ${owner.entry.device.friendly_name} ` +
              `and ${device.friendly_name}; give one of them its own base path`,
          );
          continue;
        }
        entry.mappings.push(mapping);
        this.paths.set(mapping.path, { network: net, entry, mapping });
        meta.push({ path: mapping.path, value: mapping.meta });
        if (mapping.writable) this.ensurePutHandler(mapping.path);
      }
      this.app.debug(
        `${net.id}: ${device.friendly_name} (${device.ieee_address}) → ` +
          `${basePath}, ${entry.mappings.length} paths`,
      );
    }

    if (meta.length > 0) {
      this.app.handleMessage(PLUGIN_ID, {
        updates: [{ $source: this.source(net), meta }],
      });
    }
    for (const [name, entry] of net.devices) {
      const state = net.earlyState.get(name);
      if (state === undefined) continue;
      net.earlyState.delete(name);
      if (entry.enabled) this.emitState(net, entry, state);
    }
    this.options.onChange?.();
  }

  private emitState(
    net: NetworkState,
    entry: DeviceEntry,
    state: ReportedState,
  ): void {
    const values: { path: string; value: unknown }[] = [];
    for (const mapping of entry.mappings) {
      if (!(mapping.property in state.body)) continue;
      const value = mapping.toSk(state.body[mapping.property]);
      if (value !== undefined) values.push({ path: mapping.path, value });
    }
    if (values.length === 0) return;
    this.app.handleMessage(PLUGIN_ID, {
      updates: [
        { $source: this.source(net), timestamp: state.timestamp, values },
      ],
    });
  }

  private source(net: NetworkState): string {
    return `${PLUGIN_ID}.${net.id}`;
  }

  private ensurePutHandler(path: string): void {
    if (this.putPaths.has(path)) return;
    this.putPaths.add(path);
    this.app.registerPutHandler(SELF, path, (_context, putPath, value, done) =>
      this.handlePut(putPath, value, done),
    );
  }

  private handlePut(
    path: string,
    value: unknown,
    done: (result: ActionResult) => void,
  ): ActionResult {
    const target = this.paths.get(path);
    if (target === undefined || !target.mapping.writable) {
      return {
        state: "COMPLETED",
        statusCode: 404,
        message: `${path} is not a writable Zigbee value right now`,
      };
    }
    let converted: unknown;
    try {
      converted = target.mapping.fromSk(value);
    } catch (err) {
      return {
        state: "COMPLETED",
        statusCode: 400,
        message: `${path}: ${(err as Error).message}`,
      };
    }
    const topic = `${target.network.baseTopic}/${target.entry.device.friendly_name}/set`;
    this.publish(topic, { [target.mapping.property]: converted }).then(
      () => done({ state: "COMPLETED", statusCode: 200 }),
      (err: Error) =>
        done({ state: "COMPLETED", statusCode: 502, message: err.message }),
    );
    return { state: "PENDING" };
  }
}
