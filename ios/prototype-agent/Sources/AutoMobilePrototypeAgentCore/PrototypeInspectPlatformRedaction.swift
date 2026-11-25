import Foundation

/// The `/platform` state a status reply carries (#16463), the Swift twin of TypeScript's
/// `redactPrototypeInspectPlatform` (`prototypeLocationPrivacy.ts`). Only keys in a module's
/// contract `state` table are kept (the placeholder `test` module has no table and keeps every
/// key). `location.current` becomes its accuracy summary with `redacted: true` (null stays null)
/// unless `includeLocation`, and any other `sensitive` key is omitted. Both replay
/// `test/fixtures/prototype-location/inspect-redaction.json`.
enum PrototypeInspectPlatformRedaction {
    static func redact(_ platform: [String: JSONValue], includeLocation: Bool) -> [String: JSONValue] {
        var redacted: [String: JSONValue] = [:]
        for (name, values) in platform {
            guard let definition = PrototypeContractValidator.platformModules[name]?.objectFields,
                  let values = values.objectFields
            else { continue }
            let table = definition["state"]?.objectFields
            var kept: [String: JSONValue] = [:]
            for (key, value) in values {
                if let table {
                    guard let entry = table[key] else { continue }
                    if name == "location", key == "current" {
                        kept[key] = includeLocation ? value : redactedFix(value)
                    } else if entry.objectFields?["sensitive"] != .bool(true) {
                        kept[key] = value
                    }
                } else {
                    kept[key] = value
                }
            }
            redacted[name] = .object(kept)
        }
        return redacted
    }

    /// The fix as presence and accuracy: a finite `accuracyM` and a boolean `approximate` when it
    /// has them, always `redacted: true`; no fix stays null.
    private static func redactedFix(_ fix: JSONValue) -> JSONValue {
        if fix == .null { return .null }
        var summary: [String: JSONValue] = ["redacted": .bool(true)]
        if let accuracyM = fix.objectFields?["accuracyM"]?.numberValue, accuracyM.isFinite {
            summary["accuracyM"] = .number(accuracyM)
        }
        if let approximate = fix.objectFields?["approximate"]?.boolValue {
            summary["approximate"] = .bool(approximate)
        }
        return .object(summary)
    }
}
