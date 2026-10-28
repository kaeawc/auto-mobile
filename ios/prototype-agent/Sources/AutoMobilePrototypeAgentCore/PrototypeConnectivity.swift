import Foundation

/// One reading of the current network path (#14273), as NWPathMonitor reports it.
struct PrototypeConnectivityReading: Equatable, Sendable {
    enum Interface: Sendable { case wifi, cellular, wiredEthernet, other }

    let satisfied: Bool
    /// The path's interface types, in any order.
    let interfaces: Set<Interface>
    let expensive: Bool
    let constrained: Bool

    static let offline = PrototypeConnectivityReading(
        satisfied: false, interfaces: [], expensive: false, constrained: false
    )

    /// `/platform/connectivity`. A path with no interface is offline on `none`; otherwise the
    /// transport is the first of Wi-Fi, cellular and wired Ethernet the path uses, else `other`
    /// (a VPN's utun interface reports as other). `constrained` is Low Data Mode.
    var state: [String: JSONValue] {
        let transport: String = if interfaces.isEmpty {
            "none"
        } else if interfaces.contains(.wifi) {
            "wifi"
        } else if interfaces.contains(.cellular) {
            "cellular"
        } else if interfaces.contains(.wiredEthernet) {
            "ethernet"
        } else {
            "other"
        }
        let attached = !interfaces.isEmpty
        return [
            "online": .bool(satisfied && attached),
            "transport": .string(transport),
            "metered": .bool(attached && expensive),
            "constrained": .bool(attached && constrained),
        ]
    }
}

/// Live path readings. The system source wraps NWPathMonitor; tests drive a fake.
@MainActor
protocol PrototypeConnectivitySource: AnyObject {
    func start(_ update: @escaping @MainActor @Sendable (PrototypeConnectivityReading) -> Void)
    func stop()
}

/// The `connectivity` module: state only, plus a trailing `connectivity.changed` once the path has
/// been quiet for the contract's debounce. The first reading after start is the baseline, not a
/// change, and a flap that settles back on the last delivered state is not an event. Like every
/// registered module it lives as long as its registry; the monitor starts on the first read.
@MainActor
final class PrototypeConnectivityModule: PrototypePlatformModule {
    let name = "connectivity"
    let capability = "prototype_platform_connectivity_v1"
    static let debounceMs = Int(
        PrototypeContractValidator.platformModules["connectivity"]?.objectFields?["events"]?
            .objectFields?["changed"]?.objectFields?["debounceMs"]?.numberValue ?? 500
    )

    private let source: any PrototypeConnectivitySource
    private let clock: PrototypeClock
    private var reading = PrototypeConnectivityReading.offline
    private var delivered: [String: JSONValue]?
    private var started = false
    private var pending: PrototypeTimerHandle?
    private var subscribers: [Int: AsyncStream<PlatformEvent>.Continuation] = [:]
    private var nextSubscriber = 0

    init(source: any PrototypeConnectivitySource, clock: PrototypeClock = SystemPrototypeClock()) {
        self.source = source
        self.clock = clock
    }

    var state: [String: JSONValue] {
        start()
        return reading.state
    }

    var events: AsyncStream<PlatformEvent> {
        start()
        let (stream, continuation) = AsyncStream.makeStream(
            of: PlatformEvent.self,
            bufferingPolicy: .bufferingNewest(8)
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
        .failure(.unsupported, "The connectivity module has no calls")
    }

    private func start() {
        guard !started else { return }
        started = true
        source.start { [weak self] reading in self?.receive(reading) }
    }

    private func receive(_ next: PrototypeConnectivityReading) {
        reading = next
        guard delivered != nil else {
            delivered = next.state
            return
        }
        pending?.cancel()
        pending = clock.schedule(afterMilliseconds: Self.debounceMs) { [weak self] in
            MainActor.assumeIsolated { self?.settle() }
        }
    }

    private func settle() {
        pending = nil
        let current = reading.state
        guard current != delivered else { return }
        delivered = current
        let event = PlatformEvent(event: "connectivity.changed", data: .object(current))
        subscribers.values.forEach { $0.yield(event) }
    }
}
