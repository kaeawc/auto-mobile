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
    /// Monotonic listen generation, bumped by `stopListening()`. `startListening()`
    /// captures it after its own stop and publishes only if it still matches, so a
    /// stop (or newer start) that interleaves with an in-flight registration invalidates
    /// it rather than leaving an observer live after teardown or leaking a duplicate.
    private var listenGeneration = 0

    /// Last-observed key→value snapshot per suite, keyed by ``suiteKey(_:)``.
    /// `UserDefaults.didChangeNotification` does not identify which key changed,
    /// so we diff the current suite contents against this snapshot to recover the
    /// real changed key, value, type, and add/modify/remove change kind.
    private var lastSnapshots: [String: [String: KeyValuePair]] = [:]

    func initialize(buffer: SdkEventBuffer? = nil) {
        lock.lock()
        _driver = DefaultUserDefaultsDriver()
        self.buffer = buffer
        let shouldAutoStart = _isEnabled && kvoObserver == nil
        lock.unlock()
        // If the host enabled inspection before AutoMobileSDK.initialize ran,
        // start listening now that a driver exists — see setEnabled(_:) for the
        // auto-start decision (#3193).
        if shouldAutoStart {
            startListening(suiteName: nil)
        }
    }

    /// Whether inspection is enabled.
    public var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isEnabled
    }

    /// Enable or disable inspection.
    ///
    /// Enabling auto-starts change listening on the standard suite (decision for
    /// #3193: auto-start over a desktop command handler or a separate host
    /// opt-in step, so `storage_changed` telemetry flows with the single
    /// `setEnabled(true)` call hosts already make). System-managed
    /// `NSGlobalDomain` keys are filtered out of the diff, see
    /// ``isSystemKey(_:)``. Hosts that want a specific app-group suite instead
    /// can call ``startListening(suiteName:)`` first — an already-registered
    /// observer is never replaced here.
    ///
    /// Disabling keeps the observer registered: ``handleDidChange(suiteName:)``
    /// silently advances the baseline while disabled, so changes made during a
    /// disabled window are not replayed on re-enable.
    public func setEnabled(_ enabled: Bool) {
        lock.lock()
        _isEnabled = enabled
        let shouldAutoStart = enabled && _driver != nil && kvoObserver == nil
        lock.unlock()
        // Auto-start only when a driver exists (initialize ran); otherwise
        // initialize(buffer:) starts listening once the driver is available,
        // ensuring the baseline is seeded from a real driver read.
        if shouldAutoStart {
            startListening(suiteName: nil)
        }
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
    /// Note: `dictionaryRepresentation()` merges `NSGlobalDomain` system keys
    /// (AppleLanguages, keyboard/accessibility toggles, …) into every suite's
    /// search list, so diff snapshots filter well-known system key prefixes —
    /// see ``isSystemKey(_:)`` — instead of emitting spurious `storage_changed`
    /// events for keys the app never touched.
    public func startListening(suiteName: String? = nil) {
        guard isEnabled else { return }

        // Atomically remove any current observer and claim this start's generation in a
        // SINGLE critical section. Capturing the generation in a separate lock after
        // stopListening() would be a TOCTOU: a concurrent stopListening() in the gap would
        // bump the generation and we'd capture *its* value, so our later equality guard
        // would wrongly succeed and publish an observer after that stop. Bumping and
        // capturing together means only a stop/start that runs AFTER this point can
        // invalidate us — exactly what the store-time guard checks.
        lock.lock()
        listenGeneration += 1
        let generation = listenGeneration
        if let observer = kvoObserver {
            NotificationCenter.default.removeObserver(observer)
            kvoObserver = nil
        }
        lock.unlock()

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
        // Reject our publication if the generation moved since we captured it — a
        // stopListening() (stop-during-start: don't leave an observer live after a stop)
        // or a newer startListening() (don't leak a duplicate) ran in between. Remove the
        // observer we just registered instead of storing it.
        guard generation == listenGeneration else {
            lock.unlock()
            NotificationCenter.default.removeObserver(observer)
            return
        }
        // Belt-and-suspenders: remove any observer a same-generation racer stored.
        if let existing = kvoObserver {
            NotificationCenter.default.removeObserver(existing)
        }
        kvoObserver = observer
        lock.unlock()
    }

    /// Stop listening for changes. Bumps `listenGeneration` so any startListening()
    /// registration still in flight is rejected rather than left live after the stop.
    public func stopListening() {
        lock.lock()
        listenGeneration += 1
        if let observer = kvoObserver {
            NotificationCenter.default.removeObserver(observer)
            kvoObserver = nil
        }
        lock.unlock()
    }

    /// Whether a change observer is currently registered. Internal so tests can
    /// assert the auto-start wiring without poking at the observer handle.
    var isListening: Bool {
        lock.lock()
        defer { lock.unlock() }
        return kvoObserver != nil
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

    /// Prefixes of system-managed defaults keys. `dictionaryRepresentation()`
    /// merges `NSGlobalDomain` (system prefs: `AppleLanguages`, `AppleLocale`,
    /// keyboard/accessibility toggles, `NSLinguisticData…`, `com.apple.*`, …)
    /// into every `UserDefaults` search list, and the OS churns those keys
    /// without the app touching them. Best-effort by prefix — an app-authored
    /// key starting with one of these (unconventional) would be filtered too.
    private static let systemKeyPrefixes = ["com.apple.", "NS", "Apple"]

    /// Whether a defaults key is system-managed noise that must be excluded
    /// from change telemetry. Internal so tests can pin the prefix set.
    static func isSystemKey(_ key: String) -> Bool {
        systemKeyPrefixes.contains { key.hasPrefix($0) }
    }

    /// Build a diff snapshot, dropping system-managed keys (see
    /// ``isSystemKey(_:)``). Filtering both the baseline and the current
    /// snapshot means system keys can never appear as an add, modify, or
    /// remove. Inspection reads via ``getDriver()`` are unaffected.
    private static func snapshotDict(_ pairs: [KeyValuePair]) -> [String: KeyValuePair] {
        // Later pairs win on duplicate keys, matching the prior append-order loop.
        Dictionary(
            pairs.lazy.filter { !isSystemKey($0.key) }.map { ($0.key, $0) },
            uniquingKeysWith: { _, last in last }
        )
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
            let type = Self.typeOf(value)
            return KeyValuePair(key: key, value: Self.encode(value, as: type), type: type)
        }.sorted { $0.key < $1.key }
    }

    func getValue(suiteName: String?, key: String) -> KeyValuePair? {
        guard let defaults = resolveDefaults(suiteName: suiteName) else { return nil }
        guard let value = defaults.object(forKey: key) else { return nil }
        let type = Self.typeOf(value)
        return KeyValuePair(key: key, value: Self.encode(value, as: type), type: type)
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

    /// ISO-8601 formatter with fractional seconds, so `Date` values round-trip
    /// to sub-second precision. `.withInternetDateTime` alone truncates to whole
    /// seconds; adding `.withFractionalSeconds` preserves the stored instant.
    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    /// Encode a UserDefaults value into a recoverable string for telemetry.
    ///
    /// Scalars (`string`/`int`/`double`/`bool`) keep their historic Swift
    /// interpolation. Complex types use a documented, round-trippable encoding
    /// so a downstream consumer can decode by `valueType`:
    /// - `date` → ISO-8601 with fractional seconds
    /// - `data` → base64
    /// - `array` / `dictionary` → JSON via `JSONSerialization`
    ///
    /// `array`/`dictionary` fall back to interpolation only when the collection
    /// holds non-JSON-native leaves (e.g. a nested `Data`/`Date`), which
    /// `JSONSerialization` cannot represent; the historic lossy form is strictly
    /// better than dropping the value.
    static func encode(_ value: Any, as type: KeyValueType) -> String {
        switch type {
        case .date:
            if let date = value as? Date {
                return iso8601.string(from: date)
            }
            return "\(value)"
        case .data:
            if let data = value as? Data {
                return data.base64EncodedString()
            }
            return "\(value)"
        case .array, .dictionary:
            // `.sortedKeys` makes dictionary encoding deterministic: the snapshot
            // diff compares encoded strings, and an unchanged dictionary re-read
            // with unstable key order would otherwise surface as a phantom modify.
            if JSONSerialization.isValidJSONObject(value),
               let json = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
               let string = String(data: json, encoding: .utf8) {
                return string
            }
            return "\(value)"
        case .string, .int, .double, .bool, .unknown:
            return "\(value)"
        }
    }

    /// Classify a UserDefaults value.
    ///
    /// Values from `UserDefaults` are NSNumber-bridged, so a plain `is Int` check
    /// (ordered before `is Bool`/`is Double`) misclassifies `Bool` (backed by
    /// `__NSCFBoolean`) and whole-number `Double` (e.g. `3.0`) as `.int`
    /// (issue #3628). Inspect the NSNumber's underlying representation instead:
    /// detect CFBoolean explicitly, then use `CFNumberIsFloatType` to split
    /// floating-point from integer.
    static func typeOf(_ value: Any) -> KeyValueType {
        switch value {
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return .bool
            }
            return CFNumberIsFloatType(number) ? .double : .int
        case is String: return .string
        case is Data: return .data
        case is Date: return .date
        case is [Any]: return .array
        case is [String: Any]: return .dictionary
        default: return .unknown
        }
    }
}
