import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  StoreKitTest,
  type StoreKitSender,
  type StoreKitTestInput,
} from "../../../src/features/storekit/StoreKitTest";
import type {
  CtrlProxyStoreKitResult,
  StoreKitRequestOptions,
  StoreKitRunnerRequest,
  StoreKitTransaction,
} from "../../../src/features/observe/ios/CtrlProxyStoreKit";
import { InMemoryStoreKitClearedSessions } from "../../../src/features/storekit/StoreKitClearedSessions";
import { runWithToolSelectionContext } from "../../../src/features/toolSelection/toolSelectionContext";
import type { IosDeviceKind } from "../../../src/utils/ios-cmdline-tools/IosDeviceKind";
import { createStoreKitTestTool } from "../../../src/server/storeKitTestTool";
import type { ToolRegistrar } from "../../../src/server/defineTool";
import type { DeviceAwareToolRegistration } from "../../../src/server/toolRegistry";
import { deviceAwareHandler } from "../../helpers/registeredHandler";

const simulator: BootedDevice = {
  name: "iPhone 17",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};
const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const tv: BootedDevice = { name: "Apple TV", platform: "tvos", deviceId: "TV-UDID" };

const purchase: StoreKitTransaction = {
  identifier: 1,
  productId: "com.example.pro",
  state: "purchased",
  originalIdentifier: null,
};

/** Records every runner request and answers with a scripted result. */
class FakeStoreKitSender implements StoreKitSender {
  readonly requests: StoreKitRunnerRequest[] = [];
  readonly options: (StoreKitRequestOptions | undefined)[] = [];
  constructor(
    private readonly answer: (request: StoreKitRunnerRequest) => CtrlProxyStoreKitResult,
  ) {}

  async requestStoreKit(
    request: StoreKitRunnerRequest,
    options?: StoreKitRequestOptions,
  ): Promise<CtrlProxyStoreKitResult> {
    this.requests.push(request);
    this.options.push(options);
    return this.answer(request);
  }
}

function harness(
  kind: IosDeviceKind = "simulator",
  answer: (request: StoreKitRunnerRequest) => CtrlProxyStoreKitResult = (request) => ({
    success: true,
    totalTimeMs: 3,
    action: request.action,
    bundleId: request.bundleId,
    ...(["buy", "refund", "expire", "list", "clear"].includes(request.action)
      ? { transactions: [purchase] }
      : {}),
  }),
) {
  const sender = new FakeStoreKitSender(answer);
  const cleared = new InMemoryStoreKitClearedSessions();
  const storeKit = new StoreKitTest(
    () => sender,
    () => kind,
    cleared,
  );
  return { sender, storeKit, cleared };
}

const appId = "com.example.app";

describe("StoreKitTest actions", () => {
  const cases: [StoreKitTestInput, StoreKitRunnerRequest, boolean][] = [
    [
      { action: "load", appId, configPath: "/tmp/Products.storekit" },
      { action: "load", bundleId: appId, configPath: "/tmp/Products.storekit" },
      false,
    ],
    [
      { action: "buy", appId, productId: "com.example.pro" },
      { action: "buy", bundleId: appId, productId: "com.example.pro" },
      true,
    ],
    [
      { action: "refund", appId, transactionId: 1 },
      { action: "refund", bundleId: appId, transactionId: 1 },
      true,
    ],
    [
      { action: "expire", appId, subscriptionId: "com.example.monthly" },
      { action: "expire", bundleId: appId, subscriptionId: "com.example.monthly" },
      true,
    ],
    [
      { action: "setTimeRate", appId, timeRate: "oneRenewalEveryTenSeconds" },
      { action: "setTimeRate", bundleId: appId, timeRate: "oneRenewalEveryTenSeconds" },
      false,
    ],
    [
      { action: "setSimulatedError", appId, simulatedError: "paymentCancelled" },
      { action: "setSimulatedError", bundleId: appId, simulatedError: 2 },
      false,
    ],
    [
      { action: "disableDialogs", appId, enabled: false },
      { action: "disableDialogs", bundleId: appId, enabled: false },
      false,
    ],
    [{ action: "list", appId }, { action: "list", bundleId: appId }, true],
    [{ action: "clear", appId }, { action: "clear", bundleId: appId }, true],
  ];

  for (const [input, request, returnsTransactions] of cases) {
    test(`${input.action} sends only its own fields and maps the result`, async () => {
      const { sender, storeKit } = harness();
      const result = await storeKit.run(simulator, { ...input, productId: input.productId });
      expect(sender.requests).toEqual([request]);
      expect(result).toEqual({
        success: true,
        action: input.action,
        appId,
        ...(returnsTransactions ? { transactions: [purchase] } : {}),
      });
    });
  }

  test("drops arguments that belong to another action", async () => {
    const { sender, storeKit } = harness();
    await storeKit.run(simulator, { action: "list", appId, productId: "ignored", enabled: true });
    expect(sender.requests).toEqual([{ action: "list", bundleId: appId }]);
  });

  test("maps every simulated error name to its SKError code", async () => {
    const { sender, storeKit } = harness();
    for (const simulatedError of ["unknown", "paymentCancelled", "storeProductNotAvailable"]) {
      await storeKit.run(simulator, {
        action: "setSimulatedError",
        appId,
        simulatedError: simulatedError as StoreKitTestInput["simulatedError"],
      });
    }
    expect(sender.requests.map((request) => request.simulatedError)).toEqual([0, 2, 5]);
  });

  test("passes a runner failure through without marking it unsupported", async () => {
    const { storeKit } = harness("simulator", () => ({
      success: false,
      totalTimeMs: 1,
      error: "no storekit session for bundleId; call load first",
    }));
    expect(await storeKit.run(simulator, { action: "list", appId })).toEqual({
      success: false,
      action: "list",
      appId,
      error: "no storekit session for bundleId; call load first",
    });
  });
});

describe("StoreKitTest dispatch state", () => {
  test("a timed-out buy the runner received is reported as not retryable", async () => {
    const error = "Timeout waiting for storekit_result; the buy was sent and may still apply";
    const { storeKit } = harness("simulator", () => ({
      success: false,
      totalTimeMs: 0,
      error,
      dispatched: true,
      retryable: false,
    }));
    expect(await storeKit.run(simulator, { action: "buy", appId, productId: "p" })).toEqual({
      success: false,
      action: "buy",
      appId,
      error,
      retryable: false,
    });
  });

  test("a connect-only call asks the runner seam for the open socket only", async () => {
    const { sender, storeKit } = harness();
    await storeKit.run(simulator, { action: "list", appId, connectOnly: true });
    await storeKit.run(simulator, { action: "list", appId });
    expect(sender.options).toEqual([{ requireExistingConnection: true }, {}]);
  });
});

describe("StoreKitTest cleared-session ledger", () => {
  const deviceId = simulator.deviceId;

  test("a confirmed clear marks the bundle cleared; a later mutation unmarks it first", async () => {
    const { storeKit, cleared } = harness();
    await storeKit.run(simulator, { action: "clear", appId });
    expect(cleared.isCleared(deviceId, appId)).toBe(true);
    await storeKit.run(simulator, { action: "list", appId });
    expect(cleared.isCleared(deviceId, appId)).toBe(true);
    await storeKit.run(simulator, { action: "buy", appId, productId: "p" });
    expect(cleared.isCleared(deviceId, appId)).toBe(false);
  });

  test("a failed clear marks nothing and does not unmark an earlier clear", async () => {
    const { storeKit, cleared } = harness("simulator", () => ({
      success: false,
      totalTimeMs: 1,
      error: "no storekit session for bundleId; call load first",
    }));
    await storeKit.run(simulator, { action: "clear", appId });
    expect(cleared.isCleared(deviceId, appId)).toBe(false);
    cleared.markCleared(deviceId, appId);
    await storeKit.run(simulator, { action: "clear", appId });
    expect(cleared.isCleared(deviceId, appId)).toBe(true);
  });

  test("a mutation the runner refuses still unmarks the bundle", async () => {
    const { storeKit, cleared } = harness("simulator", () => ({
      success: false,
      totalTimeMs: 0,
      error: "Timeout waiting for storekit_result",
    }));
    cleared.markCleared(deviceId, appId);
    await storeKit.run(simulator, { action: "load", appId, configPath: "/tmp/P.storekit" });
    expect(cleared.isCleared(deviceId, appId)).toBe(false);
  });
});

describe("StoreKitTest validation", () => {
  const missing: [StoreKitTestInput, string][] = [
    [{ action: "load", appId }, "configPath"],
    [{ action: "buy", appId }, "productId"],
    [{ action: "refund", appId }, "transactionId"],
    [{ action: "expire", appId }, "subscriptionId"],
    [{ action: "setTimeRate", appId }, "timeRate"],
    [{ action: "setSimulatedError", appId }, "simulatedError"],
    [{ action: "disableDialogs", appId }, "enabled"],
  ];

  for (const [input, argument] of missing) {
    test(`${input.action} without ${argument} fails before any device call`, async () => {
      const { sender, storeKit } = harness();
      await expect(storeKit.run(simulator, input)).rejects.toThrow(
        `storeKitTest ${input.action} requires ${argument}.`,
      );
      expect(sender.requests).toEqual([]);
    });
  }

  test("load refuses a relative or non-.storekit config path", async () => {
    const { sender, storeKit } = harness();
    for (const configPath of ["Products.storekit", "/tmp/Products.json"]) {
      await expect(storeKit.run(simulator, { action: "load", appId, configPath })).rejects.toThrow(
        "absolute path to a .storekit file",
      );
    }
    expect(sender.requests).toEqual([]);
  });
});

describe("StoreKitTest unsupported results", () => {
  test("Android and other Apple platforms are unsupported_platform with no device call", async () => {
    for (const device of [android, tv]) {
      const { sender, storeKit } = harness();
      const result = await storeKit.run(device, { action: "list", appId });
      expect(result).toMatchObject({
        success: false,
        action: "list",
        appId,
        unsupported: "unsupported_platform",
      });
      expect(result.error).toContain(device.platform);
      expect(sender.requests).toEqual([]);
    }
  });

  test("a physical iPhone is unsupported_device with no device call", async () => {
    const { sender, storeKit } = harness("physical");
    const result = await storeKit.run(simulator, { action: "buy", appId, productId: "p" });
    expect(result).toMatchObject({ success: false, unsupported: "unsupported_device" });
    expect(result.error).toContain("iOS simulator");
    expect(sender.requests).toEqual([]);
  });

  test("a runner without request_storekit is unsupported_capability", async () => {
    const { storeKit } = harness("simulator", () => ({
      success: false,
      totalTimeMs: 0,
      error: "request_storekit is not supported by the connected device service",
      unsupported: true,
    }));
    const result = await storeKit.run(simulator, { action: "list", appId });
    expect(result).toMatchObject({ success: false, unsupported: "unsupported_capability" });
    expect(result.error).toContain("restart the daemon");
  });

  test("the runner's own unsupported: error is unsupported_device", async () => {
    const error = "unsupported: StoreKitTest requires an iOS simulator runner";
    const { storeKit } = harness("simulator", () => ({ success: false, totalTimeMs: 0, error }));
    expect(await storeKit.run(simulator, { action: "list", appId })).toEqual({
      success: false,
      action: "list",
      appId,
      unsupported: "unsupported_device",
      error,
    });
  });
});

describe("storeKitTest tool", () => {
  test("registers off by default, list as the only device read, and runs the feature", async () => {
    let registered: DeviceAwareToolRegistration<unknown> | undefined;
    const registrar = {
      register: () => {},
      registerDeviceAware: (_name, _description, _schema, registration) => {
        if (typeof registration !== "function") {
          registered = registration as DeviceAwareToolRegistration<unknown>;
        }
      },
    } as ToolRegistrar;
    const { sender, storeKit } = harness();
    createStoreKitTestTool(storeKit).register(registrar);
    expect(registered?.defaultEnabled).toBe(false);
    expect(registered?.deviceReadOnlyArgs).toEqual([{ argument: "action", values: ["list"] }]);
    const readOnly = registered?.deviceReadOnly;
    expect(typeof readOnly === "function" && readOnly({ action: "list" })).toBe(true);
    expect(typeof readOnly === "function" && readOnly({ action: "buy" })).toBe(false);
    const handler = deviceAwareHandler(registered!);
    const response = (await Reflect.apply(handler, undefined, [
      simulator,
      { action: "list", appId },
    ])) as { structuredContent?: unknown };
    expect(response.structuredContent).toMatchObject({ success: true, transactions: [purchase] });
    expect(sender.requests).toEqual([{ action: "list", bundleId: appId }]);
  });

  test("the schema rejects an unknown simulated error and a negative transaction id", () => {
    const { schema } = createStoreKitTestTool(harness().storeKit);
    expect(
      schema.safeParse({ action: "setSimulatedError", appId, simulatedError: "nope" }).success,
    ).toBe(false);
    expect(schema.safeParse({ action: "refund", appId, transactionId: -1 }).success).toBe(false);
    expect(schema.safeParse({ action: "list", appId }).success).toBe(true);
  });

  test("the schema enforces the published appId contract", () => {
    const { schema } = createStoreKitTestTool(harness().storeKit);
    for (const bad of ["com.example app", "", "a".repeat(257), "com/example"]) {
      expect(schema.safeParse({ action: "list", appId: bad }).success).toBe(false);
    }
  });

  test("a sessionless read of a held device runs list connect-only", async () => {
    let registered: DeviceAwareToolRegistration<unknown> | undefined;
    const registrar = {
      register: () => {},
      registerDeviceAware: (_name, _description, _schema, registration) => {
        if (typeof registration !== "function") {
          registered = registration as DeviceAwareToolRegistration<unknown>;
        }
      },
    } as ToolRegistrar;
    const { sender, storeKit } = harness();
    createStoreKitTestTool(storeKit).register(registrar);
    const handler = deviceAwareHandler(registered!);
    await runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
      Reflect.apply(handler, undefined, [simulator, { action: "list", appId }]),
    );
    await Reflect.apply(handler, undefined, [simulator, { action: "list", appId }]);
    expect(sender.options.map((options) => options?.requireExistingConnection)).toEqual([
      true,
      undefined,
    ]);
  });
});
