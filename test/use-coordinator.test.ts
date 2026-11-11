import type { ServerAPI } from "@signalk/server-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDefaults, type Settings } from "../src/config.js";
import type { Coordinator } from "../src/discovery.js";
import { UseCoordinatorError, ZigbeeRunner } from "../src/runner.js";

const STICK = {
  serialPort:
    "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus-if00-port0",
  adapter: "zstack",
};
const GATEWAY: Coordinator = {
  name: "espos-zigbee-a1b2",
  deviceId: "a1b2c3",
  address: "192.168.1.40",
  port: 6638,
  seenAt: 0,
};

type SaveCallback = (err?: Error | null) => void;

/** The runner's state after start-up found coordinators but no network. */
interface Waiting {
  running: boolean;
  settings: Settings;
  abort: AbortController;
  usbSticks: (typeof STICK)[];
  discovery: { list: () => Coordinator[]; stop: () => void };
}

describe("useCoordinator", () => {
  let saved: Settings[];
  let saveError: Error | undefined;
  let pendingSave: SaveCallback | undefined;
  let holdSave: boolean;
  let runner: ZigbeeRunner;
  let start: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    saved = [];
    saveError = undefined;
    pendingSave = undefined;
    holdSave = false;
    const app = {
      debug: () => undefined,
      error: () => undefined,
      savePluginOptions: (options: Settings, callback: SaveCallback) => {
        saved.push(options);
        if (holdSave) pendingSave = callback;
        else callback(saveError);
      },
    } as unknown as ServerAPI;
    runner = new ZigbeeRunner(app);
    const waiting: Waiting = {
      running: true,
      settings: applyDefaults({}),
      abort: new AbortController(),
      usbSticks: [STICK],
      discovery: { list: () => [GATEWAY], stop: () => undefined },
    };
    Object.assign(runner, waiting);
    start = vi.spyOn(runner, "start").mockImplementation((settings) => {
      Object.assign(runner, { settings });
    });
  });

  async function refusal(promise: Promise<void>): Promise<number> {
    const err: unknown = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UseCoordinatorError);
    return (err as UseCoordinatorError).statusCode;
  }

  it("saves a listed stick as network main and starts it", async () => {
    await runner.useCoordinator({ serialPort: STICK.serialPort });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.networks).toMatchObject([
      { id: "main", coordinator: "usb", ...STICK },
    ]);
    expect(start).toHaveBeenCalledWith(saved[0]);
  });

  it("saves a found espOS gateway by its device id", async () => {
    await runner.useCoordinator({ espos: "A1B2C3" });
    expect(saved[0]!.networks).toMatchObject([
      { id: "main", coordinator: "espos", esposAddress: "a1b2c3" },
    ]);
    expect(start).toHaveBeenCalledOnce();
  });

  it("refuses a coordinator that is not listed", async () => {
    expect(
      await refusal(runner.useCoordinator({ serialPort: "/dev/ttyUSB9" })),
    ).toBe(404);
    expect(await refusal(runner.useCoordinator({ espos: "other" }))).toBe(404);
    expect(saved).toEqual([]);
  });

  it("refuses once a network exists", async () => {
    await runner.useCoordinator({ serialPort: STICK.serialPort });
    expect(await refusal(runner.useCoordinator({ espos: "a1b2c3" }))).toBe(409);
    expect(saved).toHaveLength(1);
  });

  it("refuses a second pick while the first is saving", async () => {
    holdSave = true;
    const first = runner.useCoordinator({ serialPort: STICK.serialPort });
    expect(await refusal(runner.useCoordinator({ espos: "a1b2c3" }))).toBe(409);
    pendingSave!(null);
    await first;
    expect(saved).toHaveLength(1);
    expect(start).toHaveBeenCalledOnce();
  });

  it("refuses a second pick while the first is starting", async () => {
    let release = (): void => undefined;
    const stopping = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.assign(runner, { bridge: { stop: () => stopping } });
    const first = runner.useCoordinator({ serialPort: STICK.serialPort });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await refusal(runner.useCoordinator({ espos: "a1b2c3" }))).toBe(409);
    release();
    await first;
    expect(saved).toHaveLength(1);
    expect(start).toHaveBeenCalledOnce();
  });

  it("starts nothing when saving fails, and allows another try", async () => {
    saveError = new Error("disk full");
    await expect(
      runner.useCoordinator({ serialPort: STICK.serialPort }),
    ).rejects.toThrow("disk full");
    expect(start).not.toHaveBeenCalled();
    saveError = undefined;
    await runner.useCoordinator({ serialPort: STICK.serialPort });
    expect(start).toHaveBeenCalledOnce();
  });

  it("refuses while the plugin is not running", async () => {
    Object.assign(runner, { running: false });
    expect(
      await refusal(runner.useCoordinator({ serialPort: STICK.serialPort })),
    ).toBe(503);
  });
});
