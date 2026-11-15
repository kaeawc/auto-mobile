import Foundation

/// The delivered `location.updated` data for one fix (#16463), the Swift twin of TypeScript's
/// `prototypeLocationEventSummary` (`prototypeLocationPrivacy.ts`): only `accuracyM` and `approximate`,
/// so coordinates never leave the device in the event. Both replay
/// `test/fixtures/prototype-location/event-summary.json`.
enum PrototypeLocationEventSummary {
    /// The summary of `fix`, or nil when it lacks a finite `accuracyM` or a boolean `approximate`.
    static func of(_ fix: [String: JSONValue]) -> JSONValue? {
        guard let accuracyM = fix["accuracyM"]?.numberValue, accuracyM.isFinite,
              let approximate = fix["approximate"]?.boolValue
        else { return nil }
        return .object(["accuracyM": .number(accuracyM), "approximate": .bool(approximate)])
    }
}
