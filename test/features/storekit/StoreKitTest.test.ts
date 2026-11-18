import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  StoreKitTest,
  type StoreKitSender,
  type StoreKitTestInput,
} from "../../../src/features/storekit/StoreKitTest";
import type {
  CtrlProxyStoreKitResult,
  StoreKitRunnerRequest,
  StoreKitTransaction,
} from "../../../src/features/observe/ios/CtrlProxyStoreKit";
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
  constructor(
    private readonly answer: (request: StoreKitRunnerRequest) => CtrlProxyStoreKitResult,
  ) {}

  async requestStoreKit(request: StoreKitRunnerRequest): Promise<CtrlProxyStoreKitResult> {
    this.requests.push(request);
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
  const storeKit = new StoreKitTest(
    () => sender,
    () => kind,
  );
  return { sender, storeKit };
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
});
