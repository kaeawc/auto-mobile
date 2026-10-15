import Foundation
import Network

/// The Network.framework listener surface used by the server. Handlers are installed
/// before start and delivered on its queue; tests substitute a listener without a socket.
protocol ServerListening: AnyObject, Sendable {
    var stateUpdateHandler: (@Sendable (NWListener.State) -> Void)? { get set }
    var newConnectionHandler: (@Sendable (NWConnection) -> Void)? { get set }
    func start(queue: DispatchQueue)
    func cancel()
}

extension NWListener: ServerListening {}
