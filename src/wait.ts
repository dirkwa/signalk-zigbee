/**
 * Waiting on work that cannot be cancelled: signalk-container's container
 * calls and host probes take no AbortSignal.
 */

/**
 * The promise's value, or undefined once `signal` aborts or the promise
 * rejects, so a caller that is being stopped stops waiting.
 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      resolve(undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(undefined);
      },
    );
  });
}

/** Waits for `promise` at most `ms`; true when it settled in time. */
export async function settledWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
