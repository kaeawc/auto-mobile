@testable import CtrlProxy
import Foundation

/// Scripted `ByteChannel` for the reference module (see `RewriteScriptedByteChannel`).
/// The reference protocol's callbacks are not `@Sendable` (Swift-5 mode), so the
/// closures here are plain.
final class ReferenceScriptedByteChannel: ByteChannel, @unchecked Sendable {
    var onState: ((ByteChannelState) -> Void)?
    private var inbound: Data
    private var pending: ((Data?, Bool, Error?) -> Void)?
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
        completion: @escaping (Data?, Bool, Error?) -> Void
    ) {
        if inbound.isEmpty {
            if eofWhenDrained {
                completion(nil, true, nil)
            } else {
                pending = completion
            }
            return
        }
        let n = Swift.min(maximumLength, inbound.count)
        let chunk = Data(inbound.prefix(n))
        inbound.removeFirst(n)
        completion(chunk, false, nil)
    }

    func send(_ data: Data, completion: @escaping (Error?) -> Void) {
        recorder.sends.append(data)
        completion(nil)
    }

    func cancel() {
        queue?.async { [weak self] in self?.onState?(.cancelled) }
    }
}

/// Drives a reference `WebSocketConnection` through a scripted scenario. The
/// reference init takes `sdkHierarchyCache` / `onSdkHierarchyUpdated` (nil here) where
/// the rewrite takes the `onSdkEventBatch` / `drainLogEvents` seams.
enum ReferenceConnectionDriver {
    static func run(inbound: Data, eofWhenDrained: Bool = false) -> ConnectionRecorder {
        let queue = DispatchQueue(label: "reference.test.connection")
        let recorder = ConnectionRecorder()
        let channel = ReferenceScriptedByteChannel(inbound: inbound, recorder: recorder, eofWhenDrained: eofWhenDrained)
        let connection = WebSocketConnection(
            id: 1,
            channel: channel,
            queue: queue,
            boundPort: 8765,
            sdkHierarchyCache: nil,
            onSdkHierarchyUpdated: nil,
            onUpgrade: { recorder.upgrades += 1 },
            onMessage: { recorder.messages.append($0) },
            onClose: { recorder.closes += 1 }
        )
        connection.start()
        queue.sync {}
        withExtendedLifetime(connection) {}
        return recorder
    }
}
