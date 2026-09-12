import Foundation

/// Default `StorageInspecting` implementation over `UserDefaults`. Ported from the
/// reference `DefaultStorageInspecting.swift`.
///
/// Rewrite archetype: a **stateless `Sendable`** wrapper. The reference carried a
/// mutable `registeredSuites` array (fed by `registerSuite(_:)`), which made the
/// class non-`Sendable`. That method had **no caller anywhere in the package**, so in
/// production `registeredSuites` was always empty and `listSuites()` only ever
/// reported the Standard suite. Dropping the dead mutable state (rather than guarding
/// it with a lock) is behavior-preserving for every real caller and leaves a type with
/// no stored state — genuinely `Sendable`, no `@unchecked`. `UserDefaults` is itself
/// thread-safe, so the read/write methods need no isolation. See STATUS §9 item 4.
public final class DefaultStorageInspecting: StorageInspecting {
    public init() {}

    // MARK: - StorageInspecting

    public func listSuites() -> [StorageSuiteInfo] {
        let standard = UserDefaults.standard.dictionaryRepresentation()
        return [StorageSuiteInfo(
            name: "Standard",
            displayName: "Standard",
            entryCount: standard.count
        )]
    }

    public func getEntries(suiteName: String?) -> [StorageEntry] {
        guard let defaults = resolveDefaults(suiteName: suiteName) else { return [] }
        return defaults.dictionaryRepresentation()
            .map { key, value in
                StorageEntry(key: key, value: stringValue(value), type: detectType(value))
            }
            .sorted { $0.key < $1.key }
    }

    public func getEntry(suiteName: String?, key: String) -> StorageEntry? {
        guard let defaults = resolveDefaults(suiteName: suiteName) else { return nil }
        guard let value = defaults.object(forKey: key) else { return nil }
        return StorageEntry(key: key, value: stringValue(value), type: detectType(value))
    }

    public func setEntry(suiteName: String?, key: String, value: String?, type: String) throws {
        #if DEBUG
            guard let defaults = resolveDefaults(suiteName: suiteName) else {
                throw StorageError.suiteNotFound(suiteName ?? "Standard")
            }

            if let value = value {
                let parsed = try parseValue(value, type: type)
                defaults.set(parsed, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        #else
            throw StorageError.writeDisabled
        #endif
    }

    public func removeEntry(suiteName: String?, key: String) throws {
        #if DEBUG
            guard let defaults = resolveDefaults(suiteName: suiteName) else {
                throw StorageError.suiteNotFound(suiteName ?? "Standard")
            }
            defaults.removeObject(forKey: key)
        #else
            throw StorageError.writeDisabled
        #endif
    }

    public func clearEntries(suiteName: String?) throws {
        #if DEBUG
            guard let defaults = resolveDefaults(suiteName: suiteName) else {
                throw StorageError.suiteNotFound(suiteName ?? "Standard")
            }
            for key in defaults.dictionaryRepresentation().keys {
                defaults.removeObject(forKey: key)
            }
        #else
            throw StorageError.writeDisabled
        #endif
    }

    // MARK: - Private Helpers

    private func resolveDefaults(suiteName: String?) -> UserDefaults? {
        if let name = suiteName {
            return UserDefaults(suiteName: name)
        }
        return .standard
    }

    /// Detect the type string for a UserDefaults value.
    /// Bool must be checked before Int because NSNumber represents both.
    private func detectType(_ value: Any) -> String {
        // CFBoolean check: NSNumber wraps both Bool and Int.
        // CFBooleanGetTypeID() reliably distinguishes true booleans.
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return "BOOLEAN"
            }
            // Use CFNumber type ID to distinguish integer vs floating-point.
            // This avoids intValue truncation (32-bit) and misclassifying
            // whole-number doubles like 1.0 as INT.
            let cfNumber = number as CFNumber
            let cfType = CFNumberGetType(cfNumber)
            switch cfType {
            case .sInt8Type, .sInt16Type, .sInt32Type, .sInt64Type,
                 .charType, .shortType, .intType, .longType, .longLongType,
                 .cfIndexType, .nsIntegerType:
                return "INT"
            default:
                return "DOUBLE"
            }
        }
        switch value {
        case is String:
            return "STRING"
        case is Data:
            return "DATA"
        case is Date:
            return "DATE"
        case is [Any]:
            return "ARRAY"
        case is [String: Any]:
            return "DICTIONARY"
        default:
            return "UNKNOWN"
        }
    }

    /// Convert a value to its string representation for the wire protocol.
    private func stringValue(_ value: Any) -> String {
        switch value {
        case let bool as Bool:
            return bool ? "true" : "false"
        case let string as String:
            return string
        case let int as Int:
            return "\(int)"
        case let double as Double:
            return "\(double)"
        case let data as Data:
            return data.base64EncodedString()
        case let date as Date:
            return ISO8601DateFormatter().string(from: date)
        case let array as [Any]:
            if let jsonData = try? JSONSerialization.data(withJSONObject: array),
               let jsonString = String(data: jsonData, encoding: .utf8)
            {
                return jsonString
            }
            return "\(array)"
        case let dict as [String: Any]:
            if let jsonData = try? JSONSerialization.data(withJSONObject: dict),
               let jsonString = String(data: jsonData, encoding: .utf8)
            {
                return jsonString
            }
            return "\(dict)"
        default:
            return "\(value)"
        }
    }

    /// Parse a string value into the native type for UserDefaults storage.
    private func parseValue(_ value: String, type: String) throws -> Any {
        switch type {
        case "STRING":
            return value
        case "INT":
            guard let intVal = Int(value) else {
                throw StorageError.invalidValue(value, type)
            }
            return intVal
        case "DOUBLE", "FLOAT":
            guard let doubleVal = Double(value) else {
                throw StorageError.invalidValue(value, type)
            }
            return doubleVal
        case "BOOLEAN":
            switch value.lowercased() {
            case "true", "1", "yes":
                return true
            case "false", "0", "no":
                return false
            default:
                throw StorageError.invalidValue(value, type)
            }
        case "DATA":
            guard let data = Data(base64Encoded: value) else {
                throw StorageError.invalidValue(value, type)
            }
            return data
        case "DATE":
            let formatter = ISO8601DateFormatter()
            guard let date = formatter.date(from: value) else {
                throw StorageError.invalidValue(value, type)
            }
            return date
        case "ARRAY":
            guard let data = value.data(using: .utf8),
                  let array = try? JSONSerialization.jsonObject(with: data) as? [Any]
            else {
                throw StorageError.invalidValue(value, type)
            }
            return array
        case "DICTIONARY":
            guard let data = value.data(using: .utf8),
                  let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                throw StorageError.invalidValue(value, type)
            }
            return dict
        default:
            throw StorageError.unsupportedType(type)
        }
    }
}
