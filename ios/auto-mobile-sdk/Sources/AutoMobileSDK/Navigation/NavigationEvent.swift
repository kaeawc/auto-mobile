import Foundation

/// Represents a navigation event within the app.
public struct NavigationEvent: Sendable {
    /// Destination identifier (route, screen name, deep link).
    public let destination: String

    /// Navigation framework source.
    public let source: NavigationSource

    /// Event timestamp (seconds since epoch).
    public let timestamp: TimeInterval

    /// Navigation arguments.
    public let arguments: [String: String]

    /// Additional metadata.
    public let metadata: [String: String]

    public init(
        destination: String,
        source: NavigationSource,
        timestamp: TimeInterval = Date().timeIntervalSince1970,
        arguments: [String: String] = [:],
        metadata: [String: String] = [:]
    ) {
        self.destination = destination
        self.source = source
        self.timestamp = timestamp
        self.arguments = arguments
        self.metadata = metadata
    }
}
