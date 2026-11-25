import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  localClaimRegistryExpectation,
  localPreBindRegistryOpen,
  PRE_BIND_REGISTRY_OPEN_BACKOFF,
} from "../../src/daemon/deviceClaimRegistryExpectation";
import {
  DEVICE_CLAIM_READ_OPEN_TIMEOUT_MS,
  StoreDeviceClaimMirror,
  type DeviceClaims,
} from "../../src/daemon/deviceClaims";
import { BindingDiscoveryIncompleteError } from "../../src/daemon/sessionBroker/provisioning/BindingDiscoveryIncompleteError";
import { BindingRegistrySchemaUnsupportedError } from "../../src/daemon/sessionBroker/provisioning/BindingRegistrySchemaUnsupportedError";
import { BindingRegistryUpgradePendingError } from "../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import { logger } from "../../src/utils/logger";
import { FakeDeviceClaims } from "../fakes/FakeDeviceClaims";
import { FakeTimer } from "../fakes/FakeTimer";

// #11811 (owner decision 2026-11-07, E1): before the socket binds, a claim the table cannot decide
// is refused retryably whenever a registry file exists and its open or read failed for any reason
// but a pending migration. Only a host with no registry file, or one still waiting for this
// release's migrations, leaves pre-bind claims to the claim files.

const DEVICE = "emulator-5554";
const ME = { pid: 100, ownerToken: "token-a" };
const live = async () => true;

const pending = () => new BindingRegistryUpgradePendingError("Binding registry upgrade pending");
const unsupported = () =>
  new BindingRegistrySchemaUnsupportedError("/registry.db", ["2099_01_01_999_future"]);
const busy = () => new BindingDiscoveryIncompleteError("SQLITE_BUSY: database is locked");

describe("localClaimRegistryExpectation", () => {
  function expectation(
    inputs: { bound?: boolean; fileExists?: boolean; lastOpenFailure?: unknown } = {},
  ) {
    return localClaimRegistryExpectation({
      socketBound: () => inputs.bound ?? false,
      registryFileExists: () => inputs.fileExists ?? false,
      lastOpenFailure: () => inputs.lastOpenFailure,
    });
  }

  test("once bound, a registry must decide whatever failed", () => {
    for (const error of [undefined, pending(), busy(), new Error("disk I/O error")]) {
      expect(expectation({ bound: true })(error)).toBe(true);
    }
  });

  test("before bind with no registry file, the claim files decide", () => {
    for (const error of [undefined, busy(), new Error("ENOENT")]) {
      expect(expectation({ fileExists: false })(error)).toBe(false);
    }
  });

  test("before bind with a registry file, a busy, failed or timed-out open must not fall back", () => {
    for (const error of [busy(), new Error("disk I/O error"), new Error("timed out")]) {
      expect(expectation({ fileExists: true })(error)).toBe(true);
    }
    // A forgotten open's failure counts as the claim's own.
    expect(expectation({ fileExists: true, lastOpenFailure: busy() })(undefined)).toBe(true);
  });

  test("before bind with a registry file that nothing decided, the registry must decide", () => {
    // A claim that finds no open registry starts one, so seeing no failure is no reason to fall back.
    expect(expectation({ fileExists: true })(undefined)).toBe(true);
  });

  test("before bind, a registry still waiting for this release's migrations leaves claims to the files", () => {
    expect(expectation({ fileExists: true })(pending())).toBe(false);
    // The open that found the pending schema was forgotten; the claim saw no error of its own.
    expect(expectation({ fileExists: true, lastOpenFailure: pending() })(undefined)).toBe(false);
  });

  test("a claim's own failure outranks an older pending-schema open", () => {
    expect(expectation({ fileExists: true, lastOpenFailure: pending() })(busy())).toBe(true);
  });

  test("an unsupported schema leaves claims to the files (files_only mode)", () => {
    expect(expectation({ fileExists: true })(unsupported())).toBe(false);
    expect(expectation({ fileExists: true, lastOpenFailure: unsupported() })(undefined)).toBe(
      false,
    );
  });

  test("a registry file probe that throws counts as present, failing closed", () => {
    const expect_ = localClaimRegistryExpectation({
      socketBound: () => false,
      registryFileExists: () => {
        throw new Error("EACCES");
      },
      lastOpenFailure: () => undefined,
    });
    expect(expect_(busy())).toBe(true);
  });
});

describe("pre-bind claims through the mirror (#11811, E1)", () => {
  let timer: FakeTimer;
  let warn: ReturnType<typeof spyOn>;
  let fileExists: boolean;
  let lastOpenFailure: unknown;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(10);
    fileExists = true;
    lastOpenFailure = undefined;
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  function mirrorWith(
    store: () => DeviceClaims | undefined,
    whenOpen?: () => Promise<DeviceClaims | undefined>,
    startOpen?: () => void,
  ) {
    return new StoreDeviceClaimMirror({
      platform: "android",
      store,
      ...(whenOpen ? { whenOpen } : {}),
      ...(startOpen ? { startOpen } : {}),
      timer,
      generationOf: () => undefined,
      registryExpected: localClaimRegistryExpectation({
        socketBound: () => false,
        registryFileExists: () => fileExists,
        lastOpenFailure: () => lastOpenFailure,
      }),
    });
  }

  test("a busy open refuses the claim when the registry file exists", async () => {
    const mirror = mirrorWith(
      () => undefined,
      async () => {
        throw busy();
      },
    );
    expect(await mirror.acquire(DEVICE, ME, live)).toEqual({ outcome: "unusable" });
  });

  test("an open that does not settle within the read timeout refuses the claim", async () => {
    const mirror = mirrorWith(
      () => undefined,
      () => new Promise<DeviceClaims | undefined>(() => {}),
    );
    const decision = mirror.acquire(DEVICE, ME, live);
    await timer.advanceTimeAsync(DEVICE_CLAIM_READ_OPEN_TIMEOUT_MS);
    expect(await decision).toEqual({ outcome: "unusable" });
  });

  test("a busy table write after its retries refuses the claim", async () => {
    const store = new FakeDeviceClaims();
    store.failWrites = 100;
    const mirror = mirrorWith(() => store);
    expect(await timer.resolvePromise(mirror.acquire(DEVICE, ME, live))).toEqual({
      outcome: "unusable",
    });
  });

  test("a forgotten failed open refuses the claim while the file exists", async () => {
    lastOpenFailure = new Error("disk I/O error");
    const mirror = mirrorWith(
      () => undefined,
      async () => undefined,
    );
    expect(await mirror.acquire(DEVICE, ME, live)).toEqual({ outcome: "unusable" });
  });

  test("a pending migration leaves the claim to the files", async () => {
    const rejecting = mirrorWith(
      () => undefined,
      async () => {
        throw pending();
      },
    );
    expect(await rejecting.acquire(DEVICE, ME, live)).toEqual({ outcome: "unavailable" });
    lastOpenFailure = pending();
    const forgotten = mirrorWith(
      () => undefined,
      async () => undefined,
    );
    expect(await forgotten.acquire(DEVICE, ME, live)).toEqual({ outcome: "unavailable" });
  });

  test("with a registry file but nothing open, the claim starts an open and its outcome decides", async () => {
    const registry: { opening?: Promise<DeviceClaims> } = {};
    let outcome: () => Promise<DeviceClaims> = async () => {
      throw busy();
    };
    let opens = 0;
    const mirror = mirrorWith(
      () => undefined,
      async () => registry.opening,
      () => {
        opens++;
        registry.opening = outcome();
        // A failed open is forgotten, as the daemon's is.
        registry.opening.catch(() => {
          registry.opening = undefined;
        });
      },
    );
    expect(await mirror.acquire(DEVICE, ME, live)).toEqual({ outcome: "unusable" });

    outcome = async () => {
      throw pending();
    };
    expect(await mirror.acquire(DEVICE, ME, live)).toEqual({ outcome: "unavailable" });

    const store = new FakeDeviceClaims();
    outcome = async () => store;
    expect(await mirror.acquire(DEVICE, ME, live)).toEqual({ outcome: "claimed" });
    expect((await store.get("android", DEVICE))?.pid).toBe(ME.pid);
    expect(opens).toBe(3);
  });

  test("an open that cannot be started leaves the claim refused while the file exists", async () => {
    const mirror = mirrorWith(
      () => undefined,
      async () => undefined,
      () => {
        throw new Error("open refused to start");
      },
    );
    expect(await mirror.acquire(DEVICE, ME, live)).toEqual({ outcome: "unusable" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Cannot start a registry open"),
      expect.any(Error),
    );
  });

  test("a cached registry is used without starting an open", async () => {
    const store = new FakeDeviceClaims();
    let opens = 0;
    const mirror = mirrorWith(
      () => store,
      async () => store,
      () => {
        opens++;
      },
    );
    expect(await mirror.acquire(DEVICE, ME, live)).toEqual({ outcome: "claimed" });
    expect(opens).toBe(0);
  });

  test("a disposed mirror's read starts no open that shutdown would never close", async () => {
    let opens = 0;
    const mirror = mirrorWith(
      () => undefined,
      async () => undefined,
      () => {
        opens++;
      },
    );
    mirror.dispose();
    expect(await mirror.read(DEVICE)).toBeUndefined();
    expect(await mirror.acquire(DEVICE, ME, live)).toEqual({ outcome: "unavailable" });
    expect(opens).toBe(0);
  });

  test("no registry file leaves the claim to the files", async () => {
    fileExists = false;
    const mirror = mirrorWith(
      () => undefined,
      async () => {
        throw busy();
      },
    );
    expect(await mirror.acquire(DEVICE, ME, live)).toEqual({ outcome: "unavailable" });
  });
});

describe("localPreBindRegistryOpen", () => {
  let timer: FakeTimer;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(10);
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  function opener(
    inputs: {
      preBind?: () => boolean;
      cached?: () => boolean;
      fileExists?: () => boolean;
      result?: () => Promise<unknown>;
    } = {},
  ) {
    const calls: { opens: number; last?: Promise<unknown> } = { opens: 0 };
    const start = localPreBindRegistryOpen({
      preBind: inputs.preBind ?? (() => true),
      openCached: inputs.cached ?? (() => false),
      registryFileExists: inputs.fileExists ?? (() => true),
      open: () => {
        calls.opens++;
        calls.last = (inputs.result ?? (async () => ({})))();
        return calls.last;
      },
      timer,
    });
    /** Lets the latest open settle and the opener record its outcome. */
    const settled = async () => {
      await calls.last?.then(
        () => undefined,
        () => undefined,
      );
    };
    return { start, calls, settled };
  }

  test("starts one open while none is cached or in flight", async () => {
    const pendingOpen = Promise.withResolvers<unknown>();
    const { start, calls, settled } = opener({ result: () => pendingOpen.promise });
    start();
    start();
    expect(calls.opens).toBe(1);
    pendingOpen.resolve({});
    await settled();
    start();
    expect(calls.opens).toBe(2);
  });

  test("declines after bind, with an open cached, or without a registry file", () => {
    for (const declining of [
      opener({ preBind: () => false }),
      opener({ cached: () => true }),
      opener({ fileExists: () => false }),
      opener({
        fileExists: () => {
          throw new Error("EACCES");
        },
      }),
    ]) {
      declining.start();
      expect(declining.calls.opens).toBe(0);
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Cannot check for the host registry file"),
      expect.any(Error),
    );
  });

  test("backs off after consecutive failed opens and resets once one succeeds", async () => {
    let fail = true;
    const { start, calls, settled } = opener({
      result: async () => {
        if (fail) {
          throw busy();
        }
        return {};
      },
    });
    const first = PRE_BIND_REGISTRY_OPEN_BACKOFF.delayForAttempt(1);
    const second = PRE_BIND_REGISTRY_OPEN_BACKOFF.delayForAttempt(2);
    expect(second).toBeGreaterThan(first);

    start();
    await settled();
    timer.advanceTime(first - 1);
    start();
    expect(calls.opens).toBe(1);
    timer.advanceTime(1);
    start();
    expect(calls.opens).toBe(2);
    await settled();

    // The second consecutive failure waits longer.
    timer.advanceTime(first);
    start();
    expect(calls.opens).toBe(2);
    timer.advanceTime(second - first);
    fail = false;
    start();
    expect(calls.opens).toBe(3);
    await settled();

    // A success clears the backoff: the next open (say, after the registry closed) is immediate.
    start();
    expect(calls.opens).toBe(4);
  });
});
