/**
 * The runner's `request_storekit` command (#18399): StoreKitTest (`SKTestSession`) control on an
 * iOS simulator runner. Field names and values mirror `RequestStoreKit.swift` and
 * `StoreKitResultResponse.swift` in `ios/control-proxy/Sources/CtrlProxy/`.
 */

import { sendCommand } from "../DeviceServiceUtils";
import type { BaseResult } from "../shared/types";
import type { DelegateContext } from "./types";

export const STOREKIT_ACTIONS = [
  "load",
  "buy",
  "refund",
  "expire",
  "setTimeRate",
  "setSimulatedError",
  "disableDialogs",
  "clear",
  "list",
] as const;

export type StoreKitAction = (typeof STOREKIT_ACTIONS)[number];

/** The nondeprecated `SKTestSession.TimeRate` names the runner accepts. */
export const STOREKIT_TIME_RATES = [
  "realTime",
  "monthlyRenewalEveryHour",
  "monthlyRenewalEveryThirtyMinutes",
  "monthlyRenewalEveryFifteenMinutes",
  "monthlyRenewalEveryFiveMinutes",
  "monthlyRenewalEveryThirtySeconds",
  "oneRenewalEveryFifteenMinutes",
  "oneRenewalEveryFiveMinutes",
  "oneRenewalEveryMinute",
  "oneRenewalEveryThirtySeconds",
  "oneRenewalEveryTenSeconds",
  "oneRenewalEveryTwoSeconds",
] as const;

export type StoreKitTimeRate = (typeof STOREKIT_TIME_RATES)[number];

/** SKError codes the runner can simulate for the purchase API, by name. */
export const STOREKIT_SIMULATED_ERRORS = {
  unknown: 0,
  paymentCancelled: 2,
  storeProductNotAvailable: 5,
} as const;

export type StoreKitSimulatedError = keyof typeof STOREKIT_SIMULATED_ERRORS;

/** The `request_storekit` payload, without the envelope's `type` and `requestId`. */
export interface StoreKitRunnerRequest {
  action: StoreKitAction;
  /** Keys the runner's session slot; StoreKitTest attributes state to the runner's target app. */
  bundleId: string;
  /** load: absolute path of a readable `.storekit` file on the host running the simulator. */
  configPath?: string;
  /** buy: product id. */
  productId?: string;
  /** refund: nonnegative transaction identifier. */
  transactionId?: number;
  /** expire: subscription product id. */
  subscriptionId?: string;
  timeRate?: StoreKitTimeRate;
  /** setSimulatedError: SKError code 0, 2 or 5. */
  simulatedError?: number;
  /** disableDialogs. */
  enabled?: boolean;
}

export type StoreKitTransactionState =
  | "purchased"
  | "purchasing"
  | "failed"
  | "restored"
  | "deferred"
  | "unknown";

export interface StoreKitTransaction {
  identifier: number;
  productId: string;
  state: StoreKitTransactionState;
  originalIdentifier?: number | null;
}

/** The runner's `storekit_result`. */
export interface CtrlProxyStoreKitResult extends BaseResult {
  action?: string;
  bundleId?: string;
  transactions?: StoreKitTransaction[];
  /** The connected runner predates `request_storekit`. */
  unsupported?: boolean;
}

export const STOREKIT_TIMEOUT_MS = 15_000;

export interface StoreKitRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function requestStoreKit(
  context: DelegateContext,
  request: StoreKitRunnerRequest,
  options: StoreKitRequestOptions = {},
): Promise<CtrlProxyStoreKitResult> {
  const failure = (
    error: string,
    extra: Partial<CtrlProxyStoreKitResult> = {},
  ): CtrlProxyStoreKitResult => ({ success: false, totalTimeMs: 0, error, ...extra });
  return sendCommand<CtrlProxyStoreKitResult>(context, {
    idPrefix: "storeKit",
    responseType: "storekit_result",
    messageType: "request_storekit",
    params: { ...request },
    timeoutMs: options.timeoutMs ?? STOREKIT_TIMEOUT_MS,
    abortSignal: options.signal,
    cancelScreenshotBackoff: false,
    notConnectedError: () => failure("Not connected to CtrlProxy"),
    unsupportedCommandError: (_type, error) => failure(error, { unsupported: true }),
    // A runner-reported failure (no session, bad parameter) is not an outdated runner.
    responseError: (error, totalTimeMs) => failure(error, { totalTimeMs }),
    timeoutError: () => failure("Timeout waiting for storekit_result"),
  });
}
