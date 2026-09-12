@testable import CtrlProxyRewrite
import Foundation
import Network
import os

final class FakeServerListener: ServerListening, Sendable {
    private struct State {
        var onState: (@Sendable (NWListener.State) -> Void)?
        var onConnection: (@Sendable (NWConnection) -> Void)?
        var queue: DispatchQueue?
        var cancellations = 0
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    var stateUpdateHandler: (@Sendable (NWListener.State) -> Void)? {
        get { state.withLock { $0.onState } }
        set { state.withLock { $0.onState = newValue } }
    }

    var newConnectionHandler: (@Sendable (NWConnection) -> Void)? {
        get { state.withLock { $0.onConnection } }
        set { state.withLock { $0.onConnection = newValue } }
    }

    var cancellations: Int { state.withLock { $0.cancellations } }
    func start(queue: DispatchQueue) { state.withLock { $0.queue = queue } }
    func cancel() { state.withLock { $0.cancellations += 1 } }
    func fail() {
        let (queue, handler) = state.withLock { ($0.queue, $0.onState) }
        queue?.sync { handler?(.failed(.posix(.ECONNABORTED))) }
    }
}
