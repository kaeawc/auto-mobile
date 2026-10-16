import Foundation

/// Why a stored entry was dropped on a show.
enum PrototypeStorageDropReason: String, Equatable {
    /// `storage.version` differs from the version the values were stored under.
    case version
    /// The spec no longer lists the key (or has no `storage` block).
    case unlisted
    /// The value no longer fits the spec.
    case mismatch
}

struct PrototypeStorageDrop: Equatable {
    let key: String
    let reason: PrototypeStorageDropReason
}

struct PrototypeStorageRestoreResult: Equatable {
    var state: [String: JSONValue]
    var data: [String: JSONValue]?
    /// Storage keys whose stored value replaced the spec's.
    var applied: [String] = []
    /// Stored entries to delete, with why.
    var dropped: [PrototypeStorageDrop] = []
}

/// The precedence rules for a prototype's stored values on a show (#12522, adopted decision), as one
/// pure function; the Swift twin of `restorePrototypeStorage` in
/// `src/features/prototype/prototypeStorageRestore.ts`:
///
/// - Stored values replace the spec's values for the keys the spec lists, unless `storage.version`
///   differs from the version they were stored under: then every stored value is discarded.
/// - A stored key the spec no longer lists is dropped; a spec with no `storage` block drops them all.
/// - A stored value that no longer fits the spec is dropped and the spec's value stands: a state value
///   whose type (string, finite number, boolean) differs from the spec's, a state key the spec no
///   longer declares, a data value of a different JSON kind than the spec's value at that pointer, or
///   a data value `PrototypeDataWrite` refuses as a `set` (a missing parent, a data limit).
///
/// Restoring emits no `change` and bumps no revision; the caller applies `state` and `data` before
/// the first draw.
enum PrototypeStorageRestore {
    static func restore(spec: PrototypeSpec, stored: PrototypeStoredValues?) -> PrototypeStorageRestoreResult {
        var result = PrototypeStorageRestoreResult(state: spec.state ?? [:], data: spec.data)
        guard let stored else { return result }
        let listed = Set(spec.storage?.keys ?? [])
        let versionChanged = spec.storage.map { $0.version != stored.version } ?? false
        // Sorted for determinism: a dictionary has no order and the TS twin iterates insertion order.
        for key in stored.values.keys.sorted() {
            guard let value = stored.values[key] else { continue }
            if !listed.contains(key) {
                result.dropped.append(.init(key: key, reason: .unlisted))
            } else if versionChanged {
                result.dropped.append(.init(key: key, reason: .version))
            } else if restoreOne(&result, key, value, spec) {
                result.applied.append(key)
            } else {
                result.dropped.append(.init(key: key, reason: .mismatch))
            }
        }
        return result
    }

    /// Applies one stored value onto the result; false leaves it untouched (the value does not fit).
    private static func restoreOne(
        _ result: inout PrototypeStorageRestoreResult, _ storageKey: String, _ value: JSONValue,
        _ spec: PrototypeSpec
    )
        -> Bool
    {
        switch PrototypeStorageKey.parse(storageKey) {
        case let .state(key):
            guard let declared = spec.state?[key], declared.isScalar, kind(declared) == kind(value),
                  value.numberValue?.isFinite ?? true else { return false }
            result.state[key] = value
            return true
        case let .data(pointer):
            if value == .null { return false }
            // Compare against the spec's own value, not the restore so far: an earlier stored key must
            // not change what "the spec's value" is for a later one.
            if let authored = PrototypeDataPointer.resolve(spec.data, pointer: pointer), kind(authored) != kind(value) {
                return false
            }
            guard case let .success(written) = PrototypeDataWrite.apply(
                result.data, op: .set, path: "/data" + pointer, value: value
            ) else { return false }
            result.data = written
            return true
        case nil:
            return false
        }
    }

    private static func kind(_ value: JSONValue) -> String {
        switch value {
        case .null: "null"
        case .bool: "boolean"
        case .number: "number"
        case .string: "string"
        case .array: "array"
        case .object: "object"
        }
    }
}
