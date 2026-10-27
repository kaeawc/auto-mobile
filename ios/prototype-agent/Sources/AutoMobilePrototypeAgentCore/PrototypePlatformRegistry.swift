import Foundation

/// Availability is descriptive; permission prompting belongs to the permission runtime.
public enum PlatformAvailability: Equatable, Sendable {
    case ready
    case unavailable(String)
    case needsPermission([String])
}

public enum PlatformErrorCode: String, Sendable {
    case unsupported, unavailable, cancelled, timeout
    case permissionDenied = "permission_denied"
    case invalidArgs = "invalid_args"
    case tooManyInFlight = "too_many_in_flight"
    case platformError = "platform_error"
}

public struct PlatformCall: Equatable, Sendable {
    public let callId: String
    public let call: String
    public let args: [String: JSONValue]
}

public enum PlatformCallResult: Equatable, Sendable {
    case success(JSONValue)
    case failure(PlatformErrorCode, String)
}

public struct PlatformEvent: Equatable, Sendable {
    public let event: String
    public let data: JSONValue

    public init(event: String, data: JSONValue) {
        self.event = event
        self.data = data
    }
}

/// Modules run on the same actor as interactions. Snapshots must be JSON objects; events notify
/// the driver to refresh state. A module must cooperate with task cancellation and bound its stream.
@MainActor
public protocol PrototypePlatformModule: Sendable {
    var name: String { get }
    var capability: String { get }
    var requiredInfoPlistKeys: [String] { get }
    func availability() -> PlatformAvailability
    func call(_ call: PlatformCall) async -> PlatformCallResult
    var events: AsyncStream<PlatformEvent> { get }
    var state: [String: JSONValue] { get }
}

extension PrototypePlatformModule {
    public var requiredInfoPlistKeys: [String] { [] }
}

@MainActor
public protocol PrototypeBundleReader {
    func containsInfoPlistKey(_ key: String) -> Bool
}

public struct PrototypeMainBundleReader: PrototypeBundleReader {
    public init() {}
    public func containsInfoPlistKey(_ key: String) -> Bool {
        Bundle.main.object(forInfoDictionaryKey: key) != nil
    }
}

/// Immutable membership and identity: withheld modules never contribute capabilities or state.
/// The existing read-only device seam sits beside this registry and owns `/platform/device`.
@MainActor
public final class PrototypePlatformRegistry {
    public static let empty = PrototypePlatformRegistry()

    let modules: [String: any PrototypePlatformModule]

    public init(
        modules: [any PrototypePlatformModule] = [],
        bundle: any PrototypeBundleReader = PrototypeMainBundleReader()
    ) {
        var accepted: [String: any PrototypePlatformModule] = [:]
        for module in modules where module.name != "device" && accepted[module.name] == nil {
            guard module.requiredInfoPlistKeys.allSatisfy(bundle.containsInfoPlistKey) else { continue }
            accepted[module.name] = module
        }
        self.modules = accepted
    }

    public var capabilities: [String] { Set(modules.values.map(\.capability)).sorted() }

    var snapshot: [String: JSONValue] {
        modules.mapValues { .object($0.state) }
    }
}

struct PrototypePlatformJob: Sendable {
    let call: PlatformCall
    let timeoutMs: Int
}

enum PrototypePlatformCommand {
    case start(PrototypePlatformJob)
    case cancel(String)
}

struct PrototypeInFlightPlatformCall {
    let job: PrototypePlatformJob
    let action: PrototypeAction
    let eventData: JSONValue?
    /// The node whose action made the call, when one node owns it (the feedback log's `nodeId`).
    var nodeId: String?
}
