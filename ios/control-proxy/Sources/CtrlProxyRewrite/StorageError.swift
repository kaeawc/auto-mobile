import Foundation

/// Errors surfaced by storage inspection. Ported verbatim from the reference
/// `DefaultStorageInspecting.swift`; the `errorDescription` strings are part of the
/// wire-visible error text. `Sendable` because it is thrown across the command
/// boundary in later phases.
public enum StorageError: LocalizedError, Sendable {
    case suiteNotFound(String)
    case invalidValue(String, String)
    case unsupportedType(String)
    case writeDisabled

    public var errorDescription: String? {
        switch self {
        case let .suiteNotFound(name):
            return "UserDefaults suite not found: \(name)"
        case let .invalidValue(value, type):
            return "Cannot parse '\(value)' as \(type)"
        case let .unsupportedType(type):
            return "Unsupported value type: \(type)"
        case .writeDisabled:
            return "Storage writes are disabled in release builds"
        }
    }
}
