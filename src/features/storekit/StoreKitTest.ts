import { isAbsolute } from "node:path";
import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { iosCtrlProxyClientFor } from "../observe/ios/iosCtrlProxyClientFor";
import {
  STOREKIT_SIMULATED_ERRORS,
  type CtrlProxyStoreKitResult,
  type StoreKitAction,
  type StoreKitRequestOptions,
  type StoreKitRunnerRequest,
  type StoreKitSimulatedError,
  type StoreKitTimeRate,
  type StoreKitTransaction,
} from "../observe/ios/CtrlProxyStoreKit";
import {
  resolveIosDeviceKind,
  type IosDeviceKind,
} from "../../utils/ios-cmdline-tools/IosDeviceKind";

/**
 * StoreKit Testing for in-app purchases (#18399, spike #14108): loads a `.storekit` configuration
 * into the iOS simulator runner's `SKTestSession` and buys, refunds, expires and lists
 * transactions there. StoreKit Testing is simulator-only, so Android, other Apple platforms and
 * physical iPhones get a typed `unsupported` result instead of a device call.
 */

export interface StoreKitTestInput {
  action: StoreKitAction;
  /** Keys the runner's session; one session per appId for the runner's lifetime. */
  appId: string;
  configPath?: string;
  productId?: string;
  transactionId?: number;
  subscriptionId?: string;
  timeRate?: StoreKitTimeRate;
  simulatedError?: StoreKitSimulatedError;
  enabled?: boolean;
  signal?: AbortSignal;
}

export type StoreKitUnsupportedCode =
  | "unsupported_platform"
  | "unsupported_device"
  | "unsupported_capability";

export interface StoreKitTestResult {
  success: boolean;
  action: StoreKitAction;
  appId: string;
  transactions?: StoreKitTransaction[];
  /** Set when StoreKit Testing cannot run on this target or runner; nothing was changed. */
  unsupported?: StoreKitUnsupportedCode;
  error?: string;
}

/** The narrow runner seam StoreKit Testing needs. */
export interface StoreKitSender {
  requestStoreKit(
    request: StoreKitRunnerRequest,
    options?: StoreKitRequestOptions,
  ): Promise<CtrlProxyStoreKitResult>;
}

export type StoreKitSenderFactory = (device: BootedDevice) => StoreKitSender;
export type IosDeviceKindResolver = (device: BootedDevice) => IosDeviceKind;

const UNSUPPORTED_PREFIX = "unsupported:";

const OUTDATED_RUNNER_ERROR =
  "storeKitTest needs an AutoMobile iOS runner that supports request_storekit; restart the " +
  "daemon so it installs the current runner";

/** The argument each action needs, checked before any device call. */
const REQUIRED_ARGUMENT: Partial<Record<StoreKitAction, keyof StoreKitTestInput>> = {
  load: "configPath",
  buy: "productId",
  refund: "transactionId",
  expire: "subscriptionId",
  setTimeRate: "timeRate",
  setSimulatedError: "simulatedError",
  disableDialogs: "enabled",
};

export function validateStoreKitInput(input: StoreKitTestInput): void {
  const required = REQUIRED_ARGUMENT[input.action];
  if (required && input[required] === undefined) {
    throw new ActionableError(`storeKitTest ${input.action} requires ${required}.`);
  }
  const { configPath } = input;
  if (
    input.action === "load" &&
    configPath !== undefined &&
    (!isAbsolute(configPath) || !configPath.endsWith(".storekit"))
  ) {
    throw new ActionableError(
      `storeKitTest load needs an absolute path to a .storekit file; got ${configPath}.`,
    );
  }
}

/** The runner payload for a validated input: only the fields its action reads. */
export function toRunnerRequest(input: StoreKitTestInput): StoreKitRunnerRequest {
  const request: StoreKitRunnerRequest = { action: input.action, bundleId: input.appId };
  switch (input.action) {
    case "load":
      return { ...request, configPath: input.configPath };
    case "buy":
      return { ...request, productId: input.productId };
    case "refund":
      return { ...request, transactionId: input.transactionId };
    case "expire":
      return { ...request, subscriptionId: input.subscriptionId };
    case "setTimeRate":
      return { ...request, timeRate: input.timeRate };
    case "setSimulatedError":
      return {
        ...request,
        simulatedError:
          input.simulatedError === undefined
            ? undefined
            : STOREKIT_SIMULATED_ERRORS[input.simulatedError],
      };
    case "disableDialogs":
      return { ...request, enabled: input.enabled };
    case "clear":
    case "list":
      return request;
  }
}

function unsupportedReason(
  device: BootedDevice,
  kindOf: IosDeviceKindResolver,
): { code: StoreKitUnsupportedCode; error: string } | undefined {
  if (device.platform !== "ios") {
    return {
      code: "unsupported_platform",
      error: `StoreKit Testing is iOS-only; ${device.platform} has no StoreKit test session. Use an iOS simulator.`,
    };
  }
  if (kindOf(device) !== "simulator") {
    return {
      code: "unsupported_device",
      error:
        "StoreKit Testing runs only on an iOS simulator; physical iPhones use the App Store sandbox. Use an iOS simulator.",
    };
  }
  return undefined;
}

export class StoreKitTest {
  constructor(
    private readonly senderFactory: StoreKitSenderFactory = iosCtrlProxyClientFor,
    private readonly kindOf: IosDeviceKindResolver = resolveIosDeviceKind,
  ) {}

  async run(device: BootedDevice, input: StoreKitTestInput): Promise<StoreKitTestResult> {
    validateStoreKitInput(input);
    const base = { action: input.action, appId: input.appId };
    const unsupported = unsupportedReason(device, this.kindOf);
    if (unsupported) {
      return { ...base, success: false, unsupported: unsupported.code, error: unsupported.error };
    }
    const result = await this.senderFactory(device).requestStoreKit(
      toRunnerRequest(input),
      input.signal ? { signal: input.signal } : {},
    );
    if (result.unsupported) {
      const detail = result.error ? ` (${result.error})` : "";
      return {
        ...base,
        success: false,
        unsupported: "unsupported_capability",
        error: `${OUTDATED_RUNNER_ERROR}${detail}.`,
      };
    }
    if (!result.success && result.error?.startsWith(UNSUPPORTED_PREFIX)) {
      return { ...base, success: false, unsupported: "unsupported_device", error: result.error };
    }
    return {
      ...base,
      success: result.success,
      ...(result.transactions ? { transactions: result.transactions } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  }
}
