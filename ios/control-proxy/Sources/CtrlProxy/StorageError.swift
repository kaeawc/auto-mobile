import Foundation

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
