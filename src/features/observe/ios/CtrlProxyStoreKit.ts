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
  /** Set on a timeout after the request frame was written: the runner may still apply it. */
  dispatched?: boolean;
}

export const STOREKIT_TIMEOUT_MS = 15_000;

export interface StoreKitRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Use the runner's open socket only, never connect or set the runner up: a sessionless read of
   * a device another session holds must not ready it (#10830).
   */
  requireExistingConnection?: boolean;
}

/** Actions that change no StoreKit state, so an unanswered request is safe to repeat. */
const REPEATABLE_ACTIONS: ReadonlySet<StoreKitAction> = new Set(["list", "clear"]);

export async function requestStoreKit(
  context: DelegateContext,
  request: StoreKitRunnerRequest,
  options: StoreKitRequestOptions = {},
): Promise<CtrlProxyStoreKitResult> {
  const failure = (
    error: string,
    extra: Partial<CtrlProxyStoreKitResult> = {},
  ): CtrlProxyStoreKitResult => ({ success: false, totalTimeMs: 0, error, ...extra });
  let dispatched = false;
  return sendCommand<CtrlProxyStoreKitResult>(context, {
    idPrefix: "storeKit",
    responseType: "storekit_result",
    messageType: "request_storekit",
    params: { ...request },
    timeoutMs: options.timeoutMs ?? STOREKIT_TIMEOUT_MS,
    abortSignal: options.signal,
    cancelScreenshotBackoff: false,
    ...(options.requireExistingConnection ? { requireExistingConnection: true } : {}),
    onDispatch: () => {
      dispatched = true;
    },
    notConnectedError: () =>
      failure(
        options.requireExistingConnection
          ? "Not connected to CtrlProxy; another session holds this device, so this read uses the runner's open connection only and does not start the runner"
          : "Not connected to CtrlProxy",
      ),
    unsupportedCommandError: (_type, error) => failure(error, { unsupported: true }),
    // A runner-reported failure (no session, bad parameter) is not an outdated runner.
    responseError: (error, totalTimeMs) => failure(error, { totalTimeMs }),
    // An unanswered mutation may still apply (a buy can complete): say so, and do not invite a retry.
    timeoutError: () =>
      failure(
        dispatched && !REPEATABLE_ACTIONS.has(request.action)
          ? `Timeout waiting for storekit_result; the ${request.action} was sent and may still apply, so check list before retrying`
          : "Timeout waiting for storekit_result",
        dispatched && !REPEATABLE_ACTIONS.has(request.action)
          ? { dispatched: true, retryable: false }
          : {},
      ),
  });
}
