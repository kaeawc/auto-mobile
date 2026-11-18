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
protocol PrototypeNotificationAuthorizationSource: AnyObject {
    func status() async -> PrototypePermissionState
    /// Prompts only if still notDetermined and returns a fresh settings reading, never the grant Bool.
    func request() async -> PrototypePermissionOutcome
    var changes: AsyncStream<PrototypePermissionState> { get }
    /// Releases observations and pending requests. Later reads may restart observation.
    func stop()
}

@MainActor
final class PrototypePermissionsModule: PrototypePlatformModule {
    let name = "permissions"
    let capability = "prototype_platform_permissions_v1"
    let requiredInfoPlistKeys: [String] = []
    private let source: any PrototypeNotificationAuthorizationSource
    private var values: [String: JSONValue] = [:]
    private var observation: Task<Void, Never>?
    private var generation = 0
    private var nextRequest = 0
    private var pending: (id: Int, continuation: CheckedContinuation<PlatformCallResult, Never>)?
    private var requestTask: Task<Void, Never>?
    private var subscribers: [Int: AsyncStream<PlatformEvent>.Continuation] = [:]
    private var nextSubscriber = 0

    init(source: any PrototypeNotificationAuthorizationSource) { self.source = source }

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
        source.stop()
        subscribers.values.forEach { $0.finish() }
        subscribers.removeAll()
        values.removeAll()
    }

    private func start() {
        guard observation == nil else { return }
        let session = generation
        let changes = source.changes
        observation = Task { [weak self, source] in
            let initial = await source.status()
            guard let self, !Task.isCancelled, session == generation else { return }
            initialize(initial)
            for await state in changes {
                guard !Task.isCancelled, session == generation else { return }
                publish("notifications", state)
            }
        }
    }

    private func initialize(_ state: PrototypePermissionState) {
        guard values["notifications"] == nil else { return }
        // The framework reads asynchronously. The first reading is a baseline, not a change.
        values["notifications"] = .string(state.rawValue)
        subscribers.values.forEach { $0.yield(.stateRefresh(name)) }
    }

    private func perform(_ call: PlatformCall, id: Int) async -> PlatformCallResult {
        guard case let .array(names)? = call.args["names"] else { return .failure(.invalidArgs, "Missing names") }
        var results: [String: JSONValue] = [:]
        for entry in names {
            guard active(id), let name = entry.stringValue else {
                return .failure(.cancelled, "Permission request cancelled")
            }
            let outcome: PrototypePermissionOutcome
            if name == "notifications" {
                outcome = await notificationRequest(id: id)
            } else { outcome = .status(.unavailable) }
            guard active(id) else { return .failure(.cancelled, "Permission request cancelled") }
            let state: PrototypePermissionState
            switch outcome {
            case let .status(value): state = value
            case .busy: return .failure(.tooManyInFlight, "Permission request already in flight")
            case .cancelled: return .failure(.cancelled, "Permission request cancelled")
            case .platformError: return .failure(.platformError, "Permission request failed")
            }
            publish(name, state)
            results[name] = .string(state.rawValue)
        }
        return .success(.object(["results": .object(results)]))
    }

    private func notificationRequest(id: Int) async -> PrototypePermissionOutcome {
        let current = await source.status()
        guard active(id) else { return .cancelled }
        initialize(current)
        return current == .notDetermined ? await source.request() : .status(current)
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
