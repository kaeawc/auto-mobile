import Foundation

/// A show with its stored values applied, ready for `PrototypeSession.show(_:restoredState:)`.
struct PrototypeStoragePreparation {
    /// The spec to show: the host's, with restored `data` swapped in and the drawn tree rebuilt.
    let spec: PrototypeSpec
    /// The session's initial state: the spec's with restored values over it.
    let state: [String: JSONValue]
    let applied: [String]
    let dropped: [PrototypeStorageDrop]
}

/// The `storage` object of `get_prototype_status` and the inspect entry (`PrototypeStorageReport` on
/// the host): `{version, keys: [{key, bytes}], totalBytes, skippedKeys?}`.
struct PrototypeStorageReport: Equatable {
    let version: Int
    let keys: [(key: String, bytes: Int)]
    let totalBytes: Int
    let skippedKeys: [String]

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.version == rhs.version && lhs.totalBytes == rhs.totalBytes && lhs.skippedKeys == rhs.skippedKeys
            && lhs.keys.map(\.key) == rhs.keys.map(\.key) && lhs.keys.map(\.bytes) == rhs.keys.map(\.bytes)
    }

    var wireObject: [String: Any] {
        var object: [String: Any] = [
            "version": version,
            "keys": keys.map { ["key": $0.key, "bytes": $0.bytes] as [String: Any] },
            "totalBytes": totalBytes,
        ]
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
        /// What the store holds for the id, as of the last successful write or the restore.
        var persisted: [String: JSONValue]
        /// The live value of each listed key at the last observation (absent: no value).
        var live: [String: JSONValue]
        var dirty: Set<String> = []
        var skipped: Set<String> = []
    }

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
        log: @escaping (String) -> Void = { NSLog("[AutoMobilePrototypeAgent] %@", $0) }
    ) {
        self.store = store
        self.clock = clock
        self.debounceMilliseconds = debounceMilliseconds
        self.maxBytes = maxBytes
        self.log = log
    }

    /// The real store: `Application Support/AutoMobilePrototypeAgent/storage` in the app's sandbox.
    /// Nil when the sandbox has no Application Support directory, in which case nothing persists.
    static func fileBacked(clock: PrototypeClock = SystemPrototypeClock()) -> PrototypeStorageCoordinator? {
        FilePrototypeStorageStore.defaultDirectory().map {
            PrototypeStorageCoordinator(store: FilePrototypeStorageStore(directory: $0), clock: clock)
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
        let unsaved = tracking.flatMap { $0.id == spec.id && !$0.dirty.isEmpty ? $0 : nil }
        tracking = nil
        let stored = loadStored(id: spec.id)
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
                        values: $0.values.filter { PrototypeStorageKey.parse($0.key).map(Self.isState) ?? false }
                    )
                }
                restored = PrototypeStorageRestore.restore(spec: spec, stored: Self.overlay(unsaved, on: stateOnly))
                restored.dropped = first.dropped + first.applied.filter { !restored.applied.contains($0) }
                    .map { PrototypeStorageDrop(key: $0, reason: .mismatch) }
            }
        }
        let kept = (stored?.values ?? [:]).filter { restored.applied.contains($0.key) }
        reconcile(id: spec.id, block: spec.storage, stored: stored, kept: kept)
        if let block = spec.storage {
            let keys = Self.entryKeys(block)
            var next = Tracking(
                id: spec.id, version: block.version, keys: keys, persisted: kept,
                live: Self.liveValues(keys, state: restored.state, data: shown.data)
            )
            // Restored values that are still not on disk stay dirty so the write is retried.
            let unsavedKeys = unsaved?.dirty ?? []
            next.dirty = Set(restored.applied.filter { unsavedKeys.contains($0) && next.live[$0] != kept[$0] })
            tracking = next
            if !next.dirty.isEmpty { scheduleFlush() }
        }
        return PrototypeStoragePreparation(
            spec: shown, state: restored.state, applied: restored.applied, dropped: restored.dropped
        )
    }

    /// The stored record with the unsaved (dirty) live values of a failed flush laid over it.
    private static func overlay(_ unsaved: Tracking?, on stored: PrototypeStoredValues?) -> PrototypeStoredValues? {
        guard let unsaved else { return stored }
        var values = stored?.version == unsaved.version ? stored?.values ?? [:] : [:]
        for raw in unsaved.dirty {
            values[raw] = unsaved.live[raw]
        }
        return PrototypeStoredValues(version: unsaved.version, values: values)
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
        let live = Self.liveValues(current.keys, state: session.state, data: session.data)
        let moved = current.keys.map(\.raw).filter { live[$0] != current.live[$0] }
        guard !moved.isEmpty else { return }
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
        guard var current = tracking, !current.dirty.isEmpty else { return }
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
        if var current = tracking, current.id == id {
            current.persisted = [:]
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
            skippedKeys: current.keys.map(\.raw).filter { current.skipped.contains($0) }
        )
    }

    // MARK: Helpers

    /// The listed keys that parse, each once, in the spec's order.
    private static func entryKeys(_ block: PrototypeStorageBlock) -> [EntryKey] {
        var seen = Set<String>()
        return block.keys.prefix(PrototypeLimits.maxStorageKeys).compactMap { raw in
            guard seen.insert(raw).inserted, let parsed = PrototypeStorageKey.parse(raw) else { return nil }
            return EntryKey(raw: raw, parsed: parsed)
        }
    }

    private static func liveValues(
        _ keys: [EntryKey], state: [String: JSONValue], data: [String: JSONValue]?
    )
        -> [String: JSONValue]
    {
        var values: [String: JSONValue] = [:]
        for entry in keys {
            switch entry.parsed {
            case let .state(key): values[entry.raw] = state[key]
            case let .data(pointer): values[entry.raw] = PrototypeDataPointer.resolve(data, pointer: pointer)
            }
        }
        return values
    }
}
