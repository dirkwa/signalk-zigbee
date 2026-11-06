import { afterEach, describe, expect, it, vi } from "vitest";
import { settledWithin, untilAborted } from "../src/wait.js";

const never = new Promise<never>(() => undefined);

describe("untilAborted", () => {
  it("passes the value through", async () => {
    const abort = new AbortController();
    await expect(untilAborted(Promise.resolve(3), abort.signal)).resolves.toBe(
      3,
    );
  });

  it("gives up on a call that never answers once aborted", async () => {
    const abort = new AbortController();
    const waiting = untilAborted(never, abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("does not wait at all when already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(untilAborted(never, abort.signal)).resolves.toBeUndefined();
  });

  it("turns a rejection into undefined", async () => {
    const abort = new AbortController();
    await expect(
      untilAborted(Promise.reject(new Error("probe failed")), abort.signal),
    ).resolves.toBeUndefined();
  });
});

describe("settledWithin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is true for work that settles in time, rejected or not", async () => {
    await expect(settledWithin(Promise.resolve(), 1000)).resolves.toBe(true);
    await expect(
      settledWithin(Promise.reject(new Error("x")), 1000),
    ).resolves.toBe(true);
  });

  it("stops waiting on a recreate that does not finish", async () => {
    vi.useFakeTimers();
    const waiting = settledWithin(never, 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(waiting).resolves.toBe(false);
  });
});
