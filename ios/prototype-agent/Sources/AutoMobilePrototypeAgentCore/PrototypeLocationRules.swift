import Foundation

/// Root `location` subscription block rules (#14324) the contract cannot express, the twin of
/// TypeScript's `prototypeLocationBlock.ts`: the block needs `location` in `requires.platform` and the
/// `location` permission in `requires.permissions`.
enum PrototypeLocationRules {
    static func validateBlock(_ location: JSONValue?, requires: JSONValue?) throws {
        guard location?.objectFields != nil else { return }
        let fields = requires?.objectFields
        guard PrototypeContractValidator.strings(fields?["platform"]).contains("location") else {
            throw PrototypeContractValidator.invalid(
                "location", "The location block requires location in requires.platform"
            )
        }
        guard case let .array(permissions)? = fields?["permissions"],
              permissions.contains(where: { $0.objectFields?["name"] == .string("location") })
        else {
            throw PrototypeContractValidator.invalid(
                "location", "The location block requires permission location in requires.permissions"
            )
        }
    }
}
