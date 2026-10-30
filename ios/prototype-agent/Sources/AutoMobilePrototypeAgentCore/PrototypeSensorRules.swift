import Foundation

/// Root `sensors` block rules (#14327) the contract cannot express, the twin of TypeScript's
/// `prototypeSensorsBlock.ts`: the block needs `sensors` in `requires.platform`, `steps` needs the `motion`
/// permission, and a `/platform/sensors` read or `sensors.*` handler names a sensor the block lists, because
/// the device listens only to declared sensors.
enum PrototypeSensorRules {
    private static let sensorOf: [String: String] = [
        "pitchDeg": "orientation", "rollDeg": "orientation", "headingDeg": "orientation", "steps": "steps",
        "proximityNear": "proximity", "lightLux": "light", "shake": "shake",
    ]

    static func validateBlock(_ sensors: JSONValue?, requires: JSONValue?) throws {
        guard let block = sensors?.objectFields else { return }
        let fields = requires?.objectFields
        guard PrototypeContractValidator.strings(fields?["platform"]).contains("sensors") else {
            throw PrototypeContractValidator.invalid(
                "sensors", "The sensors block requires sensors in requires.platform"
            )
        }
        let permissions: [JSONValue] = if case let .array(items)? = fields?["permissions"] { items } else { [] }
        if block["steps"] != nil, !permissions.contains(where: { $0.objectFields?["name"] == .string("motion") }) {
            throw PrototypeContractValidator.invalid(
                "sensors.steps", "steps requires permission motion in requires.permissions"
            )
        }
    }

    /// Throws when a `/platform/sensors/<key>` read (`tokens` of its pointer) names an undeclared sensor.
    static func validateRead(_ tokens: [String], path: String, sensors: JSONValue?) throws {
        guard tokens.count == 2, tokens[0] == "sensors" else { return }
        try validateUse(tokens[1], path: path, sensors: sensors)
    }

    /// Throws when a `sensors.<event>` handler names an undeclared sensor.
    static func validateEvent(_ event: String, path: String, sensors: JSONValue?) throws {
        guard event.hasPrefix("sensors.") else { return }
        try validateUse(String(event.dropFirst("sensors.".count)), path: path, sensors: sensors)
    }

    private static func validateUse(_ member: String, path: String, sensors: JSONValue?) throws {
        guard let sensor = sensorOf[member], sensors?.objectFields?[sensor] == nil else { return }
        throw PrototypeContractValidator.invalid(path, "Sensor \(sensor) is not declared in the sensors block")
    }
}
