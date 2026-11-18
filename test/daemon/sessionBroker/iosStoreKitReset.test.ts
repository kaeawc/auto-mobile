import { describe, expect, test } from "bun:test";
import { IosDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/mutations/iosResetPort";
import { RunnerStoreKitSessionReset } from "../../../src/daemon/sessionBroker/iosStoreKitSessionReset";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type {
  DeviceMutationInput,
  MutationValue,
} from "../../../src/daemon/sessionBroker/mutations/types";
import type { IosStoreKitSessionReset } from "../../../src/daemon/sessionBroker/mutations/storeKitSession";
import { DEVICE_MUTATION_TOOL_COVERAGE } from "../../../src/daemon/sessionBroker/mutations/toolCoverage";
import type {
  CtrlProxyStoreKitResult,
  StoreKitRequestOptions,
  StoreKitRunnerRequest,
} from "../../../src/features/observe/ios/CtrlProxyStoreKit";
import type { StoreKitSender } from "../../../src/features/storekit/StoreKitTest";
import type { BootedDevice } from "../../../src/models";
import { deviceToolMutations } from "../../../src/server/deviceMutationAdapters";
import { StoreKitMutationPriorReader } from "../../../src/server/deviceMutationStoreKitPriorReader";
import { FakeIosResidueInspector } from "../../fakes/FakeIosResidueInspector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { InMemoryStoreKitClearedSessions } from "../../../src/features/storekit/StoreKitClearedSessions";

const UDID = "11111111-2222-4333-8444-555555555555";
const IOS: BootedDevice = { deviceId: UDID, platform: "ios", name: "iPhone" };

class FakeStoreKitSessionReset implements IosStoreKitSessionReset {
  readonly cleared: { deviceId: string; bundleId: string }[] = [];
  error?: Error;

  async clear(deviceId: string, bundleId: string): Promise<void> {
    this.cleared.push({ deviceId, bundleId });
    if (this.error) {
      throw this.error;
    }
  }
}

class FakeStoreKitSender implements StoreKitSender {
  readonly requests: { request: StoreKitRunnerRequest; options?: StoreKitRequestOptions }[] = [];
  constructor(private readonly result: CtrlProxyStoreKitResult) {}

  async requestStoreKit(
    request: StoreKitRunnerRequest,
    options?: StoreKitRequestOptions,
  ): Promise<CtrlProxyStoreKitResult> {
    this.requests.push({ request, options });
    return this.result;
  }
}

function portRig() {
  const storeKit = new FakeStoreKitSessionReset();
  const unused = async () => {
    throw new Error("unused in this test");
  };
  const port = new IosDeviceMutationResetPort(
    {
      simctl: { listAppsOrThrow: unused, executeCommandArgs: unused },
      files: { realpath: unused, remove: unused },
      pasteboard: { assertSettled: () => {}, write: unused },
      privacyGrants: { readServiceRows: unused },
      trustStore: { readUserTrustedCertificates: unused },
      residue: new FakeIosResidueInspector(),
      storeKit,
    },
    new FakeTimer(),
  );
  const context: DeviceMutationResetContext = {
    scope: { deviceId: UDID, incarnation: "generation-1", sessionUuid: "session-a" },
    signal: new AbortController().signal,
    assertOwned: async () => {},
  };
  return { port, context, storeKit };
}

const storeKitRow = (
  priorValue: MutationValue = { state: "absent" },
  key = "com.example.shop",
): DeviceMutationInput => ({ kind: "storekit", key, priorValue, toolName: "storeKitTest" });

describe("storeKitTest journaling", () => {
  test("is a journaled tool", () => {
    expect(DEVICE_MUTATION_TOOL_COVERAGE.storeKitTest?.status).toBe("journaled");
  });

  test.each([
    "load",
    "buy",
    "refund",
    "expire",
    "setTimeRate",
    "setSimulatedError",
    "disableDialogs",
  ])("iOS %s records one storekit row for its appId", (action) => {
    expect(
      deviceToolMutations("storeKitTest", { action, appId: "com.example.shop" }, "ios"),
    ).toEqual([{ kind: "storekit", key: "com.example.shop" }]);
  });

  test("list, clear and other platforms record nothing", () => {
    for (const action of ["list", "clear"]) {
      expect(deviceToolMutations("storeKitTest", { action, appId: "com.example" }, "ios")).toEqual(
        [],
      );
    }
    expect(
      deviceToolMutations("storeKitTest", { action: "buy", appId: "com.example" }, "android"),
    ).toEqual([]);
  });

  test("the prior of an iOS storekit row is absent; other rows and platforms are unobservable", async () => {
    const reader = new StoreKitMutationPriorReader();
    const rows = [
      { kind: "storekit", key: "com.example" },
      { kind: "clipboard", key: "device" },
    ];
    expect(await reader.read(IOS, rows)).toEqual([{ state: "absent" }, { state: "unobservable" }]);
    expect(await reader.read({ ...IOS, platform: "android" }, rows)).toEqual([
      { state: "unobservable" },
      { state: "unobservable" },
    ]);
  });
});

describe("iOS StoreKit reset port", () => {
  test("an absent-prior row reverts by clearing that bundle's session on the device", async () => {
    const { port, context, storeKit } = portRig();
    expect(port.canRevert(storeKitRow())).toBe(true);
    await port.revert(storeKitRow(), context);
    expect(storeKit.cleared).toEqual([{ deviceId: UDID, bundleId: "com.example.shop" }]);
  });

  test("an unobservable or present prior cannot be reverted", () => {
    const { port } = portRig();
    expect(port.canRevert(storeKitRow({ state: "unobservable" }))).toBe(false);
    expect(port.canRevert(storeKitRow({ state: "present", value: "x" }))).toBe(false);
  });

  test("a clear the runner cannot confirm fails the revert so keep-booted reset escalates", async () => {
    const { port, context, storeKit } = portRig();
    storeKit.error = new Error("Not connected to CtrlProxy");
    await expect(port.revert(storeKitRow(), context)).rejects.toThrow("Not connected");
  });
});

describe("runner StoreKit session reset", () => {
  const clear = (result: CtrlProxyStoreKitResult) => {
    const sender = new FakeStoreKitSender(result);
    const devices: BootedDevice[] = [];
    const cleared = new InMemoryStoreKitClearedSessions();
    const reset = new RunnerStoreKitSessionReset((device) => {
      devices.push(device);
      return sender;
    }, cleared);
    return {
      sender,
      devices,
      cleared,
      run: () => reset.clear(UDID, "com.example.shop", new AbortController().signal),
    };
  };
  const NO_SESSION = {
    success: false,
    totalTimeMs: 1,
    error: "no storekit session for bundleId; call load first",
  };

  test("sends clear for the bundle id to the device's runner", async () => {
    const rig = clear({ success: true, totalTimeMs: 1, transactions: [] });
    await rig.run();
    expect(rig.devices).toEqual([{ name: UDID, platform: "ios", deviceId: UDID }]);
    expect(rig.sender.requests[0]?.request).toEqual({
      action: "clear",
      bundleId: "com.example.shop",
    });
    expect(rig.sender.requests[0]?.options?.timeoutMs).toBeGreaterThan(0);
  });

  test("a confirmed clear marks the bundle cleared on that device", async () => {
    const rig = clear({ success: true, totalTimeMs: 1, transactions: [] });
    await rig.run();
    expect(rig.cleared.isCleared(UDID, "com.example.shop")).toBe(true);
  });

  test("no runner session after a confirmed clear with no change since is already clean", async () => {
    const rig = clear(NO_SESSION);
    rig.cleared.markCleared(UDID, "com.example.shop");
    await rig.run();
  });

  test("no runner session without a confirmed clear throws so the reset erases (runner restart)", async () => {
    const rig = clear(NO_SESSION);
    await expect(rig.run()).rejects.toThrow("may still hold its StoreKit state");
    rig.cleared.markCleared(UDID, "com.example.other");
    await expect(rig.run()).rejects.toThrow("may still hold its StoreKit state");
  });

  test.each([
    { success: false, totalTimeMs: 0, error: "Not connected to CtrlProxy" },
    { success: false, totalTimeMs: 0, error: "unknown command", unsupported: true },
    { success: false, totalTimeMs: 0, error: "Timeout waiting for storekit_result" },
  ])("an unconfirmed clear throws ($error)", async (result) => {
    await expect(clear(result).run()).rejects.toThrow("could not be cleared");
  });
});
