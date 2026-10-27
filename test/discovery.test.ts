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
});
