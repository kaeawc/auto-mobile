import Foundation

/// Pure iOS mappings, kept UIKit-free so the shared contract can be checked on the host.
enum PrototypeDeviceStatus {
    static func thermal(_ rawValue: Int) -> String? {
        let values = ["nominal", "fair", "serious", "critical"]
        return values.indices.contains(rawValue) ? values[rawValue] : nil
    }

    static func batteryState(_ rawValue: Int) -> String {
        let values = ["unknown", "unplugged", "charging", "full"]
        return values.indices.contains(rawValue) ? values[rawValue] : "unknown"
    }

    static func batteryLevel(_ level: Double) -> Double? { percent(level) }
    static func volume(_ volume: Double) -> Double? { percent(volume) }

    private static func percent(_ fraction: Double) -> Double? {
        guard fraction.isFinite, fraction >= 0 else { return nil }
        return (min(1, fraction) * 100).rounded()
    }

    /// Port raw values are strings; an empty route defaults to the built-in speaker.
    static func route(_ kind: String) -> String {
        switch kind {
        case "", "Speaker", "Receiver": "speaker"
        case "Headphones", "LineOut": "wired"
        case "BluetoothA2DPOutput", "BluetoothLE", "BluetoothHFP": "bluetooth"
        case "USBAudio": "usb"
        case "AirPlay": "airplay"
        default: "other"
        }
    }
}

/// Each source synchronously supplies its full baseline inside start, then reports system changes.
@MainActor
protocol PrototypeDeviceStatusSource: AnyObject {
    func start(_ update: @escaping @MainActor @Sendable ([String: JSONValue]) -> Void)
    func stop()
}

/// State refreshes immediately; only authored events wait for the trailing contract debounce.
@MainActor
final class PrototypeDeviceStatusModule: PrototypePlatformModule {
    let name: String
    let capability: String
    let debounceMs: Int
    private let source: any PrototypeDeviceStatusSource
    private let clock: PrototypeClock
    private var reading: [String: JSONValue] = [:]
    private var delivered: [String: JSONValue]?
    private var started = false
    private var pending: PrototypeTimerHandle?
    private var subscribers: [Int: AsyncStream<PlatformEvent>.Continuation] = [:]
    private var nextSubscriber = 0

    init(
        name: String,
        capability: String,
        source: any PrototypeDeviceStatusSource,
        clock: PrototypeClock = SystemPrototypeClock()
    ) {
        self.name = name
        self.capability = capability
        self.source = source
        self.clock = clock
        debounceMs = Int(
            PrototypeContractValidator.platformModules[name]?.objectFields?["events"]?
                .objectFields?["changed"]?.objectFields?["debounceMs"]?.numberValue ?? 500
        )
    }

    static func battery(source: any PrototypeDeviceStatusSource, clock: PrototypeClock = SystemPrototypeClock())
        -> PrototypeDeviceStatusModule
    {
        PrototypeDeviceStatusModule(
            name: "battery", capability: "prototype_platform_battery_v1", source: source, clock: clock
        )
    }

    static func power(source: any PrototypeDeviceStatusSource, clock: PrototypeClock = SystemPrototypeClock())
        -> PrototypeDeviceStatusModule
    {
        PrototypeDeviceStatusModule(
            name: "power", capability: "prototype_platform_power_v1", source: source, clock: clock
        )
    }

    static func audio(source: any PrototypeDeviceStatusSource, clock: PrototypeClock = SystemPrototypeClock())
        -> PrototypeDeviceStatusModule
    {
        PrototypeDeviceStatusModule(
            name: "audio", capability: "prototype_platform_audio_v1", source: source, clock: clock
        )
    }

    var state: [String: JSONValue] {
        start()
        return reading
    }

    var events: AsyncStream<PlatformEvent> {
        start()
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

    func availability() -> PlatformAvailability { .ready }

    func call(_: PlatformCall) async -> PlatformCallResult {
        .failure(.unsupported, "The \(name) module has no calls")
    }

    private func start() {
        guard !started else { return }
        started = true
        source.start { [weak self] in self?.receive($0) }
    }

    private func receive(_ next: [String: JSONValue]) {
        guard delivered != nil else {
            reading = next
            delivered = next
            return
        }
        guard next != reading else { return }
        reading = next
        subscribers.values.forEach { $0.yield(.stateRefresh(name)) }
        pending?.cancel()
        pending = clock.schedule(afterMilliseconds: debounceMs) { [weak self] in
            MainActor.assumeIsolated { self?.settle() }
        }
    }

    private func settle() {
        pending = nil
        guard reading != delivered else { return }
        delivered = reading
        let event = PlatformEvent(event: "\(name).changed", data: .object(reading))
        subscribers.values.forEach { $0.yield(event) }
    }
}
