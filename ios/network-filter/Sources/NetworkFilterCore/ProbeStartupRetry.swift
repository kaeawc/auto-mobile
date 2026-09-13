import Foundation

/// A failure observed while the controller is making its first authenticated
/// read-back, distinguished by where it surfaced.
///
/// `saveToPreferences` acknowledges the configuration as soon as the preference
/// is written, which can be before macOS has launched the provider and resumed
/// its XPC listener. Until then the connection itself fails; once the listener
/// is up but `startFilter` has not completed, the reply fails instead. Both are
/// startup races, not verdicts about the filter.
public enum ProbeStartupFailure {
    /// The XPC connection's error handler fired before any reply was delivered.
    case connection(NSError)
    /// The provider replied, with this error message (`nil` when the payload
    /// itself was unusable).
    case readback(String?)
}

public enum ProbeStartupTransience {
    /// Connection errors that mean "the provider has not resumed its listener
    /// yet" rather than a protocol or payload rejection.
    ///
    /// A code-signing-requirement rejection also arrives as
    /// `NSXPCConnectionInvalid`, so a genuinely unsigned peer costs the whole
    /// (bounded) retry budget before being reported. That is the safe direction:
    /// the budget is a couple of seconds and the verdict is unchanged.
    public static func isTransientConnectionError(_ error: NSError) -> Bool {
        guard error.domain == NSCocoaErrorDomain else { return false }
        return error.code == NSXPCConnectionInvalid || error.code == NSXPCConnectionInterrupted
    }

    public static func isTransient(_ failure: ProbeStartupFailure) -> Bool {
        switch failure {
        case let .connection(error):
            isTransientConnectionError(error)
        case let .readback(message):
            ProbeReadbackStartupState.isTransient(message)
        }
    }
}

/// Bounded exponential backoff for the controller's startup read-back.
public struct ProbeStartupRetryPolicy: Equatable {
    /// Total attempts, the initial one included.
    public let maximumAttempts: Int
    public let initialDelay: TimeInterval
    public let multiplier: Double
    public let maximumDelay: TimeInterval

    /// Four retries over 2.2s. The controller's own watchdog fires at 8s, so
    /// the budget has to stay short enough that exhausting it still leaves room
    /// to report a real verdict instead of timing out.
    public static let startupDefault = ProbeStartupRetryPolicy(
        maximumAttempts: 5,
        initialDelay: 0.2,
        multiplier: 2,
        maximumDelay: 0.8
    )

    public init(maximumAttempts: Int, initialDelay: TimeInterval, multiplier: Double, maximumDelay: TimeInterval) {
        self.maximumAttempts = maximumAttempts
        self.initialDelay = initialDelay
        self.multiplier = multiplier
        self.maximumDelay = maximumDelay
    }

    /// Delay to wait before `attempt` (1-based). Attempt 1 is the initial try
    /// and never waits; `nil` once the budget is exhausted.
    public func delay(beforeAttempt attempt: Int) -> TimeInterval? {
        guard attempt > 1, attempt <= maximumAttempts else { return nil }
        return min(initialDelay * pow(multiplier, Double(attempt - 2)), maximumDelay)
    }

    /// Wall-clock time spent waiting if every retry is used.
    public var totalRetryDelay: TimeInterval {
        guard maximumAttempts > 1 else { return 0 }
        return (2 ... maximumAttempts).compactMap { delay(beforeAttempt: $0) }.reduce(0, +)
    }
}

/// Seam for the retry delay so tests never sleep.
public protocol ProbeRetryScheduler: AnyObject {
    func schedule(after delay: TimeInterval, _ work: @escaping () -> Void)
}

public final class DispatchProbeRetryScheduler: ProbeRetryScheduler {
    private let queue: DispatchQueue

    public init(queue: DispatchQueue = .main) {
        self.queue = queue
    }

    public func schedule(after delay: TimeInterval, _ work: @escaping () -> Void) {
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }
}

/// Spends one shared retry budget across every startup failure, whichever layer
/// reported it. XPC error handlers can fire on an arbitrary queue, so the
/// attempt counter is lock-guarded.
public final class ProbeStartupRetryCoordinator {
    private let policy: ProbeStartupRetryPolicy
    private let scheduler: ProbeRetryScheduler
    private let lock = NSLock()
    private var attempt = 1

    public init(policy: ProbeStartupRetryPolicy = .startupDefault, scheduler: ProbeRetryScheduler) {
        self.policy = policy
        self.scheduler = scheduler
    }

    /// Schedules `retry` when `failure` is a startup race and the budget still
    /// allows another attempt. Returns `false` when the caller must report the
    /// failure instead of retrying.
    @discardableResult
    public func scheduleRetry(after failure: ProbeStartupFailure, _ retry: @escaping () -> Void) -> Bool {
        guard ProbeStartupTransience.isTransient(failure) else { return false }
        lock.lock()
        let next = attempt + 1
        guard let delay = policy.delay(beforeAttempt: next) else {
            lock.unlock()
            return false
        }
        attempt = next
        lock.unlock()
        scheduler.schedule(after: delay, retry)
        return true
    }
}
