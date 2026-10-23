import Foundation
import Observation

/// The app's persisted setting seam. Tests use an in-memory store instead of a defaults domain.
@MainActor
public protocol PrototypeLibraryNetworkSettingStore {
    func bool(forKey key: String) -> Bool
    func set(_ value: Bool, forKey key: String)
}

@MainActor
public struct PrototypeLibraryUserDefaultsSettingStore: PrototypeLibraryNetworkSettingStore {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func bool(forKey key: String) -> Bool { defaults.bool(forKey: key) }
    public func set(_ value: Bool, forKey key: String) { defaults.set(value, forKey: key) }
}

/// One app-wide switch, observed live by the library and every running imported prototype.
@MainActor
@Observable
public final class PrototypeLibraryNetworkSwitch {
    public static let key = "allowImportedPrototypeNetwork"
    private let store: any PrototypeLibraryNetworkSettingStore

    public let gate: PrototypeLibraryNetworkGate
    public private(set) var localNetworkDenied = false

    public func denyLocalNetwork() {
        guard enabled else { return }
        enabled = false
        localNetworkDenied = true
    }

    public var enabled: Bool {
        didSet {
            gate.setEnabled(enabled)
            store.set(enabled, forKey: Self.key)
            if enabled { localNetworkDenied = false }
        }
    }

    public init(store: any PrototypeLibraryNetworkSettingStore = PrototypeLibraryUserDefaultsSettingStore()) {
        self.store = store
        let restored = store.bool(forKey: Self.key)
        enabled = restored
        gate = PrototypeLibraryNetworkGate(enabled: restored)
    }
}
