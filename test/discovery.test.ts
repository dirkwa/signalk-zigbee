import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  coordinatorFromService,
  CoordinatorDiscovery,
  matchesCoordinator,
  type BonjourLike,
  type MdnsService,
} from "../src/discovery.js";

const SERVICE: MdnsService = {
  name: "zb-gateway-a1b2",
  host: "zb-gateway-a1b2.local",
  port: 6638,
  addresses: ["fe80::1", "192.168.0.77"],
  txt: { id: Buffer.from("a1b2"), radio_type: "zboss" },
};

class FakeBrowser extends EventEmitter {
  stop() {}
}

function fakeBonjour() {
  const browser = new FakeBrowser();
  let onUp: ((s: MdnsService) => void) | undefined;
  const bonjour: BonjourLike = {
    find: (_opts, up) => {
      onUp = up;
      return browser;
    },
    destroy() {},
  };
  return { bonjour, announce: (s: MdnsService) => onUp?.(s), browser };
}

describe("coordinatorFromService", () => {
  it("takes the IPv4 address and the espOS id", () => {
    expect(coordinatorFromService(SERVICE, 5)).toEqual({
      name: "zb-gateway-a1b2",
      host: "zb-gateway-a1b2.local",
      address: "192.168.0.77",
      port: 6638,
      deviceId: "a1b2",
      seenAt: 5,
    });
  });

  it("ignores a service without IPv4", () => {
    expect(
      coordinatorFromService({ ...SERVICE, addresses: ["fe80::1"] }, 0),
    ).toBeUndefined();
  });
});

describe("matchesCoordinator", () => {
  const c = coordinatorFromService(SERVICE, 0)!;
  it.each(["zb-gateway-a1b2", "ZB-Gateway-A1B2.local", "a1b2", "192.168.0.77"])(
    "matches %s",
    (spec) => expect(matchesCoordinator(spec, c)).toBe(true),
  );
  it("does not match another device", () => {
    expect(matchesCoordinator("c3d4", c)).toBe(false);
  });
});

describe("CoordinatorDiscovery", () => {
  it("resolves IPv4 literals without mDNS", async () => {
    const discovery = new CoordinatorDiscovery(() => {});
    expect(await discovery.resolve("10.0.0.9")).toBe("tcp://10.0.0.9:6638");
    expect(await discovery.resolve("10.0.0.9:7000")).toBe(
      "tcp://10.0.0.9:7000",
    );
  });

  it("resolves names from mDNS and follows an address change", async () => {
    const { bonjour, announce, browser } = fakeBonjour();
    let changes = 0;
    const discovery = new CoordinatorDiscovery(
      () => changes++,
      async () => bonjour,
    );
    await discovery.start();
    expect(await discovery.resolve("a1b2.local")).toBeUndefined();

    announce(SERVICE);
    expect(await discovery.resolve("a1b2")).toBe("tcp://192.168.0.77:6638");
    announce(SERVICE);
    expect(changes).toBe(1);

    browser.emit("srv-update", { ...SERVICE, addresses: ["192.168.0.80"] });
    expect(changes).toBe(2);
    expect(await discovery.resolve("zb-gateway-a1b2")).toBe(
      "tcp://192.168.0.80:6638",
    );
    discovery.stop();
  });

  it("releases the socket when stopped while starting", async () => {
    let destroyed = 0;
    let finishImport: (b: BonjourLike) => void = () => {};
    const discovery = new CoordinatorDiscovery(
      () => {},
      () => new Promise<BonjourLike>((resolve) => (finishImport = resolve)),
    );
    const starting = discovery.start();
    discovery.stop();
    finishImport({
      find: () => {
        throw new Error("must not browse after stop");
      },
      destroy: () => destroyed++,
    });
    await starting;
    expect(destroyed).toBe(1);
  });

  it("shares one start between concurrent callers", async () => {
    let created = 0;
    let browsing = 0;
    const discovery = new CoordinatorDiscovery(
      () => {},
      async () => {
        created++;
        return {
          find: () => {
            browsing++;
            return new FakeBrowser();
          },
          destroy() {},
        };
      },
    );
    await Promise.all([discovery.start(), discovery.start()]);
    expect([created, browsing]).toEqual([1, 1]);
    discovery.stop();
  });

  it("does not revive a start that a stop and restart overtook", async () => {
    const pending: ((b: BonjourLike) => void)[] = [];
    let browsing = 0;
    let destroyed = 0;
    const bonjour = (): BonjourLike => ({
      find: () => {
        browsing++;
        return new FakeBrowser();
      },
      destroy: () => destroyed++,
    });
    const discovery = new CoordinatorDiscovery(
      () => {},
      () => new Promise<BonjourLike>((resolve) => pending.push(resolve)),
    );
    const first = discovery.start();
    discovery.stop();
    const second = discovery.start();
    pending[1]!(bonjour());
    pending[0]!(bonjour());
    await Promise.all([first, second]);
    expect(browsing).toBe(1);
    expect(destroyed).toBe(1);
    discovery.stop();
    expect(destroyed).toBe(2);
  });
});
