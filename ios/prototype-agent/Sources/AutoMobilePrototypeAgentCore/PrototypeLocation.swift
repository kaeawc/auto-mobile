import Foundation

struct PrototypeLocationFix: Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    let accuracyM: Double
    var altitudeM: Double? = nil
    var speedMps: Double? = nil
    var bearingDeg: Double? = nil
    let timestampMs: Double
    var approximate: Bool

    var json: JSONValue {
        var fields: [String: JSONValue] = [
            "latitude": .number(latitude), "longitude": .number(longitude),
            "accuracyM": .number(accuracyM), "timestampMs": .number(timestampMs),
            "approximate": .bool(approximate),
        ]
        if let altitudeM { fields["altitudeM"] = .number(altitudeM) }
        if let speedMps { fields["speedMps"] = .number(speedMps) }
        if let bearingDeg { fields["bearingDeg"] = .number(bearingDeg) }
        return .object(fields)
    }

    var valid: Bool {
        latitude.isFinite && (-90 ... 90).contains(latitude)
            && longitude.isFinite && (-180 ... 180).contains(longitude)
            && accuracyM.isFinite && accuracyM >= 0
            && timestampMs.isFinite && (0 ... 9_007_199_254_740_991).contains(timestampMs)
            && (altitudeM.map { $0.isFinite && (-20000 ... 100_000).contains($0) } ?? true)
            && (speedMps.map { $0.isFinite && (0 ... 1000).contains($0) } ?? true)
            && (bearingDeg.map { $0.isFinite && (0 ... 360).contains($0) } ?? true)
    }

    /// Great-circle distance in metres, using Foundation's standard trigonometric functions.
    func distance(to other: Self) -> Double {
        let radians = Double.pi / 180
        let a = pow(sin((other.latitude - latitude) * radians / 2), 2)
            + cos(latitude * radians) * cos(other.latitude * radians)
            * pow(sin((other.longitude - longitude) * radians / 2), 2)
        return 6_371_000 * 2 * asin(sqrt(min(1, max(0, a))))
    }
}

enum PrototypeLocationAuthorization: Equatable, Sendable {
    case notDetermined, denied, restricted, authorizedPrecise, authorizedApproximate

    var authorized: Bool { self == .authorizedPrecise || self == .authorizedApproximate }
}

enum PrototypeLocationSourceError: Error {
    case unavailable, timeout, permissionDenied, platformError
}

@MainActor
protocol PrototypeLocationSource: AnyObject {
    var servicesEnabled: Bool { get }
    var authorization: PrototypeLocationAuthorization { get }
    func requestAuthorization() async
    func requestFix(accuracy: String) async throws -> PrototypeLocationFix
    func requestTemporaryFullAccuracy() async -> Bool
    func setUpdateAccuracy(_ accuracy: String)
    func startUpdates(
        minDistanceM: Double,
        _ handler: @escaping @MainActor @Sendable (PrototypeLocationFix) -> Void
    )
    func stopUpdates()
    func stop()
}

extension PrototypeLocationSource {
    func stop() {}

    /// Sources without a configurable accuracy can keep their native best-available policy.
    func setUpdateAccuracy(_: String) {}
}

@MainActor
final class PrototypeLocationModule: PrototypePlatformModule {
    let name = "location"
    let capability = "prototype_platform_location_v1"
    // Intentionally empty: availability must report a typed error instead of withholding membership.
    let requiredInfoPlistKeys: [String] = []
    private let source: any PrototypeLocationSource
    private let bundle: any PrototypeBundleReader
    private let clock: any PrototypeClock
    private var current: PrototypeLocationFix?
    private var block: JSONValue?
    private var started = false
    private var generation = 0
    private var updating = false
    private var lastUpdate: PrototypeLocationFix?
    private var deliveredAt: Int?
    private var latest: PrototypeLocationFix?
    private var pending: (any PrototypeTimerHandle)?
    private var subscribers: [Int: AsyncStream<PlatformEvent>.Continuation] = [:]
    private var nextSubscriber = 0

    init(
        source: any PrototypeLocationSource,
        bundle: any PrototypeBundleReader = PrototypeMainBundleReader(),
        clock: any PrototypeClock = SystemPrototypeClock()
    ) {
        self.source = source
        self.bundle = bundle
        self.clock = clock
    }

    private var hasUsage: Bool { bundle.containsInfoPlistKey("NSLocationWhenInUseUsageDescription") }
    var state: [String: JSONValue] {
        ["current": current?.json ?? .object([:]), "servicesEnabled": .bool(hasUsage && source.servicesEnabled)]
    }

    var events: AsyncStream<PlatformEvent> {
        started = true
        startIfAuthorized()
        let (stream, continuation) = AsyncStream.makeStream(
            of: PlatformEvent.self, bufferingPolicy: .bufferingNewest(8)
        )
        let id = nextSubscriber
        nextSubscriber += 1
        subscribers[id] = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.subscribers[id] = nil }
        }
        return stream
    }

    func availability() -> PlatformAvailability {
        guard hasUsage else { return .unavailable("missing_usage_description") }
        return source.servicesEnabled ? .ready : .unavailable("disabled")
    }

    func call(_ call: PlatformCall) async -> PlatformCallResult {
        guard call.call == "location.request" else { return .failure(.unsupported, "Unknown call") }
        if case let .unavailable(reason) = availability() { return .failure(.unavailable, reason) }
        if let invalid = PrototypePlatformDriver.invalidArguments(call) { return invalid }
        started = true
        let requestGeneration = generation
        if source.authorization == .notDetermined { await source.requestAuthorization() }
        guard !Task.isCancelled, generation == requestGeneration else {
            return .failure(.cancelled, "Location request cancelled")
        }
        guard source.authorization.authorized else { return .failure(.permissionDenied, "Location permission denied") }
        let accuracy = call.args["accuracy"]?.stringValue ?? "precise"
        if accuracy == "precise", source.authorization == .authorizedApproximate,
           bundle.containsInfoPlistKey("NSLocationTemporaryUsageDescriptionDictionary")
        {
            _ = await source.requestTemporaryFullAccuracy()
        }
        guard !Task.isCancelled, generation == requestGeneration else {
            return .failure(.cancelled, "Location request cancelled")
        }
        if case let .unavailable(reason) = availability() { return .failure(.unavailable, reason) }
        guard source.authorization.authorized else { return .failure(.permissionDenied, "Location permission denied") }
        startIfAuthorized()
        let maxAge = call.args["maxAgeMs"]?.numberValue ?? 0
        if var fix = current, Double(clock.nowMilliseconds) - fix.timestampMs >= 0,
           Double(clock.nowMilliseconds) - fix.timestampMs <= maxAge
        {
            if source.authorization == .authorizedApproximate { fix.approximate = true }
            current = fix
            return .success(fix.json)
        }
        do {
            var fix = try await source.requestFix(accuracy: accuracy)
            try Task.checkCancellation()
            guard generation == requestGeneration else {
                return .failure(.cancelled, "Location request cancelled")
            }
            if source.authorization == .authorizedApproximate { fix.approximate = true }
            guard fix.valid else { return .failure(.platformError, "Invalid location fix") }
            current = fix
            refresh()
            return .success(fix.json)
        } catch is CancellationError {
            return .failure(.cancelled, "Location request cancelled")
        } catch PrototypeLocationSourceError.timeout {
            return .failure(.timeout, "Location request timed out")
        } catch PrototypeLocationSourceError.unavailable {
            return .failure(.unavailable, source.servicesEnabled ? "Location unavailable" : "disabled")
        } catch PrototypeLocationSourceError.permissionDenied {
            return .failure(.permissionDenied, "Location permission denied")
        } catch {
            return .failure(.platformError, "Location request failed")
        }
    }

    func stop() {
        guard started else { return }
        started = false
        generation += 1
        updating = false
        if hasUsage {
            source.stopUpdates()
            source.stop()
        }
        pending?.cancel()
        pending = nil
        subscribers.values.forEach { $0.finish() }
        subscribers = [:]
        current = nil
        latest = nil
        lastUpdate = nil
        deliveredAt = nil
    }

    func configure(root: JSONValue?) {
        if updating { source.stopUpdates() }
        updating = false
        pending?.cancel()
        pending = nil
        latest = nil
        lastUpdate = nil
        deliveredAt = nil
        block = root
        startIfAuthorized()
    }

    private var minDistance: Double { block?.objectFields?["minDistanceM"]?.numberValue ?? 0 }
    private var minInterval: Int { Int(block?.objectFields?["minIntervalMs"]?.numberValue ?? 1000) }

    private func startIfAuthorized() {
        guard !updating, block != nil, hasUsage, source.servicesEnabled, source.authorization.authorized else { return }
        started = true
        updating = true
        source.setUpdateAccuracy(block?.objectFields?["accuracy"]?.stringValue ?? "precise")
        let updateGeneration = generation
        source.startUpdates(minDistanceM: minDistance) { [weak self] fix in
            guard let self, generation == updateGeneration else { return }
            receive(fix)
        }
    }

    private func receive(_ fix: PrototypeLocationFix) {
        guard updating, fix.valid, hasUsage, source.servicesEnabled, source.authorization.authorized else { return }
        var fix = fix
        if source.authorization == .authorizedApproximate { fix.approximate = true }
        // Compare against the last delivered fix, so a series of small moves can accumulate.
        if let lastUpdate, fix == lastUpdate || fix.distance(to: lastUpdate) < minDistance {
            latest = nil
            pending?.cancel()
            pending = nil
            return
        }
        latest = fix
        let elapsed = deliveredAt.map { max(0, clock.nowMilliseconds - $0) } ?? minInterval
        if elapsed >= minInterval {
            deliver()
        } else if pending == nil {
            pending = clock.schedule(afterMilliseconds: minInterval - elapsed) { [weak self] in
                MainActor.assumeIsolated { self?.deliver() }
            }
        }
    }

    private func deliver() {
        pending?.cancel()
        pending = nil
        guard updating, var fix = latest, hasUsage, source.servicesEnabled, source.authorization.authorized else {
            latest = nil
            return
        }
        latest = nil
        if source.authorization == .authorizedApproximate { fix.approximate = true }
        current = fix
        lastUpdate = fix
        deliveredAt = clock.nowMilliseconds
        refresh()
        if let summary = PrototypeLocationEventSummary.of(fix.json.objectFields ?? [:]) {
            subscribers.values.forEach { $0.yield(PlatformEvent(event: "location.updated", data: summary)) }
        }
    }

    private func refresh() { subscribers.values.forEach { $0.yield(.stateRefresh(name)) } }
}
