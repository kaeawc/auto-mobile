import Foundation

/// Root `auth` block rules (#14303) the contract cannot express, the twin of TypeScript's
/// `prototypeAuth.ts`: the block needs `auth` in `requires.platform`, account ids are unique, and an
/// `auth.*` call needs the block's accounts.
enum PrototypeAuthRules {
    static func validateBlock(_ auth: JSONValue?, requires: JSONValue?) throws {
        guard let block = auth?.objectFields else { return }
        guard PrototypeContractValidator.strings(requires?.objectFields?["platform"]).contains("auth") else {
            throw PrototypeContractValidator.invalid("auth", "The auth block requires auth in requires.platform")
        }
        guard case let .array(accounts)? = block["accounts"] else { return }
        var seen: [JSONValue?] = []
        for (index, account) in accounts.enumerated() {
            let id = account.objectFields?["id"]
            if seen.contains(id) {
                throw PrototypeContractValidator.invalid("auth.accounts[\(index)].id", "Duplicate account id")
            }
            seen.append(id)
        }
    }

    static func validateCall(_ call: String, path: String, hasAuth: Bool) throws {
        guard call.hasPrefix("auth."), !hasAuth else { return }
        throw PrototypeContractValidator.invalid("\(path).call", "\(call) requires a root auth block")
    }
}
