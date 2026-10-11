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
                retryAfterMs: DeviceWaitBackoff.usableHintMs(wire: field("retryAfterMs"))
            )
        }
    }

    /// The bounded wait for a device another session holds, mirroring Android's
    /// `deviceOwnedBackoffDelayMs`: 500 ms doubling to a 4 s cap, within a 30 s total budget. A
    /// `retryAfterMs` hint from the daemon lengthens a step for every code except the finalize codes
    /// (`device_cleanup_in_progress`, `device_shutting_down`). For those it is the finalize time
    /// still remaining: it bounds the total wait (up to 150 s, #11360) while each step stays on the
    /// ordinary backoff, so a finalize that ends early is noticed on the next poll (#11538).
    struct DeviceWaitBackoff: Sendable {
        static let initialDelayMs = 500
        static let maxDelayMs = 4000
        static let defaultBudgetMs = 30000
        /// Android's `DEVICE_FINALIZE_WAIT_CAP_MS`: bounds a runaway finalize hint (#11360).
        static let finalizeWaitCapMs = 150_000
        /// Android's `FINALIZE_WAIT_CODES`: refusals whose `retryAfterMs` is the daemon's real
        /// finalize time, not a polling hint.
        static let finalizeWaitCodes: Set<String> = ["device_cleanup_in_progress", "device_shutting_down"]

        let budgetMs: Int
        private(set) var waits: Int
        private(set) var waitedMs: Int

        init(budgetMs: Int = DeviceWaitBackoff.defaultBudgetMs, waits: Int = 0, waitedMs: Int = 0) {
            self.budgetMs = budgetMs
            self.waits = waits
            self.waitedMs = waitedMs
        }

        /// A wire `retryAfterMs` as the runners use it: nil when absent, not a whole number, zero or
        /// negative; otherwise clamped to `finalizeWaitCapMs` so adding it to a waited time cannot
        /// overflow (#11544). Android's `positiveRetryAfterMs`.
        static func usableHintMs(wire: Any?) -> Int? {
            guard let number = wire as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            if CFNumberIsFloatType(number) {
                // Beyond the Int64 range Android's `longOrNull` finds no number, so it is absent here too.
                let value = number.doubleValue
                guard value.isFinite, value > 0, value < 9.2e18, value == value.rounded() else { return nil }
                return Int(min(value, Double(finalizeWaitCapMs)))
            }
            guard number.compare(NSNumber(value: Int64.max)) != .orderedDescending else { return nil }
            let value = number.int64Value
            guard value > 0 else { return nil }
            return Int(min(value, Int64(finalizeWaitCapMs)))
        }

        static func usableHintMs(_ hint: Int?) -> Int? {
            guard let hint, hint > 0 else { return nil }
            return min(hint, finalizeWaitCapMs)
        }

        /// Total wait budget for this refusal: `budgetMs`, stretched for the finalize codes to the
        /// time already waited plus the daemon's remaining-finalize `retryAfterMs`, clamped to
        /// `finalizeWaitCapMs` (#11360, #11538). Android's `deviceOwnedBudgetMs`.
        private func effectiveBudgetMs(retryAfterMs: Int?, code: String?) -> Int {
            guard let code, Self.finalizeWaitCodes.contains(code), let hintMs = Self.usableHintMs(retryAfterMs)
            else { return budgetMs }
            return max(budgetMs, min(waitedMs + hintMs, Self.finalizeWaitCapMs))
        }

        /// The next delay, recorded as waited, or nil once the budget is spent.
        mutating func nextDelayMs(retryAfterMs: Int?, code: String? = nil) -> Int? {
            let remaining = effectiveBudgetMs(retryAfterMs: retryAfterMs, code: code) - waitedMs
            guard remaining > 0 else { return nil }
            let doubled = Self.initialDelayMs << min(waits, 8)
            let backoff = min(doubled, Self.maxDelayMs)
            let isFinalize = code.map(Self.finalizeWaitCodes.contains) ?? false
            let hint = isFinalize ? 0 : (Self.usableHintMs(retryAfterMs) ?? 0)
            let delay = min(max(backoff, hint), remaining)
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
