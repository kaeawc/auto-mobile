import Foundation

extension AutoMobilePlanExecutor {
    /// A typed refusal the daemon sent instead of running a tool (#11195). Mirrors what the Android
    /// junit-runner reads in `parseDaemonToolResult`. Two wire shapes carry it:
    ///
    /// - the tool-call error shape (`shapeToolCallError`): `{success: false, error: "<message>",
    ///   code, retryable, retryAfterMs, ...}`;
    /// - the session envelope (`sessionOwnershipLostPayload`, `daemonShuttingDownMcpOutcome`):
    ///   `{error: {code, message, retryable, nextAction, retryAfterMs, ...}}`.
    ///
    /// Clients match on `code`, never on the message.
    public struct DaemonRefusal: Sendable, Equatable {
        public let code: String?
        public let message: String
        public let retryable: Bool
        public let nextAction: String?
        public let retryAfterMs: Int?

        public init(code: String?, message: String, retryable: Bool, nextAction: String?, retryAfterMs: Int?) {
            self.code = code
            self.message = message
            self.retryable = retryable
            self.nextAction = nextAction
            self.retryAfterMs = retryAfterMs
        }

        /// The refusal names a terminal session UUID: retry only under a fresh session (#11098).
        public var acquiresNewSession: Bool {
            nextAction == DaemonRefusal.acquireNewSessionNextAction
        }

        /// Whether the runner waits for the device to free up, within the bounded device wait,
        /// instead of failing the attempt. The held-device codes always wait, as on Android;
        /// capacity and discovery refusals wait only when the daemon says they are retryable.
        public var waitsForDevice: Bool {
            guard let code else { return false }
            if DaemonRefusal.deviceWaitCodes.contains(code) { return true }
            return retryable && DaemonRefusal.retryableWaitCodes.contains(code)
        }

        /// How the runner reacts to this refusal; the shared vocabulary of
        /// `test/fixtures/refusal-wire/expectations.json`.
        public enum Disposition: String, Sendable {
            case wait
            case acquireNewSession = "acquire-new-session"
            case retry
            case fail
        }

        public var disposition: Disposition {
            if waitsForDevice { return .wait }
            if acquiresNewSession { return .acquireNewSession }
            return retryable ? .retry : .fail
        }

        static let acquireNewSessionNextAction = "acquire_new_session"

        /// Android's `DEVICE_WAIT_CODES`.
        static let deviceWaitCodes: Set<String> = [
            "device_owned_by_other_session",
            "device_cleanup_in_progress",
            "device_owned_by_other_daemon",
            "device_shutting_down",
        ]

        static let retryableWaitCodes: Set<String> = [
            "capacity_exhausted",
            "discovery_incomplete",
        ]

        /// The refusal in a tool's text payload, or nil when the payload is not one: a plan result
        /// (it reports `executedSteps`), a success, or not a JSON object.
        static func parse(_ text: String) -> DaemonRefusal? {
            guard let data = text.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                // Not JSON: the caller's own decode reports the malformed payload.
                return nil
            }
            return parse(object)
        }

        static func parse(_ object: [String: Any]) -> DaemonRefusal? {
            if object["executedSteps"] != nil { return nil }
            let envelope = object["error"] as? [String: Any]
            guard envelope != nil || (object["success"] as? Bool) == false else { return nil }
            func field(_ key: String) -> Any? {
                envelope?[key] ?? object[key]
            }
            let message = (envelope?["message"] as? String)
                ?? (object["error"] as? String)
                ?? (object["message"] as? String)
                ?? "Daemon refused the request"
            return DaemonRefusal(
                code: field("code") as? String,
                message: message,
                retryable: (field("retryable") as? Bool) == true,
                nextAction: field("nextAction") as? String,
                retryAfterMs: (field("retryAfterMs") as? NSNumber)?.intValue
            )
        }
    }

    /// The bounded wait for a device another session holds, mirroring Android's
    /// `deviceOwnedBackoffDelayMs`: 500 ms doubling to a 4 s cap, within a 30 s total budget. A
    /// `retryAfterMs` hint from the daemon lengthens a step but never extends the budget.
    struct DeviceWaitBackoff: Sendable {
        static let initialDelayMs = 500
        static let maxDelayMs = 4000
        static let defaultBudgetMs = 30000

        let budgetMs: Int
        private(set) var waits = 0
        private(set) var waitedMs = 0

        init(budgetMs: Int = DeviceWaitBackoff.defaultBudgetMs) {
            self.budgetMs = budgetMs
        }

        /// The next delay, recorded as waited, or nil once the budget is spent.
        mutating func nextDelayMs(retryAfterMs: Int?) -> Int? {
            let remaining = budgetMs - waitedMs
            guard remaining > 0 else { return nil }
            let doubled = Self.initialDelayMs << min(waits, 8)
            let backoff = min(doubled, Self.maxDelayMs)
            let delay = min(max(backoff, retryAfterMs ?? 0), remaining)
            waits += 1
            waitedMs += delay
            return delay
        }
    }

    static func deviceWaitGiveUpMessage(_ refusal: DaemonRefusal, waitedMs: Int) -> String {
        let what = switch refusal.code {
        case "device_cleanup_in_progress":
            "Device is still finishing its previous session's cleanup"
        case "device_owned_by_other_daemon":
            "Device is claimed by another AutoMobile daemon"
        case "device_shutting_down":
            "Device is shutting down"
        case "capacity_exhausted":
            "No device capacity is available"
        case "discovery_incomplete":
            "Device discovery has not finished"
        default:
            "Device is held by another session"
        }
        return "\(what) (\(refusal.code ?? "unknown")): \(refusal.message)\n" +
            "The runner waited \(waitedMs)ms for it to be released. Another test attempt or tool session is " +
            "using this device; give each concurrent test its own device, or run them serially."
    }
}
