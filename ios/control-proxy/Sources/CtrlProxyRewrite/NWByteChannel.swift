import Foundation
import Network

/// Production `ByteChannel` backed by a real `NWConnection`. Forwards every call
/// unchanged so the wire behavior is identical to talking to `NWConnection`
/// directly; it exists only to let tests substitute a scripted channel at the same
/// seam (issue #5680).
///
/// `@unchecked Sendable`: this wraps a queue-driven system object whose entire API
/// delivers on the dispatch queue passed to `start`. `onState` is set once before
/// `start` and thereafter read only on that delivery queue — the queue-confinement
/// archetype (the `@unchecked` is justified by that discipline, not by a lock).
final class NWByteChannel: ByteChannel, @unchecked Sendable {
    private let connection: NWConnection
    var onState: (@Sendable (ByteChannelState) -> Void)?

    init(_ connection: NWConnection) {
        self.connection = connection
    }

    func start(queue: DispatchQueue) {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.onState?(.ready)
            case .failed:
                self?.onState?(.failed)
            case .cancelled:
                self?.onState?(.cancelled)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    func receive(
        minimumIncompleteLength: Int,
        maximumLength: Int,
        completion: @escaping @Sendable (Data?, Bool, Error?) -> Void
    ) {
        connection.receive(
            minimumIncompleteLength: minimumIncompleteLength,
            maximumLength: maximumLength
        ) { data, _, isComplete, error in
            completion(data, isComplete, error)
        }
    }

    func send(_ data: Data, completion: @escaping @Sendable (Error?) -> Void) {
        connection.send(content: data, completion: .contentProcessed { error in
            completion(error)
        })
    }

    func cancel() {
        connection.cancel()
    }
}
