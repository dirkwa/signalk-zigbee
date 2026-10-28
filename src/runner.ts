/**
 * Lifecycle: one Mosquitto broker, one Zigbee2MQTT container per enabled
 * network, the MQTT bridge, and mDNS discovery when an espOS coordinator is
 * configured.
 */

import { existsSync } from "node:fs";
import type { ServerAPI } from "@signalk/server-api";
import {
  errMsg,
  ManagedContainer,
  probeHostDevice,
  resolveMount,
  startSafely,
  waitForContainerManager,
  type ContainerManagerApi,
  type HostMount,
  type StopOptions,
} from "signalk-container-helper";
import { ZigbeeBridge, type NetworkStatus } from "./bridge.js";
import {
  baseTopic,
  MOSQUITTO_IMAGE,
  PLUGIN_ID,
  validate,
  z2mImage,
  type NetworkConfig,
  type Settings,
} from "./config.js";
import { CoordinatorDiscovery, type Coordinator } from "./discovery.js";
import {
  COORDINATOR_DEVICE,
  ensureZ2mFiles,
  mosquittoContainer,
  MOSQUITTO_CONTAINER,
  MOSQUITTO_DATA_MOUNT,
  mqttServer,
  writeMosquittoFiles,
  z2mContainer,
  z2mContainerName,
  Z2M_CONTAINER_PREFIX,
  usbCoordinatorProblem,
  type CoordinatorAccess,
} from "./stack.js";

/** Group owning USB serial nodes on Debian-family hosts. */
const SERIAL_GROUP = "dialout";
const MANAGER_TIMEOUT_MS = 120_000;

export type NetworkPhase =
  "starting" | "running" | "waiting" | "error" | "disabled";

interface NetworkRun {
  net: NetworkConfig;
  phase: NetworkPhase;
  message?: string;
  container?: ManagedContainer;
  /** The coordinator address the running container was started with. */
  serialPort?: string;
  /** Token for the Zigbee2MQTT web interface. */
  frontendToken?: string;
}

export interface NetworkReport {
  id: string;
  coordinator: NetworkConfig["coordinator"];
  phase: NetworkPhase;
  message?: string;
  image: string;
  frontendPort: number;
  baseTopic: string;
  coordinatorAddress?: string;
  online?: boolean;
  devices: NetworkStatus["devices"];
}

export interface StatusReport {
  running: boolean;
  problems: string[];
  brokerConnected: boolean;
  networks: NetworkReport[];
  /** espOS coordinators seen on mDNS that no network uses yet. */
  discovered: Coordinator[];
}

export class ZigbeeRunner {
  private settings: Settings | undefined;
  private problems: string[] = [];
  private abort: AbortController | undefined;
  private manager: ContainerManagerApi | undefined;
  private mount: HostMount | undefined;
  private broker: ManagedContainer | undefined;
  private bridge: ZigbeeBridge | undefined;
  private discovery: CoordinatorDiscovery | undefined;
  private runs = new Map<string, NetworkRun>();
  /** Serializes espOS (re)starts triggered by discovery. */
  private esposChain: Promise<void> = Promise.resolve();
  private running = false;

  constructor(private readonly app: ServerAPI) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(settings: Settings): void {
    this.running = true;
    this.settings = settings;
    this.runs = new Map(
      settings.networks.map((net) => [
        net.id,
        { net, phase: net.enabled ? "starting" : "disabled" },
      ]),
    );
    this.problems = validate(settings);
    if (this.problems.length > 0) {
      this.app.setPluginError(this.problems.join(" "));
      this.app.debug(`not starting: ${this.problems.join(" ")}`);
      return;
    }
    if (settings.networks.every((net) => !net.enabled)) {
      this.progress("No Zigbee network configured yet");
    }
    const abort = new AbortController();
    this.abort = abort;
    // A previous run's queued reconciles bail out on their aborted signal;
    // this run must not wait behind them.
    this.esposChain = Promise.resolve();
    startSafely(this.app, () =>
      this.bringUp(settings, abort.signal).catch((err: unknown) => {
        // startSafely only sets the status line, which needs an admin login
        // to read; keep a trace in the server log as well.
        if (!abort.signal.aborted) {
          this.app.error(`start-up failed: ${errMsg(err)}`);
        }
        throw err;
      }),
    );
  }

  async stop(options?: StopOptions): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.abort = undefined;
    this.discovery?.stop();
    this.discovery = undefined;
    await this.bridge?.stop();
    this.bridge = undefined;
    for (const run of this.runs.values()) {
      await run.container?.stop(options);
    }
    await this.broker?.stop(options);
    this.broker = undefined;
  }

  status(): StatusReport {
    const bridgeStatus = new Map(
      (this.bridge?.status() ?? []).map((s) => [s.id, s]),
    );
    const used = [...this.runs.values()]
      .map((run) => run.serialPort)
      .filter((port): port is string => port !== undefined);
    return {
      running: this.running,
      problems: this.problems,
      brokerConnected: this.bridge?.isConnected ?? false,
      networks: [...this.runs.values()].map((run) => {
        const live = bridgeStatus.get(run.net.id);
        return {
          id: run.net.id,
          coordinator: run.net.coordinator,
          phase: run.phase,
          message: run.message,
          image: `${z2mImage(run.net).image}:${z2mImage(run.net).tag}`,
          frontendPort: run.net.frontendPort,
          baseTopic: baseTopic(run.net.id),
          coordinatorAddress: run.serialPort,
          online: live?.online,
          devices: live?.devices ?? [],
        };
      }),
      discovered: (this.discovery?.list() ?? []).filter(
        (c) => !used.includes(`tcp://${c.address}:${c.port}`),
      ),
    };
  }

  permitJoin(networkId: string, seconds: number): Promise<void> {
    if (this.bridge === undefined) {
      return Promise.reject(new Error("not started"));
    }
    return this.bridge.permitJoin(networkId, seconds);
  }

  renameDevice(
    networkId: string,
    ieeeAddress: string,
    name: string,
  ): Promise<{ friendlyName: string; basePath: string }> {
    if (this.bridge === undefined) {
      return Promise.reject(new Error("not started"));
    }
    return this.bridge.renameDevice(networkId, ieeeAddress, name);
  }

  /** Web interface tokens of the networks started so far, by network id. */
  frontendTokens(): Record<string, string> {
    const tokens: Record<string, string> = {};
    for (const run of this.runs.values()) {
      if (run.frontendToken !== undefined)
        tokens[run.net.id] = run.frontendToken;
    }
    return tokens;
  }

  private async bringUp(
    settings: Settings,
    signal: AbortSignal,
  ): Promise<void> {
    const { manager, runtime } = await waitForContainerManager({
      timeoutMs: MANAGER_TIMEOUT_MS,
      signal,
      onWaiting: (phase) =>
        this.progress(
          phase === "manager"
            ? "Waiting for signalk-container"
            : "Waiting for the container runtime",
        ),
    });
    if (signal.aborted) return;
    if (manager === undefined) {
      throw new Error("signalk-container is not installed or not enabled");
    }
    if (runtime === null) {
      throw new Error("signalk-container found no podman or docker");
    }
    this.manager = manager;

    this.progress("Preparing the data directory");
    const hostDir = this.app.getDataDirPath();
    const mount = await resolveMount(manager, {
      containerPath: "/data",
      hostPath: hostDir,
    });
    this.mount = mount;
    const brokerMount = await resolveMount(manager, {
      containerPath: MOSQUITTO_DATA_MOUNT,
      hostPath: hostDir,
    });
    await writeMosquittoFiles(hostDir, settings, brokerMount.containerPath);

    this.progress("Starting the MQTT broker");
    this.broker = new ManagedContainer({
      app: this.app,
      pluginId: PLUGIN_ID,
      name: MOSQUITTO_CONTAINER,
      image: MOSQUITTO_IMAGE,
      defaultTag: settings.mosquittoTag,
      buildConfig: (tag) => mosquittoContainer(settings, tag, brokerMount),
      quiet: true,
    });
    await this.broker.start(settings.mosquittoTag, { signal });
    if (signal.aborted) return;

    this.bridge = new ZigbeeBridge(this.app, {
      url: mqttServer(settings),
      networks: settings.networks
        .filter((net) => net.enabled)
        .map((net) => ({ id: net.id, baseTopic: baseTopic(net.id) })),
      pathTemplate: settings.pathTemplate,
      overrides: settings.devices,
      onChange: () => this.report(),
    });
    this.bridge.start();

    await this.stopOrphans(manager, settings);
    if (signal.aborted) return;

    const enabled = settings.networks.filter((net) => net.enabled);
    if (enabled.some((net) => net.coordinator === "espos")) {
      const discovery = new CoordinatorDiscovery(() =>
        this.onDiscoveryChange(),
      );
      this.discovery = discovery;
      await discovery.start();
      if (signal.aborted) {
        // stop() may have run before this instance existed; release it
        // here, and leave a newer run's discovery alone.
        discovery.stop();
        if (this.discovery === discovery) this.discovery = undefined;
        return;
      }
    }

    for (const net of enabled.filter((n) => n.coordinator === "usb")) {
      await this.startUsbNetwork(net, signal);
    }
    // Coordinators mDNS has not announced yet wait in "waiting"; their
    // announcement triggers onDiscoveryChange, which starts them. Queued
    // behind any reconcile an announcement started during the USB start-up,
    // so no espOS network is started twice.
    const reconcile = this.esposChain.then(() => this.reconcileEspos(signal));
    this.esposChain = reconcile.catch(() => undefined);
    await reconcile;
    this.report();
  }

  /** Zigbee2MQTT containers for networks that were removed or disabled. */
  private async stopOrphans(
    manager: ContainerManagerApi,
    settings: Settings,
  ): Promise<void> {
    const wanted = new Set(
      settings.networks
        .filter((net) => net.enabled)
        .map((net) => z2mContainerName(net.id)),
    );
    let containers;
    try {
      containers = await manager.listContainers();
    } catch (err) {
      this.app.debug(`listing containers failed: ${errMsg(err)}`);
      return;
    }
    for (const info of containers) {
      const name = info.unprefixedName;
      if (name === undefined || !name.startsWith(Z2M_CONTAINER_PREFIX))
        continue;
      if (wanted.has(name) || info.state !== "running") continue;
      this.app.debug(`stopping ${name}: its network is no longer configured`);
      await manager.stop(name).catch((err: unknown) => {
        this.app.error(`could not stop ${name}: ${errMsg(err)}`);
      });
    }
  }

  private async startUsbNetwork(
    net: NetworkConfig,
    signal: AbortSignal,
  ): Promise<void> {
    let groups = [SERIAL_GROUP];
    let onHost: boolean | undefined;
    try {
      const probe = await probeHostDevice(this.manager!, net.serialPort);
      onHost = probe?.exists;
      if (probe?.groups.length) groups = probe.groups;
    } catch (err) {
      // The probe only refines the group; without it the usual group is
      // tried (older signalk-container, or the host could not be read).
      this.app.debug(`probing ${net.serialPort} failed: ${errMsg(err)}`);
    }
    if (signal.aborted) return;
    const problem = usbCoordinatorProblem(
      net.serialPort,
      onHost,
      existsSync(net.serialPort),
    );
    if (problem !== undefined) {
      this.app.error(`${net.id}: ${problem}`);
      this.setPhase(net.id, "error", problem);
      return;
    }
    await this.startNetwork(
      net,
      {
        serialPort: COORDINATOR_DEVICE,
        devices: [`${net.serialPort}:${COORDINATOR_DEVICE}`],
        groupAdd: groups,
      },
      signal,
    );
  }

  private onDiscoveryChange(): void {
    const signal = this.abort?.signal;
    if (signal === undefined || signal.aborted) return;
    this.esposChain = this.esposChain
      .then(() => this.reconcileEspos(signal))
      .catch((err: unknown) => this.app.error(errMsg(err)));
    this.report();
  }

  /**
   * Start every espOS network whose coordinator address is known, and
   * restart one whose coordinator moved to a new address.
   */
  private async reconcileEspos(signal: AbortSignal): Promise<void> {
    if (this.manager === undefined || this.mount === undefined) return;
    for (const run of this.runs.values()) {
      if (signal.aborted) return;
      if (!run.net.enabled || run.net.coordinator !== "espos") continue;
      const address = await this.discovery?.resolve(run.net.esposAddress);
      // The lookup can outlive a restart; a newer run owns the phases now.
      if (signal.aborted) return;
      if (address === undefined) {
        if (run.serialPort === undefined) {
          this.setPhase(
            run.net.id,
            "waiting",
            `waiting for espOS coordinator "${run.net.esposAddress}" on mDNS`,
          );
        }
        continue;
      }
      if (address === run.serialPort && run.phase === "running") continue;
      await this.startNetwork(run.net, { serialPort: address }, signal);
    }
  }

  private async startNetwork(
    net: NetworkConfig,
    access: CoordinatorAccess,
    signal: AbortSignal,
  ): Promise<void> {
    const run = this.runs.get(net.id);
    if (
      run === undefined ||
      this.mount === undefined ||
      this.settings === undefined
    ) {
      return;
    }
    const settings = this.settings;
    const mount = this.mount;
    const { image, tag } = z2mImage(net);
    this.setPhase(net.id, "starting", `starting Zigbee2MQTT (${image}:${tag})`);
    try {
      const { frontendToken } = await ensureZ2mFiles(
        this.app.getDataDirPath(),
        net,
      );
      run.frontendToken = frontendToken;
      run.container ??= new ManagedContainer({
        app: this.app,
        pluginId: PLUGIN_ID,
        name: z2mContainerName(net.id),
        image,
        defaultTag: tag,
        // Read the current access on every (re)build: an espOS coordinator
        // that moved is restarted through the same container object.
        buildConfig: (t) =>
          z2mContainer(
            net,
            settings,
            image,
            t,
            mount,
            {
              serialPort: run.serialPort ?? access.serialPort,
              devices: access.devices,
              groupAdd: access.groupAdd,
            },
            frontendToken,
          ),
        quiet: true,
      });
      run.serialPort = access.serialPort;
      await run.container.start(tag, { signal });
      if (signal.aborted) return;
      this.setPhase(net.id, "running");
    } catch (err) {
      if (signal.aborted) return;
      this.setPhase(net.id, "error", errMsg(err));
    }
  }

  /** Start-up steps go to the debug log too: the status line needs a login. */
  private progress(message: string): void {
    this.app.setPluginStatus(message);
    this.app.debug(message);
  }

  private setPhase(id: string, phase: NetworkPhase, message?: string): void {
    const run = this.runs.get(id);
    if (run === undefined) return;
    run.phase = phase;
    run.message = message;
    this.app.debug(`${id}: ${phase}${message ? ` (${message})` : ""}`);
    this.report();
  }

  private report(): void {
    if (!this.running || this.problems.length > 0) return;
    const status = this.status();
    const errors = status.networks.filter((n) => n.phase === "error");
    const parts = status.networks
      .filter((n) => n.phase !== "disabled")
      .map((n) => {
        if (n.phase !== "running") return `${n.id}: ${n.message ?? n.phase}`;
        const state =
          n.online === undefined
            ? "Zigbee2MQTT starting"
            : n.online
              ? "online"
              : "Zigbee2MQTT offline";
        const count = n.devices.length;
        return `${n.id}: ${state}, ${count} device${count === 1 ? "" : "s"}`;
      });
    if (status.discovered.length > 0) {
      parts.push(
        `unconfigured espOS coordinator: ${status.discovered
          .map((c) => `${c.name} (${c.address})`)
          .join(", ")}`,
      );
    }
    const line = parts.join(" · ") || "Broker running";
    if (errors.length > 0) {
      this.app.setPluginError(line);
    } else {
      this.app.setPluginStatus(
        status.brokerConnected ? line : `${line} · MQTT not connected`,
      );
    }
  }
}
