import Foundation

enum PrototypePermissionState: String, CaseIterable, Sendable {
    case granted, denied, blocked, notDetermined, limited, restricted, unavailable
}

/// UIKit maps the framework enum here; Core and its tests never import UserNotifications.
enum PrototypeNotificationAuthorization: Sendable {
    case notDetermined, denied, authorized, provisional, ephemeral, unknown

    var state: PrototypePermissionState {
        switch self {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .authorized, .ephemeral: .granted
        case .provisional: .limited
        case .unknown: .unavailable
        }
    }

    /// UNUserNotificationCenter.current() is unsafe in command-line and XCTest hosts.
    static func canAccessCenter(bundlePath: String, bundleIdentifier: String?) -> Bool {
        bundlePath.hasSuffix(".app") && bundleIdentifier != nil
    }
}

enum PrototypePermissionOutcome: Sendable {
    case status(PrototypePermissionState)
    case busy, cancelled, platformError
}

@MainActor
protocol PrototypePermissionAuthority {
    func status() async -> PrototypePermissionState
    func request() async -> PrototypePermissionOutcome
    /// Releases pending requests and resources. Later reads may restart the authority.
    func stop()
}

@MainActor
protocol PrototypeNotificationAuthorizationSource: AnyObject, PrototypePermissionAuthority {
    /// Prompts only if still notDetermined and returns a fresh settings reading, never the grant Bool.
    func request(provisional: Bool) async -> PrototypePermissionOutcome
    /// Foreground signals; the module owns status reads and their ordering against request results.
    var changes: AsyncStream<Void> { get }
}

extension PrototypeNotificationAuthorizationSource {
    func request() async -> PrototypePermissionOutcome { await request(provisional: false) }
}

@MainActor
private struct UsageKeyPermissionAuthority: PrototypePermissionAuthority {
    let authority: any PrototypePermissionAuthority
    let available: Bool

    func status() async -> PrototypePermissionState {
        guard available else { return .unavailable }
        return await authority.status()
    }

    func request() async -> PrototypePermissionOutcome {
        guard available else { return .status(.unavailable) }
        return await authority.request()
    }

    func stop() {
        if available { authority.stop() }
    }
}

@MainActor
final class PrototypePermissionsModule: PrototypePlatformModule {
    let name = "permissions"
    let capability = "prototype_platform_permissions_v1"
    let requiredInfoPlistKeys: [String] = []
    private let source: any PrototypeNotificationAuthorizationSource
    private let authorities: [String: any PrototypePermissionAuthority]
    private let observedNames: [String]
    private var values: [String: JSONValue] = [:]
    private(set) var observation: Task<Void, Never>?
    private var generation = 0
    private var permissionSequences: [String: Int] = [:]
    private var nextRequest = 0
    private var pending: (id: Int, continuation: CheckedContinuation<PlatformCallResult, Never>)?
    private(set) var requestTask: Task<Void, Never>?
    private var subscribers: [Int: AsyncStream<PlatformEvent>.Continuation] = [:]
    private var nextSubscriber = 0

    init(
        source: any PrototypeNotificationAuthorizationSource,
        authorities: [String: any PrototypePermissionAuthority] = [:],
        bundle: any PrototypeBundleReader = PrototypeMainBundleReader()
    ) {
        self.source = source
        var registered: [String: any PrototypePermissionAuthority] = ["notifications": source]
        for (name, authority) in authorities where name != "notifications" {
            registered[name] = UsageKeyPermissionAuthority(
                authority: authority,
                available: PrototypePlatformPermissions.hasRequiredUsageKey(for: name) {
                    bundle.containsInfoPlistKey($0)
                }
            )
        }
        self.authorities = registered
        observedNames = registered.keys.sorted()
    }

    var state: [String: JSONValue] {
        start()
        return values
    }

    var events: AsyncStream<PlatformEvent> {
        let (stream, continuation) = AsyncStream.makeStream(
            of: PlatformEvent.self, bufferingPolicy: .bufferingNewest(64)
        )
        let id = nextSubscriber
        nextSubscriber += 1
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.subscribers[id] = nil }
        }
        start()
        return stream
    }

    func availability() -> PlatformAvailability { .ready }

    func call(_ call: PlatformCall) async -> PlatformCallResult {
        guard call.call == "permissions.request" else { return .failure(.unsupported, "Unknown call") }
        if let invalid = PrototypePlatformDriver.invalidArguments(call) { return invalid }
        guard !Task.isCancelled else { return .failure(.cancelled, "Permission request cancelled") }
        guard pending == nil else { return .failure(.tooManyInFlight, "Permission request already in flight") }
        start()
        let id = nextRequest
        nextRequest += 1
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(returning: .failure(.cancelled, "Permission request cancelled"))
                    return
                }
                pending = (id, continuation)
                requestTask = Task { [weak self] in
                    guard let self else { return }
                    let result = await perform(call, id: id)
                    finish(id, result)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.finish(id, .failure(.cancelled, "Permission request cancelled"))
            }
        }
    }

    func stop() {
        generation += 1
        observation?.cancel()
        observation = nil
        if let pending { finish(pending.id, .failure(.cancelled, "Permission request cancelled")) }
        authorities.values.forEach { $0.stop() }
        subscribers.values.forEach { $0.finish() }
        subscribers.removeAll()
        values.removeAll()
    }

    private func start() {
        guard observation == nil else { return }
        let session = generation
        let changes = source.changes
        observation = Task { [weak self] in
            await self?.refresh(session: session, initial: true)
            for await _ in changes {
                guard !Task.isCancelled, let self else { return }
                await refresh(session: session, initial: false)
            }
        }
    }

    private func refresh(session: Int, initial: Bool) async {
        for name in observedNames {
            guard !Task.isCancelled, session == generation, let authority = authorities[name] else { return }
            let sequence = permissionSequences[name, default: 0]
            let state = await authority.status()
            // Generation owns late reads across stop/restart; stop also cancels the observation task.
            guard session == generation else { return }
            if !initial, Task.isCancelled { return }
            guard sequence == permissionSequences[name, default: 0] else { continue }
            if initial {
                initialize(name, state)
            } else {
                publish(name, state)
            }
        }
    }

    private func initialize(_ name: String, _ state: PrototypePermissionState) {
        // The framework reads asynchronously. The first reading is a baseline, not a change.
        values[name] = .string(state.rawValue)
        subscribers.values.forEach { $0.yield(.stateRefresh(self.name)) }
    }

    private func perform(_ call: PlatformCall, id: Int) async -> PlatformCallResult {
        guard case let .array(names)? = call.args["names"] else { return .failure(.invalidArgs, "Missing names") }
        var results: [String: JSONValue] = [:]
        for entry in names {
            guard active(id), let name = entry.stringValue else {
                return .failure(.cancelled, "Permission request cancelled")
            }
            let outcome: PrototypePermissionOutcome
            if let authority = authorities[name] {
                outcome = await request(
                    name, from: authority, id: id,
                    provisional: call.args["options"]?.objectFields?["provisional"] == .bool(true)
                )
            } else { outcome = .status(.unavailable) }
            guard active(id) else { return .failure(.cancelled, "Permission request cancelled") }
            let state: PrototypePermissionState
            switch outcome {
            case let .status(value): state = value
            case .busy: return .failure(.tooManyInFlight, "Permission request already in flight")
            case .cancelled: return .failure(.cancelled, "Permission request cancelled")
            case .platformError: return .failure(.platformError, "Permission request failed")
            }
            permissionSequences[name, default: 0] += 1
            publish(name, state)
            results[name] = .string(state.rawValue)
        }
        return .success(.object(["results": .object(results)]))
    }

    private func request(
        _ name: String, from authority: any PrototypePermissionAuthority, id: Int, provisional: Bool
    )
        async -> PrototypePermissionOutcome
    {
        if name == "notifications" || values[name] == nil {
            let current = await authority.status()
            guard active(id) else { return .cancelled }
            if values[name] == nil {
                // A request can establish the baseline before the initial read, even if prompting fails.
                permissionSequences[name, default: 0] += 1
                initialize(name, current)
            }
            if name == "notifications", current != .notDetermined { return .status(current) }
        }
        if name == "notifications" { return await source.request(provisional: provisional) }
        return await authority.request()
    }

    private func active(_ id: Int) -> Bool { !Task.isCancelled && pending?.id == id }

    private func finish(_ id: Int, _ result: PlatformCallResult) {
        guard let pending, pending.id == id else { return }
        self.pending = nil
        requestTask?.cancel()
        requestTask = nil
        pending.continuation.resume(returning: result)
    }

    private func publish(_ name: String, _ state: PrototypePermissionState) {
        let value = JSONValue.string(state.rawValue)
        guard values[name] != value else { return }
        values[name] = value
        let event = PlatformEvent(event: "permissions.changed", data: .object([
            "name": .string(name), "state": value,
        ]))
        subscribers.values.forEach { $0.yield(event) }
    }
}
