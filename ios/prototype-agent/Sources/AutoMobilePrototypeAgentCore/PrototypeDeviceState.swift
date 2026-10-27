import Foundation

enum PrototypeDeviceIdiom: String {
    case phone, pad, mac, vision

    var value: String {
        switch self {
        case .phone: "phone"
        case .pad: "tablet"
        case .mac, .vision: "desktop"
        }
    }
}

enum PrototypeDeviceSizeClass: String {
    case compact, regular
}

struct PrototypeDeviceState {
    let idiom: PrototypeDeviceIdiom
    let horizontalSizeClass: PrototypeDeviceSizeClass
    let windowWidth: Double
    let windowHeight: Double
    let systemVersion: String
    let pointer: Bool

    var snapshot: [String: JSONValue] {
        func points(_ value: Double) -> JSONValue {
            .number(value.isFinite ? min(65535, max(0, value.rounded())) : 0)
        }
        return ["device": .object([
            "os": .string("ios"), "osVersion": .string(String(systemVersion.prefix(64))),
            "idiom": .string(idiom.value), "sizeClass": .string(horizontalSizeClass.rawValue),
            "windowWidth": points(windowWidth), "windowHeight": points(windowHeight), "pointer": .bool(pointer),
        ])]
    }
}

/// Independent of data revisions and persistence; layout updates publish immediately.
final class PrototypeDeviceStateStore {
    private(set) var snapshot: [String: JSONValue] = [:]
    private let clock: PrototypeClock
    private let deliver: (String, JSONValue) -> Void
    private var handle: PrototypeTimerHandle?
    private var generation = 0
    static let debounceMs = Int(
        PrototypeContractValidator.platformModules["device"]?.objectFields?["events"]?.objectFields?["changed"]?
            .objectFields?["debounceMs"]?.numberValue ?? 250
    )

    init(clock: PrototypeClock, deliver: @escaping (String, JSONValue) -> Void) {
        self.clock = clock
        self.deliver = deliver
    }

    deinit { handle?.cancel() }

    func reset() {
        generation += 1
        handle?.cancel()
        handle = nil
        snapshot = [:]
    }

    @discardableResult
    func update(_ state: PrototypeDeviceState) -> Bool {
        let next = state.snapshot
        guard snapshot != next else { return false }
        let old = snapshot["device"]?.objectFields
        let device = next["device"]?.objectFields ?? [:]
        snapshot = next
        guard let old, ["sizeClass", "idiom"].contains(where: { old[$0] != device[$0] }) else { return true }
        generation += 1
        let scheduled = generation
        handle?.cancel()
        handle = clock.schedule(afterMilliseconds: Self.debounceMs) { [weak self] in
            guard let self, generation == scheduled else { return }
            handle = nil
            deliver("device.changed", snapshot["device"] ?? .object([:]))
        }
        return true
    }
}
