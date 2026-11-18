import Foundation

/// A show with its stored values applied, ready for `PrototypeSession.show(_:restoredState:)`.
struct PrototypeStoragePreparation {
    /// The spec to show: the host's, with restored `data` swapped in and the drawn tree rebuilt.
    let spec: PrototypeSpec
    /// The session's initial state: the spec's with restored values over it.
    let state: [String: JSONValue]
    let applied: [String]
    let dropped: [PrototypeStorageDrop]
    var locked: [String] = []
    /// Restored stack paths by stack id, for `PrototypeSession.show(_:restoredStacks:)` (#14188).
    var stacks: [String: [PrototypeStackPathEntry]] = [:]
}

/// The `storage` object of `get_prototype_status` and the inspect entry (`PrototypeStorageReport` on
/// the host): `{version, keys: [{key, bytes}], totalBytes, skippedKeys?}`.
struct PrototypeStorageReport: Equatable {
    let version: Int
    let keys: [(key: String, bytes: Int)]
    let totalBytes: Int
    let skippedKeys: [String]
    var secure: [(key: String, present: Bool, bytes: Int)] = []

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.version == rhs.version && lhs.totalBytes == rhs.totalBytes && lhs.skippedKeys == rhs.skippedKeys
            && lhs.secure.map(\.key) == rhs.secure.map(\.key)
            && lhs.secure.map(\.present) == rhs.secure.map(\.present)
            && lhs.secure.map(\.bytes) == rhs.secure.map(\.bytes)
            && lhs.keys.map(\.key) == rhs.keys.map(\.key) && lhs.keys.map(\.bytes) == rhs.keys.map(\.bytes)
    }

    var wireObject: [String: Any] {
        var object: [String: Any] = [
            "version": version,
            "keys": keys.map { ["key": $0.key, "bytes": $0.bytes] as [String: Any] },
            "totalBytes": totalBytes,
        ]
        if !secure.isEmpty {
            object["secure"] = secure.map { ["key": $0.key, "present": $0.present, "bytes": $0.bytes] as [String: Any] }
        }
        if !skippedKeys.isEmpty { object["skippedKeys"] = skippedKeys }
        return object
    }
}

/// Loads a prototype's stored values on a show and writes them back after changes (#12526). It is the
/// only thing that touches a `PrototypeStorageStore`; `PrototypeSession` stays device-free. The owner
/// calls `prepare` before each show, `sessionChanged` after every transition and `flush` when the
/// process may end.
///
/// Writes are debounced on the injected clock (trailing: each change restarts the delay) and always
/// flushed when the prototype is dismissed or another is shown. Only keys the user or a device write
/// actually changed are stored; a restore stores nothing new and never counts as a change.
final class PrototypeStorageCoordinator {
    static let defaultDebounceMilliseconds = 400

    private struct EntryKey {
        let raw: String
        let parsed: PrototypeStorageKey
    }

    private struct Tracking {
        let id: String
        let version: Int
        let keys: [EntryKey]
        let secureKeys: [EntryKey]
        let listedSecureKeys: [String]
        var securePersisted: [String: JSONValue]
        var secureLive: [String: JSONValue]
        var secureDirty: Set<String> = []
        /// What the store holds for the id, as of the last successful write or the restore.
        var persisted: [String: JSONValue]
        /// The live value of each listed key at the last observation (absent: no value).
        var live: [String: JSONValue]
        var dirty: Set<String> = []
        var skipped: Set<String> = []
    }

    private let secure: (any PrototypeSecureValueStore)?
    private let store: PrototypeStorageStore
    private let clock: PrototypeClock
    private let log: (String) -> Void
    private let debounceMilliseconds: Int
    private let maxBytes: Int
    private var tracking: Tracking?
    private var timer: PrototypeTimerHandle?

    init(
        store: PrototypeStorageStore,
        clock: PrototypeClock,
        debounceMilliseconds: Int = PrototypeStorageCoordinator.defaultDebounceMilliseconds,
        maxBytes: Int = PrototypeLimits.maxStorageBytes,
        secure: (any PrototypeSecureValueStore)? = nil,
        log: @escaping (String) -> Void = { NSLog("[AutoMobilePrototypeAgent] %@", $0) }
    ) {
        self.secure = secure
        self.store = store
        self.clock = clock
        self.debounceMilliseconds = debounceMilliseconds
        self.maxBytes = maxBytes
        self.log = log
    }

    /// The real store: `Application Support/AutoMobilePrototypeAgent/storage` in the app's sandbox.
    /// Nil when the sandbox has no Application Support directory, in which case nothing persists.
    static func fileBacked(
        clock: PrototypeClock = SystemPrototypeClock(), secure: (any PrototypeSecureValueStore)? = nil
    )
        -> PrototypeStorageCoordinator?
    {
        FilePrototypeStorageStore.defaultDirectory().map {
            PrototypeStorageCoordinator(store: FilePrototypeStorageStore(directory: $0), clock: clock, secure: secure)
        }
    }

    // MARK: Show

    /// Applies the precedence rules to `spec` and the id's stored values, deletes what no longer fits
    /// and starts tracking the listed keys. Pending writes of the previous show are flushed first so
    /// a same-id replacement reads its own latest values back.
    func prepare(_ spec: PrototypeSpec) -> PrototypeStoragePreparation {
        flush()
        // A flush that failed leaves keys dirty. A same-id replacement restores from those values
        // (not the stale record on disk) and keeps retrying the write.
        let unsaved = tracking.flatMap { $0.id == spec.id && (!$0.dirty.isEmpty || !$0.secureDirty.isEmpty) ? $0 : nil }
        tracking = nil
        let plaintext = loadStored(id: spec.id)
        let loaded = loadSecure(spec: spec, plaintext: plaintext)
        let stored = loaded.stored
        var restored = PrototypeStorageRestore.restore(spec: spec, stored: Self.overlay(unsaved, on: stored))
        var shown = spec
        if restored.data != spec.data, let data = restored.data {
            do {
                shown = try spec.replacingData(data)
            } catch {
                // Restored data can break a limit the rebuilt tree enforces (repeat cells, text size):
                // that is a value that no longer fits, so restore again without the data entries.
                log("stored data for \(spec.id) does not fit the spec: \(error)")
                let first = restored
                let stateOnly = stored.map {
                    PrototypeStoredValues(
                        version: $0.version,
                        values: $0.values.filter { PrototypeStorageKey.parse($0.key).map(Self.isState) ?? false },
                        secure: $0.secure, invalidated: $0.invalidated
                    )
                }
                restored = PrototypeStorageRestore.restore(spec: spec, stored: Self.overlay(unsaved, on: stateOnly))
                restored.dropped = first.dropped + first.applied.filter { !restored.applied.contains($0) }
                    .map { PrototypeStorageDrop(key: $0, reason: .mismatch) }
            }
        }
        restored.dropped += loaded.dropped
        let secureKept = (stored?.secure ?? [:]).filter {
            restored.applied.contains($0.key) && spec.storage?.secure?.contains($0.key) == true
        }
        for key in Set(restored.dropped.map(\.key)).intersection(loaded.secureKeys).subtracting(secureKept.keys) {
            deleteSecure(id: spec.id, key: key)
        }
        let kept = (stored?.values ?? [:]).filter {
            restored.applied.contains($0.key) && !(spec.storage?.secure ?? []).contains($0.key)
        }
        reconcile(id: spec.id, block: spec.storage, stored: plaintext, kept: kept)
        if let block = spec.storage {
            let keys = Self.entryKeys(block)
            let secureKeys = secure == nil ? [] : Self.secureEntryKeys(block)
            var next = Tracking(
                id: spec.id, version: block.version, keys: keys,
                secureKeys: secureKeys, listedSecureKeys: block.secure ?? [],
                securePersisted: secureKept,
                secureLive: Self.liveValues(secureKeys, state: restored.state, data: nil, stacks: [:]),
                persisted: kept,
                live: Self.liveValues(
                    keys, state: restored.state, data: shown.data,
                    stacks: Self.initialStacks(shown, restored: restored.stacks)
                )
            )
            // Restored values that are still not on disk stay dirty so the write is retried.
            let unsavedKeys = unsaved?.dirty ?? []
            next.dirty = Set(restored.applied.filter { unsavedKeys.contains($0) && next.live[$0] != kept[$0] })
            next.secureDirty = Set(restored.applied.filter {
                unsaved?.secureDirty.contains($0) == true && next.secureLive[$0] != secureKept[$0]
            })
            tracking = next
            if !next.dirty.isEmpty || !next.secureDirty.isEmpty { scheduleFlush() }
        }
        return PrototypeStoragePreparation(
            spec: shown, state: restored.state, applied: restored.applied, dropped: restored.dropped,
            locked: restored.locked, stacks: restored.stacks
        )
    }

    /// The stored record with the unsaved (dirty) live values of a failed flush laid over it.
    private static func overlay(_ unsaved: Tracking?, on stored: PrototypeStoredValues?) -> PrototypeStoredValues? {
        guard let unsaved else { return stored }
        var values = stored?.version == unsaved.version ? stored?.values ?? [:] : [:]
        for raw in unsaved.dirty {
            values[raw] = unsaved.live[raw]
        }
        var secure = stored?.secure ?? [:]
        for raw in unsaved.secureDirty {
            secure[raw] = unsaved.secureLive[raw]
        }
        return PrototypeStoredValues(
            version: unsaved.version, values: values, secure: secure, invalidated: stored?.invalidated
        )
    }

    private static func isState(_ key: PrototypeStorageKey) -> Bool {
        if case .state = key { return true }
        return false
    }

    /// Rewrites the id's record when the restore dropped something, or removes it when nothing is left.
    private func reconcile(
        id: String, block: PrototypeStorageBlock?, stored: PrototypeStoredValues?, kept: [String: JSONValue]
    ) {
        guard let stored, kept != stored.values else { return }
        do {
            if kept.isEmpty || block == nil {
                try store.delete(id: id)
            } else if let block {
                try store.save(PrototypeStoredValues(version: block.version, values: kept), id: id)
            }
        } catch {
            log("could not update stored values for \(id): \(error)")
        }
    }

    private func loadStored(id: String) -> PrototypeStoredValues? {
        do {
            return try store.load(id: id)
        } catch {
            // A corrupt or unreadable record is not an error to the show: start from the spec's values
            // and replace the record on the next write.
            log("ignoring unreadable stored values for \(id): \(error)")
            do {
                try store.delete(id: id)
            } catch {
                log("could not remove unreadable stored values for \(id): \(error)")
            }
            return nil
        }
    }

    // MARK: Changes

    /// Observes the session after a transition: marks the listed keys whose live value moved and
    /// schedules the debounced write. A session that no longer shows the tracked prototype (dismissed)
    /// is flushed at once and untracked.
    func sessionChanged(_ session: PrototypeSession) {
        guard var current = tracking else { return }
        guard session.isShown else {
            flush()
            tracking = nil
            return
        }
        guard session.spec?.id == current.id else { return }
        let live = Self.liveValues(current.keys, state: session.state, data: session.data, stacks: session.stacks)
        let moved = current.keys.map(\.raw).filter { live[$0] != current.live[$0] }
        let secureLive = Self.liveValues(current.secureKeys, state: session.state, data: nil, stacks: [:])
        let secureMoved = current.secureKeys.map(\.raw).filter { secureLive[$0] != current.secureLive[$0] }
        guard !moved.isEmpty || !secureMoved.isEmpty else { return }
        current.secureLive = secureLive
        current.secureDirty.formUnion(secureMoved)
        current.live = live
        current.dirty.formUnion(moved)
        tracking = current
        scheduleFlush()
    }

    private func scheduleFlush() {
        timer?.cancel()
        timer = clock.schedule(afterMilliseconds: debounceMilliseconds) { [weak self] in
            self?.timer = nil
            self?.flush()
        }
    }

    /// Writes the changed keys now. A key whose value would take the id over `maxBytes` is not stored
    /// (its previous stored value stays) and is reported in `skippedKeys`; a key with no live value
    /// (a removed data member) is deleted from the record.
    func flush() {
        timer?.cancel()
        timer = nil
        guard var current = tracking else { return }
        flushSecure(&current)
        tracking = current
        guard !current.dirty.isEmpty else { return }
        var candidate = current.persisted
        var skipped = current.skipped
        for entry in current.keys where current.dirty.contains(entry.raw) {
            guard let value = current.live[entry.raw] else {
                candidate[entry.raw] = nil
                skipped.remove(entry.raw)
                continue
            }
            let others = PrototypeStorageBytes.total(candidate.filter { $0.key != entry.raw })
            if others + PrototypeStorageBytes.entry(entry.raw, value) > maxBytes {
                skipped.insert(entry.raw)
            } else {
                candidate[entry.raw] = value
                skipped.remove(entry.raw)
            }
        }
        if candidate != current.persisted {
            do {
                if candidate.isEmpty {
                    try store.delete(id: current.id)
                } else {
                    try store.save(PrototypeStoredValues(version: current.version, values: candidate), id: current.id)
                }
            } catch {
                // The values stay dirty, so the next change, dismiss or flush retries the write.
                log("could not store values for \(current.id): \(error)")
                return
            }
        }
        current.persisted = candidate
        current.skipped = skipped
        current.dirty = []
        tracking = current
    }

    // MARK: Host actions

    /// `clear_prototype_storage`: removes every stored value of `id` and returns how many keys it
    /// held. The prototype on screen is untouched, pending writes for it are discarded, and the next
    /// show starts from the spec's values.
    func clear(id: String) throws -> Int {
        if tracking?.id == id {
            timer?.cancel()
            timer = nil
        }
        var count = 0
        do {
            count = try store.load(id: id)?.values.count ?? 0
        } catch {
            // An unreadable record holds no usable keys; it is deleted below all the same.
            log("clearing unreadable stored values for \(id): \(error)")
        }
        try store.delete(id: id)
        count += try secure?.deleteAll(id: id) ?? 0
        if var current = tracking, current.id == id {
            current.persisted = [:]
            current.securePersisted = [:]
            current.secureDirty = []
            current.dirty = []
            current.skipped = []
            tracking = current
        }
        return count
    }

    /// The report for the tracked prototype `id`; nil when its spec declares no `storage`. Callers
    /// `flush()` first so it describes what is on disk.
    func report(id: String) -> PrototypeStorageReport? {
        guard let current = tracking, current.id == id else { return nil }
        let keys = current.keys.compactMap { entry in
            current.persisted[entry.raw].map { (key: entry.raw, bytes: PrototypeStorageBytes.entry(entry.raw, $0)) }
        }
        return PrototypeStorageReport(
            version: current.version,
            keys: keys,
            totalBytes: keys.reduce(0) { $0 + $1.bytes },
            skippedKeys: (current.keys.map(\.raw) + current.listedSecureKeys).filter { current.skipped.contains($0) },
            secure: current.listedSecureKeys.map { key in
                let value = current.securePersisted[key]?.stringValue
                return (key: key, present: value != nil, bytes: value?.utf8.count ?? 0)
            }
        )
    }

    // MARK: Helpers

    /// The listed keys that parse, each once, in the spec's order.
    private static func entryKeys(_ block: PrototypeStorageBlock) -> [EntryKey] {
        var seen = Set<String>()
        return block.keys.filter { !(block.secure ?? []).contains($0) }.prefix(PrototypeLimits.maxStorageKeys)
            .compactMap { raw in
                guard seen.insert(raw).inserted, let parsed = PrototypeStorageKey.parse(raw) else { return nil }
                return EntryKey(raw: raw, parsed: parsed)
            }
    }

    /// Biometric-bound keys remain live state only until an authentication runtime owns sealing.
    private static func secureEntryKeys(_ block: PrototypeStorageBlock) -> [EntryKey] {
        (block.secure ?? []).compactMap { raw in
            guard block.secureAuth?[raw] == nil, case let .state(key)? = PrototypeStorageKey.parse(raw) else {
                return nil
            }
            return EntryKey(raw: raw, parsed: .state(key))
        }
    }

    private func loadSecure(
        spec: PrototypeSpec, plaintext: PrototypeStoredValues?
    )
        -> (stored: PrototypeStoredValues?, dropped: [PrototypeStorageDrop], secureKeys: Set<String>)
    {
        guard let secure else { return (plaintext, [], []) }
        do {
            let read = try secure.readAll(id: spec.id)
            var values: [String: JSONValue] = [:]
            var dropped: [PrototypeStorageDrop] = []
            let all = Set(read.entries.keys).union(read.invalidated)
            for key in read.entries.keys.sorted() where !read.invalidated.contains(key) {
                guard let entry = read.entries[key] else { continue }
                if let block = spec.storage, entry.version != block.version {
                    dropped.append(.init(key: key, reason: .version))
                } else if spec.storage?.secureAuth?[key] != nil {
                    // Do not restore an ordinary Keychain item into a biometric-bound state key.
                    dropped.append(.init(key: key, reason: .mismatch))
                } else {
                    values[key] = .string(entry.value)
                }
            }
            var stored = plaintext ?? PrototypeStoredValues(version: spec.storage?.version ?? 1, values: [:])
            if let block = spec.storage, stored.version != block.version {
                dropped += stored.values.keys.sorted().map { key in
                    .init(key: key, reason: block.keys.contains(key) ? .version : .unlisted)
                }
                stored.values = [:]
                stored.version = block.version
            }
            stored.secure = values
            stored.invalidated = read.invalidated.sorted()
            return (stored, dropped, all)
        } catch {
            // Temporary Keychain failures leave items intact. Never log an error carrying a value.
            log("could not read secure storage")
            return (plaintext, [], [])
        }
    }

    private func deleteSecure(id: String, key: String) {
        do { try secure?.delete(id: id, key: key) }
        catch { log("could not delete secure storage entry") }
    }

    private func flushSecure(_ current: inout Tracking) {
        guard let secure else { return }
        for key in current.secureKeys.map(\.raw) where current.secureDirty.contains(key) {
            let value = current.secureLive[key]
            if let value,
               value.stringValue == nil || (value.stringValue?.utf8.count ?? 0) > PrototypeStorageRestore
               .maxSecureValueBytes
            {
                current.skipped.insert(key)
                current.secureDirty.remove(key)
                continue
            }
            do {
                if let text = value?.stringValue {
                    try secure.write(id: current.id, key: key, entry: .init(version: current.version, value: text))
                } else {
                    try secure.delete(id: current.id, key: key)
                }
                current.securePersisted[key] = value
                current.secureDirty.remove(key)
                current.skipped.remove(key)
            } catch {
                // Retain dirty state for the next flush or same-id replacement; never log a value.
                log("could not write secure storage entry")
            }
        }
    }

    /// Each stack's path as the show will start it: the restored one, else its start screen.
    private static func initialStacks(
        _ spec: PrototypeSpec, restored: [String: [PrototypeStackPathEntry]]
    )
        -> [String: PrototypeStackSnapshot]
    {
        var nodes: [String: PrototypeNode] = [:]
        spec.root.collectStacks(into: &nodes)
        return nodes.reduce(into: [:]) { result, stack in
            result[stack.key] = PrototypeStackSnapshot(
                entries: restored[stack.key] ?? [PrototypeStackPathEntry(screen: stack.value.start ?? "")]
            )
        }
    }

    private static func liveValues(
        _ keys: [EntryKey], state: [String: JSONValue], data: [String: JSONValue]?,
        stacks: [String: PrototypeStackSnapshot]
    )
        -> [String: JSONValue]
    {
        var values: [String: JSONValue] = [:]
        for entry in keys {
            switch entry.parsed {
            case let .state(key): values[entry.raw] = state[key]
            case let .data(pointer): values[entry.raw] = PrototypeDataPointer.resolve(data, pointer: pointer)
            case let .stack(id): values[entry.raw] = stacks[id].map(PrototypeStackRoutes.storedValue)
            }
        }
        return values
    }
}
