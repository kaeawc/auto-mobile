import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { localClaimRegistryExpectation } from "../../src/daemon/deviceClaimRegistryExpectation";
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
    for (const error of [undefined, busy(), new Error("disk I/O error"), new Error("timed out")]) {
      expect(expectation({ fileExists: true })(error)).toBe(true);
    }
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
    expect(expect_(undefined)).toBe(true);
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
  ) {
    return new StoreDeviceClaimMirror({
      platform: "android",
      store,
      ...(whenOpen ? { whenOpen } : {}),
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

  test("no registry file leaves the claim to the files", async () => {
    fileExists = false;
    const mirror = mirrorWith(
      () => undefined,
      async () => undefined,
    );
    expect(await mirror.acquire(DEVICE, ME, live)).toEqual({ outcome: "unavailable" });
  });
});
