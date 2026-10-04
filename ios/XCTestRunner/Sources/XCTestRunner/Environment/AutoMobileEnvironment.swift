import Foundation

/// Immutable reader over a captured environment dictionary. A `Sendable` value type (the sole stored
/// property is an immutable `[String: String]`), so it can be shared freely across isolation domains.
struct AutoMobileEnvironment: Sendable {
    private let values: [String: String]

    init(values: [String: String] = ProcessInfo.processInfo.environment) {
        self.values = values
    }

    func firstNonEmpty(_ keys: [String]) -> String? {
        for key in keys {
            if let value = values[key], !value.isEmpty {
                return value
            }
        }
        return nil
    }

    func intValue(_ keys: [String]) -> Int? {
        if let stringValue = firstNonEmpty(keys) {
            return Int(stringValue)
        }
        return nil
    }

    /// Parse only the first non-empty key. Non-finite values (NaN or either infinity) return nil
    /// so callers can use their defaults; finite negative values remain valid.
    func doubleValue(_ keys: [String]) -> Double? {
        guard let stringValue = firstNonEmpty(keys),
              let value = Double(stringValue), value.isFinite
        else {
            return nil
        }
        return value
    }

    func boolValue(_ keys: [String]) -> Bool? {
        guard let value = firstNonEmpty(keys) else {
            return nil
        }
        return ["1", "true", "yes", "y"].contains(value.lowercased())
    }
}
