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
    let simulated: Bool

    public init(event: String, data: JSONValue) {
        simulated = false
        self.event = event
        self.data = data
    }
}

extension PlatformEvent {
    init(simulating event: String, data: JSONValue) {
        self.event = event
        self.data = data
        simulated = true
    }

    /// A module's own signal that its state changed with no authored event to deliver: the driver
    /// refreshes `/platform` and runs no handler. The name is outside the contract's event names.
    static func stateRefresh(_ module: String) -> PlatformEvent {
        PlatformEvent(event: "\(module).$state", data: .null)
    }
}

/// Modules run on the same actor as interactions. Snapshots must be JSON objects; events notify
/// the driver to refresh state. A module must cooperate with task cancellation and bound its stream.
@MainActor
public protocol PrototypePlatformModule: Sendable {
    var name: String { get }
    var capability: String { get }
    var requiredInfoPlistKeys: [String] { get }
    func configure(root: JSONValue?)
    func availability() -> PlatformAvailability
    func call(_ call: PlatformCall) async -> PlatformCallResult
    var events: AsyncStream<PlatformEvent> { get }
    var state: [String: JSONValue] { get }
    /// Releases observations after the final driver stops; later reads may start them again.
    func stop()
    var supportsSimulation: Bool { get }
    /// Apply state without yielding to events; the runtime delivers the accepted event once.
    /// Returning false must leave state untouched.
    func simulate(_ event: PlatformEvent) -> Bool
}

extension PrototypePlatformModule {
    public var requiredInfoPlistKeys: [String] { [] }
    public var supportsSimulation: Bool { false }
    public func simulate(_: PlatformEvent) -> Bool { false }
    public func stop() {}
    public func configure(root _: JSONValue?) {}
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
    private var observers = 0
    private let parent: PrototypePlatformRegistry?
    private let presentationModules: [any PrototypePlatformModule]

    func retainSources() {
        observers += 1
        parent?.retainSources()
    }

    func releaseSources() {
        guard observers > 0 else { return }
        observers -= 1
        if observers == 0 {
            if parent == nil { modules.values.forEach { $0.stop() } }
            else { presentationModules.forEach { $0.stop() } }
        }
        // Global status streams outlive any one presentation; scoped streams stop independently.
        parent?.releaseSources()
    }

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
        parent = nil
        presentationModules = []
    }

    private init(
        modules: [String: any PrototypePlatformModule],
        parent: PrototypePlatformRegistry?,
        presentationModules: [any PrototypePlatformModule]
    ) {
        self.modules = modules
        self.parent = parent
        self.presentationModules = presentationModules
    }

    /// A model owns this registry's snapshots and streams for its lifetime. Read-only device status
    /// remains global; authored sensor/location configuration and pending calls are presentation-local.
    func forPresentation() -> PrototypePlatformRegistry {
        if let parent { return parent.forPresentation() }
        var scoped = modules
        var owned: [any PrototypePlatformModule] = []
        if let sensors = modules["sensors"] as? PrototypeSensorsModule {
            let module = sensors.forPresentation()
            scoped[module.name] = module
            owned.append(module)
        }
        if let location = modules["location"] as? PrototypeLocationModule {
            let module = location.forPresentation()
            scoped[module.name] = module
            owned.append(module)
        }
        return PrototypePlatformRegistry(modules: scoped, parent: self, presentationModules: owned)
    }

    public func configure(locationBlock: JSONValue?) {
        modules["location"]?.configure(root: locationBlock)
    }

    public func configure(sensorsBlock: JSONValue?) {
        configure(sensorsBlock: sensorsBlock, sessionID: 0)
    }

    func configure(sensorsBlock: JSONValue?, sessionID: Int = 0) {
        if let sensors = modules["sensors"] as? PrototypeSensorsModule {
            sensors.configure(root: sensorsBlock, sessionID: sessionID)
        } else { modules["sensors"]?.configure(root: sensorsBlock) }
    }

    public var supportsSimulation: Bool { modules.values.contains { $0.supportsSimulation } }

    public var capabilities: [String] {
        let simulation = supportsSimulation ? [
            PrototypeAgentProtocol.platformSimulationCapability,
            PrototypeAgentProtocol.simulatePlatformRequest,
        ] : []
        return Set(modules.values.map(\.capability) + simulation).sorted()
    }

    /// Launch-only test membership, with environment injected by the agent factory.
    func withTestHooks(environment: [String: String]) -> PrototypePlatformRegistry {
        guard PrototypeTestHooks.isEnabled(environment: environment) else { return self }
        var registered = modules
        if registered["test"] == nil { registered["test"] = PrototypeTestPlatformModule() }
        return PrototypePlatformRegistry(modules: registered, parent: nil, presentationModules: [])
    }

    // Production membership lives here so pure core tests exercise the same factories as UIKit.
    static func feedbackModules(
        haptics: any PrototypeHapticsPlayer,
        sound: any PrototypeSoundPlayer,
        connectivity: any PrototypeConnectivitySource,
        links: any PrototypeLinkOpener,
        settings: any PrototypeSettingsURLOpener,
        bundle: any PrototypeBundleReader = PrototypeMainBundleReader(),
        deviceStatus: [any PrototypePlatformModule] = [],
        location: (any PrototypeLocationSource)? = nil,
        sensors: (any PrototypeSensorSource)? = nil,
        permissions: (any PrototypeNotificationAuthorizationSource)? = nil,
        biometric: (any PrototypeBiometricSource)? = nil
    )
        -> PrototypePlatformRegistry
    {
        var modules: [any PrototypePlatformModule] = [
            PrototypeHapticsModule(player: haptics),
            PrototypeSoundModule(player: sound),
            PrototypeConnectivityModule(source: connectivity),
            PrototypeLinksModule(opener: links),
            PrototypeSettingsModule(opener: settings),
        ] + deviceStatus
        if let location { modules.append(PrototypeLocationModule(source: location, bundle: bundle)) }
        if let biometric { modules.append(PrototypeBiometricModule(source: biometric, bundle: bundle)) }
        if let sensors { modules.append(PrototypeSensorsModule(source: sensors, bundle: bundle)) }
        if let permissions { modules.append(PrototypePermissionsModule(source: permissions)) }
        return PrototypePlatformRegistry(modules: modules, bundle: bundle)
    }

    static func systemModules(
        clipboard: any PrototypeClipboard,
        connectivity: any PrototypeConnectivitySource,
        links: any PrototypeLinkOpener,
        settings: any PrototypeSettingsURLOpener,
        bundle: any PrototypeBundleReader = PrototypeMainBundleReader(),
        deviceStatus: [any PrototypePlatformModule] = [],
        location: (any PrototypeLocationSource)? = nil,
        sensors: (any PrototypeSensorSource)? = nil,
        permissions: (any PrototypeNotificationAuthorizationSource)? = nil,
        biometric: (any PrototypeBiometricSource)? = nil
    )
        -> PrototypePlatformRegistry
    {
        var modules: [any PrototypePlatformModule] = [
            PrototypeClipboardModule(clipboard: clipboard),
            PrototypeConnectivityModule(source: connectivity),
            PrototypeLinksModule(opener: links),
            PrototypeSettingsModule(opener: settings),
        ] + deviceStatus
        if let location { modules.append(PrototypeLocationModule(source: location, bundle: bundle)) }
        if let biometric { modules.append(PrototypeBiometricModule(source: biometric, bundle: bundle)) }
        if let sensors { modules.append(PrototypeSensorsModule(source: sensors, bundle: bundle)) }
        if let permissions { modules.append(PrototypePermissionsModule(source: permissions)) }
        return PrototypePlatformRegistry(modules: modules, bundle: bundle)
    }

    var snapshot: [String: JSONValue] {
        var snapshot = modules.mapValues { JSONValue.object($0.state) }
        if modules["notifications"] == nil, modules["permissions"] is PrototypePermissionsModule,
           let authorization = snapshot["permissions"]?.objectFields?["notifications"]
        {
            snapshot["notifications"] = .object(["authorization": authorization])
        }
        return snapshot
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
