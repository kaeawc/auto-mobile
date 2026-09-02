import Foundation

/// Reads timing configuration from `UserDefaults` (preferred) then the environment. Keys such as
/// `automobile.junit.timing.enabled` / `.lookback.days` / `.limit` / `.min.samples` /
/// `.fetch.timeout.ms` / `.ordering` and `automobile.ci.mode` are the frozen config contract.
struct TimingConfig {
    private let defaults = UserDefaults.standard
    private let environment = ProcessInfo.processInfo.environment

    func stringValue(forKey key: String) -> String? {
        if let value = defaults.object(forKey: key) {
            if let stringValue = value as? String {
                return stringValue
            }
            return String(describing: value)
        }
        return environment[key]
    }

    func intValue(forKey key: String, defaultValue: Int) -> Int {
        if let value = stringValue(forKey: key), let parsed = Int(value) {
            return parsed
        }
        return defaultValue
    }

    func boolValue(forKey key: String, defaultValue: Bool) -> Bool {
        guard let value = stringValue(forKey: key)?.lowercased() else {
            return defaultValue
        }
        if ["1", "true", "yes", "y"].contains(value) {
            return true
        }
        if ["0", "false", "no", "n"].contains(value) {
            return false
        }
        return defaultValue
    }
}
