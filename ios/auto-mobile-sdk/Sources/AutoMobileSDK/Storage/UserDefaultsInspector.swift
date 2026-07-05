import Foundation

/// Debug-time UserDefaults inspection.
/// iOS equivalent of Android's SharedPreferencesInspector.
public final class UserDefaultsInspector: @unchecked Sendable {
    public static let shared = UserDefaultsInspector()

    private let lock = NSLock()
    private var _isEnabled = false
    private var _driver: UserDefaultsDriver?

    private init() {}

    private var changeListeners: [UserDefaultsChangeListener] = []
    private var buffer: SdkEventBuffer?
    private var sequenceCounter: Int64 = 0
    private var kvoObserver: NSObjectProtocol?

    /// Last-observed key→value snapshot per suite, keyed by ``suiteKey(_:)``.
    /// `UserDefaults.didChangeNotification` does not identify which key changed,
    /// so we diff the current suite contents against this snapshot to recover the
    /// real changed key, value, type, and add/modify/remove change kind.
    private var lastSnapshots: [String: [String: KeyValuePair]] = [:]

    func initialize(buffer: SdkEventBuffer? = nil) {
        lock.lock()
        defer { lock.unlock() }
        _driver = DefaultUserDefaultsDriver()
        self.buffer = buffer
    }

    /// Whether inspection is enabled.
    public var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isEnabled
    }

    /// Enable or disable inspection.
    public func setEnabled(_ enabled: Bool) {
        lock.lock()
        _isEnabled = enabled
        lock.unlock()
    }

    /// Get the driver for direct access.
    public func getDriver() -> UserDefaultsDriver? {
        lock.lock()
        defer { lock.unlock() }
        guard _isEnabled else { return nil }
        return _driver
    }

    // MARK: - Change Listeners

    /// Register a listener for UserDefaults changes.
    public func addChangeListener(_ listener: UserDefaultsChangeListener) {
        lock.lock()
        changeListeners.append(listener)
        lock.unlock()
    }

    /// Remove a change listener.
    public func removeChangeListener(_ listener: UserDefaultsChangeListener) {
        lock.lock()
        changeListeners.removeAll { $0 === listener }
        lock.unlock()
    }

    /// Start listening for changes on a specific UserDefaults suite.
    /// Safe to call multiple times — previous observer is unregistered first.
    ///
    /// Uses `NotificationCenter` + snapshot-diffing rather than per-key KVO or
    /// setter swizzling: `UserDefaults.didChangeNotification` doesn't name the
    /// changed key, per-key KVO on `UserDefaults` is fragile, and swizzling is
    /// too invasive for a debug-only SDK.
    ///
    /// Note: for the standard suite (`suiteName == nil`) the driver reads
    /// `UserDefaults.standard.dictionaryRepresentation()`, which includes
    /// `NSGlobalDomain` system keys — prefer an app-group suite to avoid
    /// system-pref churn in the telemetry (see follow-up on noise filtering).
    public func startListening(suiteName: String? = nil) {
        guard isEnabled else { return }

        // Remove any existing observer before registering a new one
        stopListening()

        let defaults = suiteName.map { UserDefaults(suiteName: $0) } ?? UserDefaults.standard
        guard let defaults = suiteName != nil ? defaults : UserDefaults.standard else { return }

        // Seed the baseline BEFORE registering the observer. If a write on
        // another thread raced observer installation, the notification could
        // enter `handleDidChange` with no snapshot yet and diff against `[:]`,
        // reporting every pre-existing key as a spurious "add". Seeding first
        // closes that window; a write in the (now inverted) gap between seeding
        // and registration is simply picked up as a normal change on the next
        // notification rather than a burst of phantom adds.
        captureBaseline(suiteName: suiteName)

        let observer = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: defaults,
            queue: nil
        ) { [weak self] _ in
            self?.handleDidChange(suiteName: suiteName)
        }

        lock.lock()
        kvoObserver = observer
        lock.unlock()
    }

    /// Stop listening for changes.
    public func stopListening() {
        lock.lock()
        if let observer = kvoObserver {
            NotificationCenter.default.removeObserver(observer)
            kvoObserver = nil
        }
        lock.unlock()
    }

    /// Record the current contents of a suite as the baseline for future diffs.
    /// Internal (not private) so tests can seed a snapshot without registering a
    /// live `NotificationCenter` observer.
    func captureBaseline(suiteName: String?) {
        lock.lock()
        defer { lock.unlock() }
        guard let driver = _driver else { return }
        lastSnapshots[Self.suiteKey(suiteName)] = Self.snapshotDict(driver.getValues(suiteName: suiteName))
    }

    /// Handle a `UserDefaults.didChangeNotification` by diffing the suite's
    /// current contents against the last snapshot and emitting one
    /// `SdkStorageChangedEvent` per changed key. Internal so tests can drive it
    /// deterministically without relying on the KVO callback firing.
    func handleDidChange(suiteName: String?) {
        // Read the enabled state up front (both getters lock, and NSLock isn't
        // recursive). When disabled we still refresh the baseline below but skip
        // emitting — otherwise changes made during a disabled window would leak
        // out on the first notification after re-enable, diffed against a stale
        // pre-disable snapshot.
        let enabled = AutoMobileSDK.shared.isEnabled && isEnabled

        lock.lock()
        guard let driver = _driver else {
            lock.unlock()
            return
        }
        let currentBuffer = buffer
        let currentListeners = changeListeners
        let suiteKey = Self.suiteKey(suiteName)
        let previous = lastSnapshots[suiteKey] ?? [:]

        // Snapshot + diff + sequence allocation are done under the lock so
        // overlapping notifications can't diff against the same stale snapshot
        // and double-emit. The driver read is in-memory (fake) or a fast
        // UserDefaults read (real), so holding the lock briefly is acceptable.
        let current = Self.snapshotDict(driver.getValues(suiteName: suiteName))
        lastSnapshots[suiteKey] = current

        guard enabled else {
            // Baseline advanced silently so the disabled window is not replayed.
            lock.unlock()
            return
        }

        let changes = Self.diff(previous: previous, current: current)
        var events: [SdkStorageChangedEvent] = []
        events.reserveCapacity(changes.count)
        for change in changes {
            sequenceCounter += 1
            events.append(SdkStorageChangedEvent(
                suiteName: suiteName,
                key: change.key,
                newValue: change.newValue,
                previousValue: change.previousValue,
                valueType: change.valueType,
                changeType: change.changeType,
                sequenceNumber: sequenceCounter
            ))
        }
        lock.unlock()

        for event in events {
            for listener in currentListeners {
                listener.onPreferenceChanged(suiteName: suiteName, key: event.key)
            }
            currentBuffer?.add(event)
        }
    }

    // MARK: - Diff Helpers

    /// A single detected change: the key, its new value/type (nil/type of the
    /// removed value for a removal), the prior value (nil for an add), and the
    /// add/modify/remove kind.
    private struct StorageChange {
        let key: String
        let newValue: String?
        let previousValue: String?
        let valueType: String
        let changeType: String
    }

    /// Stable key used to bucket snapshots per suite. `nil` (the standard
    /// suite) can't collide with a real suite name because the sentinel starts
    /// with a NUL, which is not valid in a suite name.
    private static func suiteKey(_ suiteName: String?) -> String {
        suiteName ?? "\u{0}__standard__"
    }

    private static func snapshotDict(_ pairs: [KeyValuePair]) -> [String: KeyValuePair] {
        var dict: [String: KeyValuePair] = [:]
        dict.reserveCapacity(pairs.count)
        for pair in pairs {
            dict[pair.key] = pair
        }
        return dict
    }

    /// Diff two key→value snapshots into per-key changes, sorted by key so
    /// sequence numbers and emission order are deterministic.
    private static func diff(
        previous: [String: KeyValuePair],
        current: [String: KeyValuePair]
    ) -> [StorageChange] {
        var changes: [StorageChange] = []

        for (key, pair) in current {
            if let prior = previous[key] {
                // Compare type as well as value: a real type change with the same
                // string representation (e.g. Int 1 -> String "1") is still a
                // modification the telemetry surfaces via valueType.
                if prior.value != pair.value || prior.type != pair.type {
                    changes.append(StorageChange(
                        key: key, newValue: pair.value, previousValue: prior.value,
                        valueType: pair.type.rawValue, changeType: "modify"
                    ))
                }
            } else {
                changes.append(StorageChange(
                    key: key, newValue: pair.value, previousValue: nil,
                    valueType: pair.type.rawValue, changeType: "add"
                ))
            }
        }

        for (key, prior) in previous where current[key] == nil {
            changes.append(StorageChange(
                key: key, newValue: nil, previousValue: prior.value,
                valueType: prior.type.rawValue, changeType: "remove"
            ))
        }

        return changes.sorted { $0.key < $1.key }
    }

    // MARK: - Testing Support

    internal func setDriver(_ driver: UserDefaultsDriver) {
        lock.lock()
        _driver = driver
        lock.unlock()
    }

    internal func reset() {
        stopListening()
        lock.lock()
        _isEnabled = false
        _driver = nil
        buffer = nil
        changeListeners.removeAll()
        sequenceCounter = 0
        lastSnapshots.removeAll()
        lock.unlock()
    }
}

// MARK: - Change Listener Protocol

/// Listener for UserDefaults changes.
public protocol UserDefaultsChangeListener: AnyObject {
    func onPreferenceChanged(suiteName: String?, key: String?)
}

// MARK: - UserDefaultsDriver Protocol

/// Interface for UserDefaults operations, enabling test faking.
public protocol UserDefaultsDriver: Sendable {
    /// List available UserDefaults suites.
    func getSuites() -> [UserDefaultsSuiteDescriptor]

    /// Get all key-value pairs from a suite.
    func getValues(suiteName: String?) -> [KeyValuePair]

    /// Get a single value.
    func getValue(suiteName: String?, key: String) -> KeyValuePair?

    /// Set a value.
    func setValue(suiteName: String?, key: String, value: Any?, type: KeyValueType)

    /// Remove a value.
    func removeValue(suiteName: String?, key: String)

    /// Clear all values in a suite.
    func clear(suiteName: String?)
}

// MARK: - Data Types

/// Describes a UserDefaults suite with its name and entry count.
public struct UserDefaultsSuiteDescriptor: Sendable {
    public let name: String?
    public let displayName: String
    public let entryCount: Int

    public init(name: String?, displayName: String, entryCount: Int) {
        self.name = name
        self.displayName = displayName
        self.entryCount = entryCount
    }
}

/// A key-value pair from UserDefaults with its type.
public struct KeyValuePair: Sendable {
    public let key: String
    public let value: String?
    public let type: KeyValueType

    public init(key: String, value: String?, type: KeyValueType) {
        self.key = key
        self.value = value
        self.type = type
    }
}

/// The data type of a UserDefaults value.
public enum KeyValueType: String, Sendable {
    case string
    case int
    case double
    case bool
    case data
    case date
    case array
    case dictionary
    case unknown
}

// MARK: - Default Implementation

final class DefaultUserDefaultsDriver: UserDefaultsDriver, @unchecked Sendable {
    /// Resolve the UserDefaults instance for a suite name.
    /// Returns nil for non-nil suite names that can't be created (e.g., unconfigured app groups).
    /// Returns .standard when suiteName is nil.
    private func resolveDefaults(suiteName: String?) -> UserDefaults? {
        if let name = suiteName {
            return UserDefaults(suiteName: name)
        }
        return .standard
    }

    func getSuites() -> [UserDefaultsSuiteDescriptor] {
        let standard = UserDefaults.standard.dictionaryRepresentation()
        return [
            UserDefaultsSuiteDescriptor(
                name: nil,
                displayName: "Standard",
                entryCount: standard.count
            ),
        ]
    }

    func getValues(suiteName: String?) -> [KeyValuePair] {
        guard let defaults = resolveDefaults(suiteName: suiteName) else { return [] }
        return defaults.dictionaryRepresentation().map { key, value in
            KeyValuePair(key: key, value: "\(value)", type: typeOf(value))
        }.sorted { $0.key < $1.key }
    }

    func getValue(suiteName: String?, key: String) -> KeyValuePair? {
        guard let defaults = resolveDefaults(suiteName: suiteName) else { return nil }
        guard let value = defaults.object(forKey: key) else { return nil }
        return KeyValuePair(key: key, value: "\(value)", type: typeOf(value))
    }

    func setValue(suiteName: String?, key: String, value: Any?, type: KeyValueType) {
        #if DEBUG
        guard let defaults = resolveDefaults(suiteName: suiteName) else { return }
        defaults.set(value, forKey: key)
        #endif
    }

    func removeValue(suiteName: String?, key: String) {
        #if DEBUG
        guard let defaults = resolveDefaults(suiteName: suiteName) else { return }
        defaults.removeObject(forKey: key)
        #endif
    }

    func clear(suiteName: String?) {
        #if DEBUG
        guard let defaults = resolveDefaults(suiteName: suiteName) else { return }
        for key in defaults.dictionaryRepresentation().keys {
            defaults.removeObject(forKey: key)
        }
        #endif
    }

    private func typeOf(_ value: Any) -> KeyValueType {
        switch value {
        case is String: return .string
        case is Int: return .int
        case is Double, is Float: return .double
        case is Bool: return .bool
        case is Data: return .data
        case is Date: return .date
        case is [Any]: return .array
        case is [String: Any]: return .dictionary
        default: return .unknown
        }
    }
}
