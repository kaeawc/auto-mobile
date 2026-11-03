import Foundation

/// Why a stored entry was dropped on a show.
enum PrototypeStorageDropReason: String, Equatable {
    /// `storage.version` differs from the version the values were stored under.
    case version
    /// The spec no longer lists the key (or has no `storage` block).
    case unlisted
    /// The value no longer fits the spec.
    case mismatch
    /// A secure key whose hardware key was revoked: its value is gone and the spec's value stands.
    case invalidated
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
    /// Biometric-bound secure keys holding a value that waits for `biometric.authenticate`.
    var locked: [String] = []
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
/// Secure keys (#14321, `storage.secure`) follow the same version and listing rules, read from
/// `PrototypeStoredValues.secure`:
///
/// - A secure value restores only into a key `storage.secure` lists, as a string of at most
///   `MAX_PROTOTYPE_SECURE_VALUE_BYTES` UTF-8 bytes into a declared string state key; otherwise it is
///   dropped as `mismatch`.
/// - A plaintext stored copy of a secure key is not in `storage.keys`, so it is dropped as `unlisted`.
/// - A biometric-bound key (`secureAuth: "biometric"`) holding a value is not read: its state holds
///   `""` and it is listed in `locked`. A biometric key with nothing stored is not locked.
/// - An invalidated key is dropped as `invalidated` and the spec's value stands.
///
/// Restoring emits no `change` and bumps no revision; the caller applies `state` and `data` before
/// the first draw.
enum PrototypeStorageRestore {
    /// `MAX_PROTOTYPE_SECURE_VALUE_BYTES`: the largest secure value, in UTF-8 bytes.
    static let maxSecureValueBytes = PrototypeContractValidator.limit("MAX_PROTOTYPE_SECURE_VALUE_BYTES")

    static func restore(spec: PrototypeSpec, stored: PrototypeStoredValues?) -> PrototypeStorageRestoreResult {
        var result = PrototypeStorageRestoreResult(state: spec.state ?? [:], data: spec.data)
        guard let stored else { return result }
        let listed = Set(spec.storage?.keys ?? [])
        let versionChanged = spec.storage.map { $0.version != stored.version } ?? false
        restoreSecure(&result, stored, spec: spec, versionChanged: versionChanged)
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

    /// Applies the secure store's values: dropped, locked behind biometrics, or written into state.
    private static func restoreSecure(
        _ result: inout PrototypeStorageRestoreResult, _ stored: PrototypeStoredValues, spec: PrototypeSpec,
        versionChanged: Bool
    ) {
        let invalidated = stored.invalidated ?? []
        for key in invalidated {
            result.dropped.append(.init(key: key, reason: .invalidated))
        }
        let secure = stored.secure ?? [:]
        // Sorted for determinism, as for plaintext values.
        for key in secure.keys.sorted() where !invalidated.contains(key) {
            guard let value = secure[key] else { continue }
            let reason = secureDropReason(key, value, spec: spec, versionChanged: versionChanged)
            guard reason == nil, case let .state(stateKey)? = PrototypeStorageKey.parse(key) else {
                result.dropped.append(.init(key: key, reason: reason ?? .mismatch))
                continue
            }
            if isBiometric(key, spec: spec) {
                result.state[stateKey] = .string("")
                result.locked.append(key)
            } else {
                result.state[stateKey] = value
                result.applied.append(key)
            }
        }
    }

    private static func isBiometric(_ key: String, spec: PrototypeSpec) -> Bool {
        spec.storage?.secureAuth?[key] == "biometric"
    }

    /// Why a secure value cannot restore, or nil when it fits (or waits for an unlock).
    private static func secureDropReason(
        _ key: String, _ value: JSONValue, spec: PrototypeSpec, versionChanged: Bool
    ) -> PrototypeStorageDropReason? {
        guard spec.storage?.secure?.contains(key) == true else { return .unlisted }
        if versionChanged { return .version }
        guard case let .state(stateKey)? = PrototypeStorageKey.parse(key),
              case .string? = spec.state?[stateKey] else { return .mismatch }
        // A biometric-bound value is sealed until authentication; only its presence is known here.
        if isBiometric(key, spec: spec) { return nil }
        guard case let .string(text) = value, text.utf8.count <= maxSecureValueBytes else { return .mismatch }
        return nil
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
