import Foundation

enum PrototypeSensor: String, CaseIterable, Sendable {
    case orientation, light, proximity, steps, shake

    var keys: Set<String> {
        switch self {
        case .orientation: ["pitchDeg", "rollDeg", "headingDeg"]
        case .steps: ["steps"]
        case .proximity: ["proximityNear"]
        case .light, .shake: []
        }
    }
}

/// Steps are relative to the subscription's start date; acceleration includes gravity, in m/s².
enum PrototypeSensorSample: Sendable {
    case values([String: Double])
    case proximity(Bool)
    case acceleration(x: Double, y: Double, z: Double)
}

@MainActor
protocol PrototypeSensorSource: AnyObject {
    func hasSensor(_ sensor: PrototypeSensor) -> Bool
    /// False for denied/restricted motion authorization; notDetermined may start pedometer updates.
    var stepsAllowed: Bool { get }
    func start(
        _ sensor: PrototypeSensor, rateHz: Int,
        _ handler: @escaping @MainActor @Sendable (PrototypeSensorSample) -> Void
    )
    func stop()
}

/// Streaming port of prototypeSensorReference.ts. Only accepted writes advance a key's window.
struct PrototypeSensorFilter {
    let rateHz: Int
    private var writes: [String: (at: Int, value: Double)] = [:]

    init(rateHz: Int) {
        precondition((1 ... 30).contains(rateHz))
        self.rateHz = rateHz
    }

    mutating func write(key: String, raw: Double, at timestamp: Int) -> Double? {
        guard raw.isFinite else { return nil }
        let whole = floor(raw + 0.5)
        let value: Double
        switch key {
        case "headingDeg": value = (whole.truncatingRemainder(dividingBy: 360) + 360)
            .truncatingRemainder(dividingBy: 360)
        case "pitchDeg", "rollDeg": value = min(180, max(-180, whole))
        default: value = max(0, whole)
        }
        if let last = writes[key], value == last.value || Double(timestamp - last.at) < 1000 / Double(rateHz) {
            return nil
        }
        writes[key] = (timestamp, value)
        return value
    }
}

@MainActor
final class PrototypeSensorsModule: PrototypePlatformModule {
    let name = "sensors"
    let capability = "prototype_platform_sensors_v1"
    let requiredInfoPlistKeys: [String] = []
    private let source: any PrototypeSensorSource
    private let bundle: any PrototypeBundleReader
    private let clock: any PrototypeMonotonicClock
    private var block: JSONValue?
    private var generation = 0
    private var active: Set<PrototypeSensor> = []
    private var filters: [PrototypeSensor: PrototypeSensorFilter] = [:]
    private var lastShake: Int?
    private(set) var state: [String: JSONValue] = [:]
    private var subscribers: [Int: AsyncStream<PlatformEvent>.Continuation] = [:]
    private var nextSubscriber = 0

    init(
        source: any PrototypeSensorSource,
        bundle: any PrototypeBundleReader = PrototypeMainBundleReader(),
        clock: any PrototypeMonotonicClock = SystemPrototypeClock()
    ) {
        self.source = source
        self.bundle = bundle
        self.clock = clock
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
        return stream
    }

    func availability() -> PlatformAvailability { .ready }
    func call(_: PlatformCall) async -> PlatformCallResult { .failure(.unsupported, "Sensors has no calls") }

    /// `root` is the decoded root `sensors` block, just as location receives its own block.
    func configure(root: JSONValue?) {
        guard root == nil || root != block else { return }
        // Invalidate before stopping: even a synchronous callback from stop belongs to the old session.
        generation += 1
        active.removeAll()
        source.stop()
        filters.removeAll()
        lastShake = nil
        state.removeAll()
        block = root
        publish(.stateRefresh(name))
        guard let fields = root?.objectFields else { return }
        let session = generation
        for sensor in PrototypeSensor.allCases where sensor != .light && fields[sensor.rawValue] != nil {
            if sensor == .steps {
                guard bundle.containsInfoPlistKey("NSMotionUsageDescription"), source.stepsAllowed else { continue }
            }
            guard source.hasSensor(sensor) else { continue }
            let rawRate = fields[sensor.rawValue]?.objectFields?["rateHz"]?.numberValue ?? 1
            let rate = sensor == .orientation && rawRate.isFinite && (1 ... 30).contains(rawRate)
                && floor(rawRate) == rawRate ? Int(rawRate) : 1
            filters[sensor] = PrototypeSensorFilter(rateHz: rate)
            active.insert(sensor)
            source.start(sensor, rateHz: rate) { [weak self] sample in
                self?.receive(sample, sensor: sensor, session: session)
            }
        }
    }

    private func receive(_ sample: PrototypeSensorSample, sensor: PrototypeSensor, session: Int) {
        guard session == generation, active.contains(sensor) else { return }
        if sensor == .steps {
            guard bundle.containsInfoPlistKey("NSMotionUsageDescription"), source.stepsAllowed else { return }
        }
        let now = clock.monotonicMilliseconds
        switch sample {
        case let .values(values):
            receiveValues(values, sensor: sensor, now: now)
        case let .proximity(near):
            guard sensor == .proximity, state["proximityNear"] != .bool(near) else { return }
            // Discrete edges must never disappear inside a continuous sensor's throttle window.
            state["proximityNear"] = .bool(near)
            publish(.stateRefresh(name))
        case let .acceleration(x, y, z):
            guard sensor == .shake, x.isFinite, y.isFinite, z.isFinite,
                  hypot(hypot(x, y), z) / 9.80665 >= 2.7,
                  lastShake.map({ now - $0 >= 1000 }) ?? true else { return }
            lastShake = now
            publish(PlatformEvent(event: "sensors.shake", data: .object([:])))
        }
    }

    private func receiveValues(_ values: [String: Double], sensor: PrototypeSensor, now: Int) {
        guard sensor == .orientation || sensor == .steps else { return }
        var changed = false
        for (key, raw) in values where sensor.keys.contains(key) {
            if let value = filters[sensor]?.write(key: key, raw: raw, at: now) {
                state[key] = .number(value)
                changed = true
            }
        }
        if changed { publish(.stateRefresh(name)) }
    }

    private func publish(_ event: PlatformEvent) { subscribers.values.forEach { $0.yield(event) } }
}
