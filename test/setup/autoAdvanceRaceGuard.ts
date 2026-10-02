/** Opt-in Bun preload. Perturb real completions only during FakeTimer auto-advance. */
import { mock } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import { MAX_SETTIMEOUT_DELAY_MS } from "../../src/utils/SystemTimer";

const configured = process.env.AUTOADV_DELAY_MS;
const requested = Number(configured ?? 10);
const valid =
  configured?.trim() !== "" &&
  Number.isInteger(requested) &&
  requested >= 0 &&
  requested <= MAX_SETTIMEOUT_DELAY_MS;
const delayMs = valid ? requested : 10;
if (!valid) {
  process.stderr.write("AUTOADV_DELAY_MS must be a nonnegative timer-sized integer; using 10ms\n");
}

// Zero installs nothing, including no FakeTimer method wrappers or module mocks.
if (delayMs > 0) {
  installGuard();
}

type Callable = (this: unknown, ...args: unknown[]) => unknown;
function isCallable(value: unknown): value is Callable {
  return typeof value === "function";
}

function installGuard(): void {
  // Capture real primitives before mocking: our injected waits must never recurse.
  const realTimeout = globalThis.setTimeout;
  const realFsPromises: typeof import("node:fs/promises") = require("node:fs/promises");
  const realFs: typeof import("node:fs") = require("node:fs");
  const realChild: typeof import("node:child_process") = require("node:child_process");
  const realTimers: typeof import("node:timers/promises") = require("node:timers/promises");
  const enabled = new Set<FakeTimer>();
  const enable = FakeTimer.prototype.enableAutoAdvance;
  FakeTimer.prototype.enableAutoAdvance = function (): void {
    enable.call(this);
    enabled.add(this);
  };
  const reset = FakeTimer.prototype.reset;
  FakeTimer.prototype.reset = function (): void {
    reset.call(this);
    // reset() clears queued work but preserves autoAdvance; retain membership.
    // No public method currently disables auto-advance. Never read private state.
  };
  const active = (): boolean => enabled.size > 0;
  const later = (callback: () => void): void => {
    realTimeout(callback, delayMs);
  };

  function delayedPromise(fn: Callable): Callable {
    return new Proxy(fn, {
      apply(original, receiver, args: unknown[]): unknown {
        const shouldDelay = active();
        const result: unknown = Reflect.apply(original, receiver, args);
        if (!shouldDelay) {
          return result;
        }
        // Both handlers attach immediately, preserving rejection without an unhandled gap.
        return new Promise<unknown>((resolve, reject) => {
          Promise.resolve(result).then(
            (value: unknown) => later(() => resolve(value)),
            (error: unknown) => later(() => reject(error)),
          );
        });
      },
    });
  }

  function delayedCallback(fn: Callable): Callable {
    return new Proxy(fn, {
      apply(original, receiver, args: unknown[]): unknown {
        const index = args.length - 1;
        const callback = args[index];
        if (active() && isCallable(callback)) {
          args[index] = function (this: unknown, ...values: unknown[]): void {
            const callbackReceiver = this;
            later(() => Reflect.apply(callback, callbackReceiver, values));
          };
        }
        return Reflect.apply(original, receiver, args);
      },
    });
  }

  function copyModule(real: object): Record<PropertyKey, unknown> {
    const copy: Record<PropertyKey, unknown> = {};
    for (const key of Reflect.ownKeys(real)) {
      if (key !== "default") {
        copy[key] = Reflect.get(real, key);
      }
    }
    copy.default = copy;
    return copy;
  }
  function installModule(name: string, wrapped: Record<PropertyKey, unknown>): void {
    mock.module(`node:${name}`, () => wrapped);
    mock.module(name, () => wrapped);
  }

  const promises = copyModule(realFsPromises);
  for (const key of Object.keys(promises)) {
    const fn = promises[key];
    // watch returns an iterator, not an I/O completion promise.
    if (key !== "watch" && isCallable(fn)) {
      promises[key] = delayedPromise(fn);
    }
  }
  installModule("fs/promises", promises);

  const fs = copyModule(realFs);
  fs.promises = promises;
  const excluded = new Set([
    "createReadStream",
    "createWriteStream",
    "watch",
    "watchFile",
    "unwatchFile",
  ]);
  for (const key of Object.keys(fs)) {
    const fn = fs[key];
    if (!isCallable(fn) || key.endsWith("Sync") || /^[A-Z]/.test(key) || excluded.has(key)) {
      continue;
    }
    const wrapped = delayedCallback(fn);
    const native: unknown = Reflect.get(fn, "native");
    // Preserve realpath.native without mutating the original builtin function.
    const wrappedNative = isCallable(native) ? delayedCallback(native) : undefined;
    fs[key] = wrappedNative
      ? new Proxy(wrapped, {
          get(target, property, receiver): unknown {
            return property === "native" ? wrappedNative : Reflect.get(target, property, receiver);
          },
        })
      : wrapped;
  }
  installModule("fs", fs);

  const child = copyModule(realChild);
  for (const key of ["exec", "execFile"]) {
    const fn = child[key];
    if (isCallable(fn)) {
      child[key] = delayedCallback(fn);
    }
  }
  for (const key of ["spawn", "fork"]) {
    const fn = child[key];
    if (!isCallable(fn)) {
      continue;
    }
    child[key] = new Proxy(fn, {
      apply(original, receiver, args: unknown[]): unknown {
        const shouldDelay = active();
        const result: unknown = Reflect.apply(original, receiver, args);
        if (shouldDelay && result instanceof realChild.ChildProcess) {
          const emit = result.emit;
          result.emit = function (event: string | symbol, ...values: unknown[]): boolean {
            if (event !== "exit" && event !== "close" && event !== "error") {
              return Reflect.apply(emit, this, [event, ...values]);
            }
            const emitter = this;
            later(() => Reflect.apply(emit, emitter, [event, ...values]));
            return this.listenerCount(event) > 0;
          };
        }
        return result;
      },
    });
  }
  installModule("child_process", child);

  function extendedDuration(value: unknown): number {
    const requestedMs = Number(value ?? 1);
    const normalized =
      requestedMs >= 1 && requestedMs <= MAX_SETTIMEOUT_DELAY_MS ? Math.trunc(requestedMs) : 1;
    return Math.min(MAX_SETTIMEOUT_DELAY_MS, normalized + delayMs);
  }
  const timers = copyModule(realTimers);
  const promiseTimeout = new Proxy(realTimers.setTimeout, {
    apply(original, receiver, args: unknown[]): unknown {
      if (active()) {
        args[0] = extendedDuration(args[0]);
      }
      return Reflect.apply(original, receiver, args);
    },
  });
  timers.setTimeout = promiseTimeout;
  installModule("timers/promises", timers);
  globalThis.setTimeout = new Proxy(realTimeout, {
    apply(original, receiver, args: unknown[]): unknown {
      if (active()) {
        args[1] = extendedDuration(args[1]);
      }
      return Reflect.apply(original, receiver, args);
    },
    get(target, property, receiver): unknown {
      return property === Symbol.for("nodejs.util.promisify.custom")
        ? promiseTimeout
        : Reflect.get(target, property, receiver);
    },
  });
  Bun.sleep = new Proxy(Bun.sleep, {
    apply(original, receiver, args: unknown[]): unknown {
      if (active()) {
        const duration = args[0];
        args[0] =
          duration instanceof Date
            ? new Date(Math.max(Date.now(), duration.getTime()) + delayMs)
            : Math.max(0, Number(duration)) + delayMs;
      }
      return Reflect.apply(original, receiver, args);
    },
  });
}
