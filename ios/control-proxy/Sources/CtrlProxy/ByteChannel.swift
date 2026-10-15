import Foundation

/// The minimal byte-transport surface `WebSocketConnection` needs from its socket:
/// start, a state callback, length-bounded receive, framed send, and cancel.
/// `NWByteChannel` is the production implementation (a 1:1 forward to
/// `NWConnection`); tests inject a scripted fake so framing tests can drive the
/// handshake→frame handoff, EOF coalescing, ping consume, fragmentation reassembly,
/// and close-path teardown with exact byte chunks — without a live `NWConnection`
/// (issue #5680). The `receive` signature mirrors `NWConnection.receive`'s
/// completion shape (data, isComplete, error), dropping the unused `ContentContext`.
///
/// `Sendable` with `@Sendable` callbacks: instances and their completion handlers
/// cross the server queue / delivery-queue boundary under Swift 6.
protocol ByteChannel: AnyObject, Sendable {
    /// Invoked on each lifecycle transition the connection cares about. Set before
    /// `start` and delivered on the channel's queue in production.
    var onState: (@Sendable (ByteChannelState) -> Void)? { get set }
    func start(queue: DispatchQueue)
    func receive(
        minimumIncompleteLength: Int,
        maximumLength: Int,
        completion: @escaping @Sendable (Data?, Bool, Error?) -> Void
    )
    func send(_ data: Data, completion: @escaping @Sendable (Error?) -> Void)
    func cancel()
}
