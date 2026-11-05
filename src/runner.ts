/**
 * Lifecycle: one Mosquitto broker, one Zigbee2MQTT container per enabled
 * network, the MQTT bridge, and mDNS discovery when an espOS coordinator is
 * configured.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { ServerAPI } from "@signalk/server-api";
import {
  errMsg,
  listHostSerialDevices,
  DEVICE_WATCH_INTERVAL_MS,
  ManagedContainer,
  probeHostDevice,
  resolveMount,
  startSafely,
  waitForContainerManager,
  watchHostDevice,
  type ContainerManagerApi,
  type DeviceWatchEvent,
  type HostDeviceWatch,
  type HostMount,
  type StopOptions,
} from "signalk-container-helper";
import { ZigbeeBridge, type NetworkStatus } from "./bridge.js";
import {
  applyDefaults,
  baseTopic,
  isSerialDirectory,
  MOSQUITTO_IMAGE,
  PLUGIN_ID,
  validate,
  z2mImage,
  type NetworkConfig,
  type Settings,
} from "./config.js";
import { describeSticks, findSticks, type UsbStick } from "./coordinators.js";
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
  containerGone,
  exitCheckNeeded,
  isCharacterDevice,
  usbCoordinatorProblem,
  type CoordinatorAccess,
} from "./stack.js";

function unpluggedMessage(serialPort: string): string {
  return `${serialPort} is unplugged; Zigbee2MQTT starts when it is plugged in`;
}

/** Group owning USB serial nodes on Debian-family hosts. */
const SERIAL_GROUP = "dialout";
const MANAGER_TIMEOUT_MS = 120_000;
const STOP_ATTEMPTS = 3;
const STOP_RETRY_MS = 10_000;
/**
 * How often to look for a Zigbee stick while no network is configured. Each
 * look starts a short-lived container under a containerized Signal K.
 */
const STICK_SEARCH_INTERVAL_MS = 60_000;

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
  /** USB networks: follows the stick being unplugged and plugged back in. */
  watch?: HostDeviceWatch;
  /** USB networks: looks for a Zigbee2MQTT container that exited. */
  exitCheck?: ReturnType<typeof setInterval>;
  /** USB networks: the stick handling in progress, one step at a time. */
  stickWork?: Promise<void>;
  /** The container's first start, which an unplug stop must not overtake. */
  starting?: Promise<unknown>;
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
  /** Seconds until pairing closes; absent while it is closed. */
  pairingSeconds?: number;
  devices: NetworkStatus["devices"];
}

export interface StatusReport {
  running: boolean;
  problems: string[];
  brokerConnected: boolean;
  networks: NetworkReport[];
  /** espOS coordinators seen on mDNS that no network uses yet. */
  discovered: Coordinator[];
  /**
   * Zigbee sticks plugged into the host, listed while no network is
   * configured. A single one becomes the "main" network on its own.
   */
  usbSticks: UsbStick[];
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
  /** Serializes broker config writes, which cannot be cancelled once begun. */
  private configWrite: Promise<void> = Promise.resolve();
  private running = false;
  private usbSticks: UsbStick[] = [];
  private stickSearch: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly app: ServerAPI) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(settings: Settings): void {
    // Signal K calls stop() first; abort here too, so an overlapping
    // start-up can never pass its own checks.
    this.abort?.abort();
    this.abort = undefined;
    // The previous run's stick handler may still be stopping its container;
    // this run's container must not start before it is done.
    const settled = Promise.all(
      [...this.runs.values()].map((run) => this.stopWatching(run)),
    );
    clearInterval(this.stickSearch);
    this.stickSearch = undefined;
    this.usbSticks = [];
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
      const pickedDirectory = settings.networks.some(
        (net) =>
          net.enabled &&
          net.coordinator === "usb" &&
          isSerialDirectory(net.serialPort),
      );
      if (pickedDirectory) {
        const abort = new AbortController();
        this.abort = abort;
        void this.offerSticks(abort.signal);
      }
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
      settled
        .then(() => this.bringUp(settings, abort.signal))
        .catch((err: unknown) => {
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
    clearInterval(this.stickSearch);
    this.stickSearch = undefined;
    for (const run of this.runs.values()) {
      await this.stopWatching(run);
    }
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
          pairingSeconds: live?.pairingSeconds,
          devices: live?.devices ?? [],
        };
      }),
      discovered: (this.discovery?.list() ?? []).filter(
        (c) => !used.includes(`tcp://${c.address}:${c.port}`),
      ),
      usbSticks: this.usbSticks,
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

    if (settings.networks.length === 0) {
      if (await this.adoptStick(settings, signal)) return;
      if (signal.aborted) return;
      let searching = false;
      this.stickSearch = setInterval(() => {
        if (searching || signal.aborted) return;
        searching = true;
        void this.adoptStick(settings, signal).finally(() => {
          searching = false;
        });
      }, STICK_SEARCH_INTERVAL_MS);
    }

    this.progress("Preparing the data directory");
    const hostDir = this.app.getDataDirPath();
    const mount = await resolveMount(manager, {
      containerPath: "/data",
      hostPath: hostDir,
    });
    const brokerMount = await resolveMount(manager, {
      containerPath: MOSQUITTO_DATA_MOUNT,
      hostPath: hostDir,
    });
    // A newer run owns the broker config and these fields from here on.
    if (signal.aborted) return;
    this.mount = mount;
    // Queued behind an older run's write that was already under way, and
    // checked again once it is this run's turn.
    const write = this.configWrite.then(() =>
      signal.aborted
        ? undefined
        : writeMosquittoFiles(hostDir, settings, brokerMount.containerPath),
    );
    this.configWrite = write.catch(() => undefined);
    await write;
    if (signal.aborted) return;

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
      isCharacterDevice(net.serialPort),
    );
    if (problem !== undefined && onHost !== false) {
      this.app.error(`${net.id}: ${problem}`);
      this.setPhase(net.id, "error", problem);
      // Watched as absent, so the network is tried again once the host
      // probe reports the stick, say after it is plugged in.
      this.watchStick(net, true, signal);
      return;
    }
    this.watchStick(net, onHost === false, signal);
    if (onHost === false) {
      this.setPhase(net.id, "waiting", unpluggedMessage(net.serialPort));
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

  /**
   * Lists the host's Zigbee sticks next to a configuration problem, so a user
   * who chose the by-id directory sees which link inside it to pick.
   */
  private async offerSticks(signal: AbortSignal): Promise<void> {
    let sticks: UsbStick[];
    try {
      const { manager } = await waitForContainerManager({
        timeoutMs: MANAGER_TIMEOUT_MS,
        signal,
      });
      if (signal.aborted || manager === undefined) return;
      const paths = await listHostSerialDevices(manager);
      if (signal.aborted || paths === null) return;
      sticks = findSticks(paths);
    } catch (err) {
      if (!signal.aborted) {
        this.app.debug(`listing USB serial devices failed: ${errMsg(err)}`);
      }
      return;
    }
    if (sticks.length === 0) return;
    this.usbSticks = sticks;
    this.app.setPluginError(
      `${this.problems.join(" ")} Zigbee sticks found: ${describeSticks(sticks)}.`,
    );
  }

  /**
   * With no network configured, a single Zigbee stick on the host becomes the
   * "main" network: saved to the plugin configuration, then started. Several
   * sticks are only listed, for the user to choose. Returns true when the
   * plugin restarted with the new network.
   */
  private async adoptStick(
    settings: Settings,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.manager === undefined) return false;
    let paths: string[] | null;
    try {
      paths = await listHostSerialDevices(this.manager);
    } catch (err) {
      this.app.debug(`listing USB serial devices failed: ${errMsg(err)}`);
      return false;
    }
    if (signal.aborted || paths === null) return false;
    this.usbSticks = findSticks(paths);
    const [stick] = this.usbSticks;
    if (stick === undefined || this.usbSticks.length > 1) {
      this.report();
      return false;
    }
    const adopted = applyDefaults({
      ...settings,
      networks: [{ id: "main", coordinator: "usb", ...stick }],
    });
    // Unsaved, the network would vanish from the plugin settings and the next
    // start would set it up again; the search retries the save instead.
    const saved = await new Promise<void>((resolve, reject) => {
      this.app.savePluginOptions(adopted, (err) => {
        if (err) reject(err);
        else resolve();
      });
    }).then(
      () => true,
      (err: unknown) => {
        this.app.error(`saving the Zigbee network failed: ${errMsg(err)}`);
        return false;
      },
    );
    if (!saved) return false;
    if (signal.aborted) return true;
    this.app.debug(
      `using Zigbee stick ${stick.serialPort} (${stick.adapter}) as network main`,
    );
    // start() expects stop() to have run: the search may find the stick after
    // this run connected to the broker and began mDNS discovery.
    this.discovery?.stop();
    this.discovery = undefined;
    const bridge = this.bridge;
    await bridge?.stop();
    // A start() during the await owns this.bridge now, maybe with a new one.
    if (signal.aborted) return true;
    if (this.bridge === bridge) this.bridge = undefined;
    this.start(adopted);
    return true;
  }

  /**
   * Zigbee2MQTT exits when its stick is pulled and the runtime restarts it
   * against a node that is gone; a stick plugged back in may get another
   * node, which the old container never sees. So the container is stopped
   * while the stick is out and recreated when it is back, or when it stays
   * offline with the stick plugged in.
   */
  private watchStick(
    net: NetworkConfig,
    absent: boolean,
    signal: AbortSignal,
  ): void {
    const run = this.runs.get(net.id);
    if (run === undefined || run.watch !== undefined || !this.manager) return;
    run.watch = watchHostDevice({
      manager: this.manager,
      path: net.serialPort,
      initiallyAbsent: absent,
      isStarted: () => run.container !== undefined,
      isHealthy: () =>
        this.bridge?.isConnected === true
          ? this.bridge.status().find((s) => s.id === net.id)?.online === true
          : undefined,
      onEvent: (event) =>
        this.queueStickWork(run, () => this.onStickEvent(run, event, signal)),
      debug: (msg) => {
        this.app.debug(msg);
      },
    });
    // The watch only sees a stick that was gone when it looked. A drop
    // shorter than its interval can still leave the container exited: the
    // runtime restarted it while the node was missing, the create failed,
    // and the runtime does not try again.
    let checking = false;
    run.exitCheck = setInterval(() => {
      if (checking || signal.aborted) return;
      checking = true;
      void this.queueStickWork(run, () => this.restartIfExited(run, signal))
        .catch((err: unknown) => {
          this.app.debug(`${net.id}: container check failed: ${errMsg(err)}`);
        })
        .finally(() => {
          checking = false;
        });
    }, DEVICE_WATCH_INTERVAL_MS);
  }

  private queueStickWork(
    run: NetworkRun,
    work: () => Promise<void>,
  ): Promise<void> {
    const next = (run.stickWork ?? Promise.resolve()).then(work);
    run.stickWork = next.catch(() => undefined);
    return next;
  }

  private async stopWatching(run: NetworkRun): Promise<void> {
    clearInterval(run.exitCheck);
    run.exitCheck = undefined;
    await run.watch?.stop();
    run.watch = undefined;
    await run.stickWork;
  }

  private async restartIfExited(
    run: NetworkRun,
    signal: AbortSignal,
  ): Promise<void> {
    const { container, net } = run;
    if (signal.aborted || container === undefined || !this.manager) return;
    const online = this.bridge?.status().find((s) => s.id === net.id)?.online;
    if (!exitCheckNeeded(run.phase, online)) return;
    const state = await container.getState();
    if (signal.aborted || !containerGone(state)) return;
    // A stick the probe reports missing is the watch's to handle; one it
    // cannot tell about is tried, since the container is down either way.
    const present = await probeHostDevice(this.manager, net.serialPort).then(
      (probe) => probe?.exists,
      () => undefined,
    );
    if (signal.aborted || present === false) return;
    this.app.debug(`${net.id}: Zigbee2MQTT ${state} with its stick plugged in`);
    await this.recreate(run, "Zigbee2MQTT exited; restarting", signal);
  }

  private async onStickEvent(
    run: NetworkRun,
    event: DeviceWatchEvent,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const { net } = run;
    if (event === "unplugged") {
      await this.stopWhileUnplugged(run, signal);
      return;
    }
    if (run.container === undefined) {
      await this.startUsbNetwork(net, signal);
      return;
    }
    await this.recreate(run, "restarting Zigbee2MQTT", signal);
  }

  private async recreate(
    run: NetworkRun,
    message: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { container, net } = run;
    if (container === undefined) return;
    this.setPhase(net.id, "starting", message);
    try {
      // A recreate, not a start: the stick may have come back as another
      // device node, which only a new container is given.
      await container.applyUpdate(
        container.lastStartedTag ?? z2mImage(net).tag,
        { signal },
      );
      if (signal.aborted) return;
      this.setPhase(net.id, "running");
    } catch (err) {
      if (signal.aborted) return;
      this.setPhase(net.id, "error", errMsg(err));
    }
  }

  /**
   * The watch reports `unplugged` once, so a failed stop is retried here: a
   * container left running would loop on a node that is gone while the
   * network reads "waiting".
   */
  private async stopWhileUnplugged(
    run: NetworkRun,
    signal: AbortSignal,
  ): Promise<void> {
    const { net } = run;
    const name = z2mContainerName(net.id);
    // A start still in flight would bring the container back after the stop,
    // so it settles first; its own outcome is reported by startNetwork.
    await run.starting?.catch(() => undefined);
    if (signal.aborted) return;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.manager?.stop(name);
        if (signal.aborted) return;
        this.setPhase(net.id, "waiting", unpluggedMessage(net.serialPort));
        return;
      } catch (err) {
        if (signal.aborted) return;
        this.app.error(`could not stop ${name}: ${errMsg(err)}`);
        if (attempt === STOP_ATTEMPTS) {
          this.setPhase(
            net.id,
            "error",
            `${net.serialPort} is unplugged, but Zigbee2MQTT could not be stopped: ${errMsg(err)}`,
          );
          return;
        }
      }
      await delay(STOP_RETRY_MS, undefined, { signal }).catch(() => undefined);
      if (signal.aborted) return;
    }
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
      run.starting = run.container.start(tag, { signal });
      await run.starting;
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
    if (status.usbSticks.length > 1) {
      parts.push(
        `${String(status.usbSticks.length)} Zigbee sticks found; add the one to use under Plugin Config`,
      );
    }
    const line =
      parts.join(" · ") ||
      (status.networks.length === 0
        ? "Waiting for a Zigbee stick or a network in Plugin Config"
        : "Broker running");
    if (errors.length > 0) {
      this.app.setPluginError(line);
    } else {
      this.app.setPluginStatus(
        status.brokerConnected ? line : `${line} · MQTT not connected`,
      );
    }
  }
}
