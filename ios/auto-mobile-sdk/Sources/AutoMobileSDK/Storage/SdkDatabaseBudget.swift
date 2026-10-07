import Foundation

/// Time budget for a database request the runner relays to the SDK (#10166).
///
/// The runner gives up on a relayed request after its request timeout (2 s) and reports a failure.
/// A mutation the SDK still executes after that point is applied while the caller was told it
/// failed, and a retry applies it twice. A mutation therefore gets a deadline that falls before the
/// relay's timeout: the runner sends its timeout with the request (`relayTimeoutMs`), and the SDK
/// uses a share of it, measured from when the server accepted the request.
enum SdkDatabaseBudget {
    /// The runner's request timeout, assumed for runners that do not send `relayTimeoutMs`.
    static let defaultRelayTimeoutMs = 2000

    /// The part of the relay's timeout a mutation may use; the rest is margin for transport,
    /// encoding, and the relay's own scheduling.
    static let mutationShare = 0.75

    /// Monotonic clock for deadlines; deadlines are absolute values of this clock.
    static func now() -> TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    static func mutationDeadline(receivedAt: TimeInterval, relayTimeoutMs: Int?) -> TimeInterval {
        let timeoutMs = relayTimeoutMs.flatMap { $0 > 0 ? $0 : nil } ?? defaultRelayTimeoutMs
        return receivedAt + Double(timeoutMs) / 1000 * mutationShare
    }
}
