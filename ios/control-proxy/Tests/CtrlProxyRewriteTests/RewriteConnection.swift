@testable import CtrlProxyRewrite
import Foundation

/// Scripted `ByteChannel` for the rewrite module. Serves a preloaded inbound byte
/// stream in response to the connection's `receive` calls and records outbound
/// `send`s into a `ConnectionRecorder`. All access happens on the connection's serial
/// queue, so no internal lock (`@unchecked Sendable` reflects that confinement).
final class RewriteScriptedByteChannel: ByteChannel, @unchecked Sendable {
    var onState: (@Sendable (ByteChannelState) -> Void)?
    private var inbound: Data
    private var pending: (@Sendable (Data?, Bool, Error?) -> Void)?
    private let recorder: ConnectionRecorder
    private let eofWhenDrained: Bool
    private var queue: DispatchQueue?

    init(inbound: Data, recorder: ConnectionRecorder, eofWhenDrained: Bool = false) {
        self.inbound = inbound
        self.recorder = recorder
        self.eofWhenDrained = eofWhenDrained
    }

    func start(queue: DispatchQueue) {
        self.queue = queue
        queue.async { [weak self] in self?.onState?(.ready) }
    }

    func receive(
        minimumIncompleteLength: Int,
        maximumLength: Int,
        completion: @escaping @Sendable (Data?, Bool, Error?) -> Void
    ) {
        if inbound.isEmpty {
            if eofWhenDrained {
                completion(nil, true, nil)
            } else {
                pending = completion // connection waits for more (scenario has settled)
            }
            return
        }
        let n = Swift.min(maximumLength, inbound.count)
        let chunk = Data(inbound.prefix(n))
        inbound.removeFirst(n)
        completion(chunk, false, nil)
    }

    func send(_ data: Data, completion: @escaping @Sendable (Error?) -> Void) {
        recorder.sends.append(data)
        completion(nil)
    }

    func cancel() {
        queue?.async { [weak self] in self?.onState?(.cancelled) }
    }
}

/// Drives a rewrite `WebSocketConnection` through a scripted scenario. The SDK seams
/// (`onSdkEventBatch`, `drainLogEvents`) default to nil but can be supplied to exercise
/// the `POST`/`GET /sdk-events` wiring (Phase 3).
enum RewriteConnectionDriver {
    static func run(
        inbound: Data,
        eofWhenDrained: Bool = false,
        onSdkEventBatch: (@Sendable (Data) -> Void)? = nil,
        drainLogEvents: (@Sendable () -> [Data])? = nil
    ) -> ConnectionRecorder {
        let queue = DispatchQueue(label: "rewrite.test.connection")
        let recorder = ConnectionRecorder()
        let channel = RewriteScriptedByteChannel(inbound: inbound, recorder: recorder, eofWhenDrained: eofWhenDrained)
        let connection = WebSocketConnection(
            id: 1,
            channel: channel,
            queue: queue,
            boundPort: 8765,
            onSdkEventBatch: onSdkEventBatch,
            drainLogEvents: drainLogEvents,
            onUpgrade: { recorder.upgrades += 1 },
            onMessage: { recorder.messages.append($0) },
            onClose: { recorder.closes += 1 }
        )
        connection.start()
        // The scripted channel completes every receive/send synchronously on `queue`,
        // so a single serial barrier after `start` runs after the whole scenario has
        // settled (it comes after the queued `.ready` transition that drives it).
        queue.sync {}
        // Keep the connection alive until the queue has drained.
        withExtendedLifetime(connection) {}
        return recorder
    }
}
