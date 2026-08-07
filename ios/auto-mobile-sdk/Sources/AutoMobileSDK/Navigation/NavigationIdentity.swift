import Foundation

/// Host-configurable redaction applied before navigation data leaves the app.
public protocol NavigationDataRedacting: Sendable {
    func redact(_ value: String) -> String
}

public struct NoOpNavigationRedactor: NavigationDataRedacting {
    public init() {}
    public func redact(_ value: String) -> String { value }
}

/// A stable route identity, separate from display text and mutable arguments.
public struct NavigationScreenIdentity: Sendable, Equatable {
    public let route: String
    public let version: String?

    public init(route: String, version: String? = nil) {
        self.route = route
        self.version = version
    }

    public var value: String {
        guard let version, !version.isEmpty else { return route }
        return "\(route)@\(version)"
    }
}

/// Shared normalization used by every navigation adapter.
public struct NavigationEventFactory: Sendable {
    public let redactor: any NavigationDataRedacting

    public init(redactor: any NavigationDataRedacting = NoOpNavigationRedactor()) {
        self.redactor = redactor
    }

    public func make(
        destination: String,
        source: NavigationSource,
        identity: NavigationScreenIdentity? = nil,
        sceneIdentifier: String? = nil,
        transitionIdentifier: String? = nil,
        transitionCompleted: Bool = true,
        arguments: [String: String] = [:],
        metadata: [String: String] = [:]
    ) -> NavigationEvent {
        NavigationEvent(
            destination: redactor.redact(destination),
            source: source,
            arguments: arguments.mapValues(redactor.redact),
            metadata: metadata.mapValues(redactor.redact),
            screenIdentity: identity?.value ?? redactor.redact(destination),
            sceneIdentifier: sceneIdentifier.map(redactor.redact),
            transitionIdentifier: transitionIdentifier.map(redactor.redact),
            transitionCompleted: transitionCompleted
        )
    }
}
