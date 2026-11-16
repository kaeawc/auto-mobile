import Foundation

/// `request_storekit` controls simulator-only StoreKitTest sessions retained by bundleId
/// for the runner process lifetime. Required fields: action (load, buy, refund, expire,
/// setTimeRate, setSimulatedError, disableDialogs, clear, list), bundleId. Optional:
/// requestId; configPath (load: absolute readable .storekit file); productId (buy);
/// transactionId (refund: nonnegative integer); subscriptionId (expire: product id);
/// timeRate (setTimeRate): realTime, monthlyRenewalEveryHour,
/// monthlyRenewalEveryThirtyMinutes, monthlyRenewalEveryFifteenMinutes,
/// monthlyRenewalEveryFiveMinutes, monthlyRenewalEveryThirtySeconds,
/// oneRenewalEveryFifteenMinutes, oneRenewalEveryFiveMinutes, oneRenewalEveryMinute,
/// oneRenewalEveryThirtySeconds, oneRenewalEveryTenSeconds, oneRenewalEveryTwoSeconds;
/// simulatedError (setSimulatedError:
/// SKError codes 0 unknown, 2 paymentCancelled, 5 storeProductNotAvailable);
/// enabled (disableDialogs). Simulated errors target the purchase API only, mapping
/// those codes to StoreKitError unknown/userCancelled/notAvailableInStorefront.
/// Concurrent operations on the same bundleId fail until the active operation completes.
/// The error is cleared after the next runner buy attempt (including failure); for
/// app-initiated purchases the SDK override lasts until clear or reload.
/// Load resets defaults, clears transactions, then disables dialogs. Other actions
/// require load first. Clear resets, clears, returns the final list, and drops the session.
/// Device finding: StoreKitTest attributes session state to the runner's UI-test target app
/// (`dev.jasonpearson.automobile.ctrlproxy` today), not to `bundleId`, which only keys the
/// in-runner session slot. An app sees the state only when it runs under that target bundle id
/// or the runner is launched with that app as its xctestrun UITargetAppPath.
/// Response `storekit_result`: requestId?, success, action, bundleId, error?, totalTimeMs,
/// transactions? [{identifier: Int, productId: String, state: purchased|purchasing|failed|
/// restored|deferred|unknown, originalIdentifier: Int?}]. List/buy/refund/expire/clear
/// return transactions. Unsupported platforms return an error beginning `unsupported:`.
public struct RequestStoreKit: Decodable, Sendable, CommandPayload {
    public var requestId: String?
    public var action: String
    public var bundleId: String
    public var configPath: String?
    public var productId: String?
    public var transactionId: Int?
    public var subscriptionId: String?
    public var timeRate: String?
    public var simulatedError: Int?
    public var enabled: Bool?
}
