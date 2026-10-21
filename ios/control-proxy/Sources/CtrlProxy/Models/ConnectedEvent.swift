import Foundation

/// The runtime in which the runner handles requests. Injectable so the handshake
/// can be checked for both environments on a macOS test host.
public enum RunnerEnvironment: Equatable, Sendable {
    case simulator
    case device

    public static var current: Self {
        #if targetEnvironment(simulator)
            return .simulator
        #else
            return .device
        #endif
    }
}

/// The one-shot event pushed to a client on WebSocket upgrade. The sorted
/// command and feature lists are runner-version signals for the daemon (#5787).
public struct ConnectedEvent: Codable, Sendable {
    public let type: String
    public let id: Int
    public let supportedCommands: [String]
    public let supportedFeatures: [String]

    public init(id: Int, environment: RunnerEnvironment = .current) {
        type = "connected"
        self.id = id
        supportedCommands = CommandHandler.supportedRequestTypes(in: environment).map(\.rawValue).sorted()
        supportedFeatures = RunnerFeature.allCases.map(\.rawValue).sorted()
    }
}
