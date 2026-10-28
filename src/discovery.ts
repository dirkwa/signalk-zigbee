/**
 * Finding espOS Zigbee coordinators.
 *
 * Only mDNS is used. The coordinator accepts exactly one TCP connection and
 * Zigbee2MQTT holds it, so nothing here may ever connect to its port to
 * "check" it — that would knock Zigbee2MQTT off its own network.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { ESPOS_COORDINATOR_PORT, ESPOS_MDNS_SERVICE } from "./config.js";

/** The subset of a bonjour-service `Service` we rely on. */
export interface MdnsService {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
}

export interface Coordinator {
  /** mDNS instance name. */
  name: string;
  host?: string;
  address: string;
  port: number;
  /** espOS device id (TXT `id`), the one stable key. */
  deviceId?: string;
  seenAt: number;
}

interface Browser {
  on(event: string, listener: (service: MdnsService) => void): unknown;
  stop(): void;
}

export interface BonjourLike {
  find(
    options: { type: string; protocol: "tcp" },
    onUp?: (service: MdnsService) => void,
  ): Browser;
  destroy(): void;
}

function txtString(
  txt: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = txt[key];
  if (typeof value === "string" && value !== "") return value;
  // multicast-dns can hand back Buffers for TXT values.
  if (value instanceof Uint8Array && value.length > 0) {
    return Buffer.from(value).toString("utf8");
  }
  return undefined;
}

export function coordinatorFromService(
  service: MdnsService,
  now: number,
): Coordinator | undefined {
  const address = (service.addresses ?? []).find((a) => isIP(a) === 4);
  if (address === undefined) return undefined;
  return {
    name: service.name ?? service.host ?? address,
    host: service.host,
    address,
    port: service.port ?? ESPOS_COORDINATOR_PORT,
    deviceId: txtString(service.txt ?? {}, "id"),
    seenAt: now,
  };
}

function hostLabel(host: string): string {
  return host.toLowerCase().replace(/\.local\.?$/, "");
}

/** Does a configured espOS address name this coordinator? */
export function matchesCoordinator(spec: string, c: Coordinator): boolean {
  const wanted = hostLabel(spec.trim());
  return (
    wanted === c.name.toLowerCase() ||
    wanted === c.deviceId?.toLowerCase() ||
    (c.host !== undefined && wanted === hostLabel(c.host)) ||
    wanted === c.address
  );
}

export class CoordinatorDiscovery {
  private bonjour: BonjourLike | undefined;
  private browser: Browser | undefined;
  private readonly found = new Map<string, Coordinator>();
  /** Bumped by every stop; a start that a stop overtook backs out. */
  private generation = 0;
  /** Shared by concurrent start() callers. */
  private starting: Promise<void> | undefined;

  constructor(
    private readonly onChange: () => void,
    private readonly createBonjour?: () => Promise<BonjourLike>,
  ) {}

  start(): Promise<void> {
    if (this.browser !== undefined) return Promise.resolve();
    if (this.starting === undefined) {
      const starting: Promise<void> = this.open().finally(() => {
        // A stop() and a newer start() may have replaced it meanwhile.
        if (this.starting === starting) this.starting = undefined;
      });
      this.starting = starting;
    }
    return this.starting;
  }

  private async open(): Promise<void> {
    const generation = this.generation;
    const bonjour = this.createBonjour
      ? await this.createBonjour()
      : new (await import("bonjour-service")).Bonjour();
    if (generation !== this.generation) {
      // stop() ran while the import was pending.
      bonjour.destroy();
      return;
    }
    this.bonjour = bonjour as BonjourLike;
    const handle = (service: MdnsService) => {
      const coordinator = coordinatorFromService(service, Date.now());
      if (coordinator === undefined) return;
      const key = coordinator.deviceId ?? coordinator.name;
      const before = this.found.get(key);
      this.found.set(key, coordinator);
      if (
        before?.address !== coordinator.address ||
        before.port !== coordinator.port
      ) {
        this.onChange();
      }
    };
    const browser = this.bonjour.find(
      { type: ESPOS_MDNS_SERVICE, protocol: "tcp" },
      handle,
    );
    // A coordinator that moves to a new DHCP lease re-announces.
    browser.on("srv-update", handle);
    browser.on("txt-update", handle);
    this.browser = browser;
  }

  stop(): void {
    this.generation++;
    this.starting = undefined;
    try {
      this.browser?.stop();
      this.bonjour?.destroy();
    } catch {
      // Nothing left to release.
    }
    this.browser = undefined;
    this.bonjour = undefined;
  }

  list(): Coordinator[] {
    return [...this.found.values()];
  }

  /**
   * `tcp://ip:port` for a configured espOS address, or undefined while it is
   * not known yet. An IPv4 literal is used as-is; a name is matched against
   * mDNS first and then tried in DNS.
   */
  async resolve(spec: string): Promise<string | undefined> {
    const trimmed = spec.trim();
    const [hostPart, portPart] = trimmed.split(/:(?=\d+$)/);
    const port = portPart !== undefined ? Number(portPart) : undefined;
    if (hostPart !== undefined && isIP(hostPart) === 4) {
      return `tcp://${hostPart}:${port ?? ESPOS_COORDINATOR_PORT}`;
    }
    const seen = this.list().find((c) => matchesCoordinator(trimmed, c));
    if (seen !== undefined) return `tcp://${seen.address}:${seen.port}`;
    if (hostPart === undefined || hostPart.endsWith(".local")) return undefined;
    try {
      const { address } = await lookup(hostPart, { family: 4 });
      return `tcp://${address}:${port ?? ESPOS_COORDINATOR_PORT}`;
    } catch {
      return undefined;
    }
  }
}
