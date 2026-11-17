import { z } from "zod/v4";
import { defineDeviceTool } from "./defineTool";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { StoreKitTest } from "../features/storekit/StoreKitTest";
import {
  STOREKIT_ACTIONS,
  STOREKIT_SIMULATED_ERRORS,
  STOREKIT_TIME_RATES,
  type StoreKitSimulatedError,
} from "../features/observe/ios/CtrlProxyStoreKit";

const SIMULATED_ERRORS = Object.keys(STOREKIT_SIMULATED_ERRORS) as [
  StoreKitSimulatedError,
  ...StoreKitSimulatedError[],
];

const storeKitTestInput = z.object({
  action: z
    .enum(STOREKIT_ACTIONS)
    .describe(
      "load (configPath) starts a session; buy (productId), refund (transactionId), expire (subscriptionId), setTimeRate (timeRate), setSimulatedError (simulatedError), disableDialogs (enabled), list, clear (ends the session)",
    ),
  appId: z.string().min(1).describe("Bundle id that keys the StoreKit session"),
  configPath: z
    .string()
    .min(1)
    .optional()
    .describe("load: absolute path of a .storekit file on the simulator's Mac"),
  productId: z.string().min(1).optional().describe("buy: product id"),
  transactionId: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("refund: transaction identifier from list"),
  subscriptionId: z.string().min(1).optional().describe("expire: subscription product id"),
  timeRate: z.enum(STOREKIT_TIME_RATES).optional().describe("setTimeRate: renewal time rate"),
  simulatedError: z
    .enum(SIMULATED_ERRORS)
    .optional()
    .describe("setSimulatedError: purchase error for the next buy"),
  enabled: z.boolean().optional().describe("disableDialogs: true suppresses purchase dialogs"),
});

export const storeKitTestResultSchema = z
  .object({
    success: z.boolean(),
    action: z.enum(STOREKIT_ACTIONS),
    appId: z.string(),
    transactions: z
      .array(
        z
          .object({
            identifier: z.number(),
            productId: z.string(),
            state: z.string(),
            originalIdentifier: z.number().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
    unsupported: z
      .enum(["unsupported_platform", "unsupported_device", "unsupported_capability"])
      .optional(),
    error: z.string().optional(),
  })
  .passthrough();

export function createStoreKitTestTool(storeKit: StoreKitTest = new StoreKitTest()) {
  return defineDeviceTool({
    name: "storeKitTest",
    description:
      "Test in-app purchases with StoreKit Testing on an iOS simulator. load a .storekit configuration first (it resets the session, clears transactions and disables purchase dialogs); then buy, refund, expire, setTimeRate, setSimulatedError (unknown, paymentCancelled or storeProductNotAvailable, for the next purchase) or disableDialogs, list the transactions, and clear to end the session. buy, refund, expire, list and clear return transactions. The session is keyed by appId and lasts for the runner's lifetime; StoreKitTest applies it to the runner's target app. Android, other Apple platforms and physical iPhones return unsupported (unsupported_platform or unsupported_device) without a device call; a runner without request_storekit returns unsupported_capability.",
    input: storeKitTestInput,
    handler: async (device, args, _progress, signal) => {
      const result = await storeKit.run(device, { ...args, ...(signal ? { signal } : {}) });
      return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
    },
    options: {
      ...PLAN_RELEVANT,
      defaultEnabled: false,
      outputSchema: storeKitTestResultSchema,
      deviceReadOnly: (args) => args.action === "list",
      deviceReadOnlyArgs: [{ argument: "action", values: ["list"] }],
    },
  });
}

export function registerStoreKitTestTool(storeKit?: StoreKitTest) {
  createStoreKitTestTool(storeKit).register();
}
