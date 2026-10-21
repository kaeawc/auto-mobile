import Foundation

/// A sink for one outbound framed message. `WebSocketConnection` is the production
/// implementation; tests inject a capturing fake so the command/response path can be
/// driven end-to-end without a live `NWConnection` (issue #2859 part 4).
///
/// `Sendable` because `send` is invoked from any queue (main-thread broadcast,
/// command-queue reply); the concrete `send` only forwards to a thread-safe channel
/// and touches no queue-confined connection state.
protocol WebSocketResponding: AnyObject, Sendable {
    func send(_ data: Data)
}
