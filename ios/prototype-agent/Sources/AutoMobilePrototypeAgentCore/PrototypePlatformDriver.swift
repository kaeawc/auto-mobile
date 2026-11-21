import Foundation

/// Tasks never deliver inside the interaction that starts them. Main-actor callbacks commit a
/// complete transition without suspension, serializing event handlers, completions and taps.
@MainActor
final class PrototypePlatformDriver {
    let registry: PrototypePlatformRegistry
    var realtime: PrototypeRealtimeModule?
    private let clock: any PrototypeClock
    private var calls: [String: Task<Void, Never>] = [:]
    private var deadlines: [String: any PrototypeTimerHandle] = [:]
    private var started: [String: Int] = [:]
    private var subscriptions: [String: Task<Void, Never>] = [:]
    private var observing = false
    var onComplete: ((String, PlatformCallResult, Int) -> Void)?
    var onEvent: ((PlatformEvent) -> Void)?
    var onState: (([String: JSONValue]) -> Void)?

    init(registry: PrototypePlatformRegistry, clock: any PrototypeClock) {
        self.registry = registry
        self.clock = clock
    }

    func simulate(id: String, event: String, data: JSONValue, session: PrototypeSession) -> String? {
        PrototypePlatformSimulation.apply(id: id, event: event, data: data, session: session, registry: registry) {
            onState?(registry.snapshot)
            onEvent?($0)
        }
    }

    func subscribe() {
        if !observing {
            observing = true
            registry.retainSources()
        }
        for name in registry.modules.keys.sorted() where subscriptions[name] == nil {
            guard let module = registry.modules[name] else { continue }
            let stream = module.events
            subscriptions[name] = Task { [weak self] in
                for await event in stream {
                    guard !Task.isCancelled, let self else { break }
                    if event.event == PlatformEvent.stateRefresh(name).event {
                        onState?(registry.snapshot)
                        continue
                    }
                    guard event.event.hasPrefix(name + "."),
                          PrototypePlatformValidator.modules[name]?.events.contains(
                              String(event.event.dropFirst(name.count + 1))
                          ) == true else { continue }
                    onState?(registry.snapshot)
                    onEvent?(event)
                }
            }
        }
    }

    /// Seed before publishing a show. A rejected seed leaves the previous configuration listening
    /// again; the caller subscribes after publishing a successful show.
    func seedForShow(
        _ spec: PrototypeSpec,
        previousLocationBlock: JSONValue?,
        previousSensorsBlock: JSONValue?,
        previousSessionID: Int,
        sessionID: Int,
        snapshot: () -> [String: JSONValue]
    )
        throws -> PrototypeSpec
    {
        resetSessionEvents()
        registry.configure(locationBlock: spec.locationBlock)
        registry.configure(sensorsBlock: spec.sensorsBlock, sessionID: sessionID)
        do {
            return try spec.replacingPlatform(snapshot())
        } catch {
            registry.configure(locationBlock: previousLocationBlock)
            registry.configure(sensorsBlock: previousSensorsBlock, sessionID: previousSessionID)
            subscribe()
            throw error
        }
    }

    /// Only the session-configured built-ins need fresh streams. Preserve global and host-supplied
    /// streams across shows: cancelling an iterator permanently terminates that AsyncStream.
    func resetSessionEvents() {
        for (name, module) in registry.modules
            where module is PrototypeSensorsModule || module is PrototypeLocationModule
        {
            subscriptions.removeValue(forKey: name)?.cancel()
        }
    }

    func resetNotificationEvents() {
        subscriptions.removeValue(forKey: "notifications")?.cancel()
    }

    func stopEvents() {
        guard observing else { return }
        observing = false
        subscriptions.values.forEach { $0.cancel() }
        subscriptions = [:]
        registry.releaseSources()
    }

    func perform(_ commands: [PrototypePlatformCommand]) {
        for command in commands {
            switch command {
            case let .cancel(id): cancel(id)
            case let .start(job): start(job)
            }
        }
    }

    private func start(_ job: PrototypePlatformJob) {
        let id = job.call.callId
        started[id] = clock.nowMilliseconds
        deadlines[id] = clock.schedule(afterMilliseconds: job.timeoutMs) { [weak self] in
            MainActor.assumeIsolated {
                self?.finish(id, .failure(.timeout, "Platform call timed out"))
            }
        }
        let registry = registry
        let realtime = realtime
        calls[id] = Task { [weak self] in
            guard !Task.isCancelled else { return }
            let result: PlatformCallResult
            let name = String(job.call.call.split(separator: ".").first ?? "")
            let resolved: (any PrototypePlatformModule)? = name == "realtime" ? realtime : registry.modules[name]
            if let module = resolved {
                switch module.availability() {
                case .ready:
                    if let invalid = Self.invalidArguments(job.call) { result = invalid }
                    else { result = await module.call(job.call) }
                case let .unavailable(reason): result = .failure(.unavailable, reason)
                case .needsPermission: result = .failure(.permissionDenied, "Permission is required")
                }
            } else { result = .failure(.unsupported, "Platform module is not registered") }
            self?.finish(id, result)
        }
    }

    nonisolated static func invalidArguments(_ call: PlatformCall) -> PlatformCallResult? {
        let parts = call.call.split(separator: ".")
        guard parts.count == 2,
              let definition = PrototypePlatformValidator.modules[String(parts[0])]?.calls[String(parts[1])]
        else { return .failure(.unsupported, "Unknown platform call") }
        for name in Set(definition.args.keys).union(call.args.keys) {
            guard let rule = definition.args[name] else { return .failure(.invalidArgs, "Unknown argument: \(name)") }
            guard let value = call.args[name] else {
                if rule.optional { continue }
                return .failure(.invalidArgs, "Missing argument: \(name)")
            }
            do { try PrototypePlatformValidator.check(value, rule.rule, path: name) }
            catch { return .failure(.invalidArgs, "Invalid argument: \(name)") }
        }
        if call.call == "links.open",
           let error = PrototypeLinks.argumentsError(call.args, path: "args", resolved: true)
        {
            return .failure(.invalidArgs, error.message)
        }
        return nil
    }

    private func finish(_ id: String, _ result: PlatformCallResult) {
        guard calls[id] != nil else { return }
        let duration = max(0, clock.nowMilliseconds - (started[id] ?? clock.nowMilliseconds))
        cancel(id)
        onState?(registry.snapshot)
        onComplete?(id, result, duration)
    }

    private func cancel(_ id: String) {
        calls.removeValue(forKey: id)?.cancel()
        deadlines.removeValue(forKey: id)?.cancel()
        started[id] = nil
    }

    func settled() async {
        for task in Array(calls.values) {
            await task.value
        }
    }

    deinit {
        for task in subscriptions.values {
            task.cancel()
        }
        for task in calls.values {
            task.cancel()
        }
    }
}
