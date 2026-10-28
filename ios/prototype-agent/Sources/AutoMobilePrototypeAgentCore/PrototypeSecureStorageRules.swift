import Foundation

/// Secure storage rules (#14321) the contract cannot express, the twin of TypeScript's
/// `prototypeSecureStorage.ts`: `storage.secure` needs the `secureStorage` module, each key is a declared
/// string state key not also in `storage.keys`, a `secureAuth` entry names a secure key and needs the
/// `biometric` module, and no secure key may leave the device through an emit context.
enum PrototypeSecureStorageRules {
    static func validateBlock(_ storage: JSONValue?, requires: JSONValue?, state: [String: JSONValue]) throws {
        guard let block = storage?.objectFields, case let .array(secure)? = block["secure"] else { return }
        let platform = PrototypeContractValidator.strings(requires?.objectFields?["platform"])
        guard platform.contains("secureStorage") else {
            throw PrototypeContractValidator.invalid(
                "storage.secure", "storage.secure requires secureStorage in requires.platform"
            )
        }
        let keys = PrototypeContractValidator.strings(block["keys"])
        for (index, entry) in secure.enumerated() {
            if let message = keyError(entry.stringValue, state: state, keys: keys) {
                throw PrototypeContractValidator.invalid("storage.secure[\(index)]", message)
            }
        }
        let names = secure.compactMap(\.stringValue)
        for name in (block["secureAuth"]?.objectFields ?? [:]).keys.sorted() {
            let path = PrototypeLimits.dataMemberPath("storage.secureAuth", key: name)
            guard names.contains(name) else {
                throw PrototypeContractValidator.invalid(path, "secureAuth names a key that is not in storage.secure")
            }
            guard platform.contains("biometric") else {
                throw PrototypeContractValidator.invalid(
                    path, "Biometric secure keys require biometric in requires.platform"
                )
            }
        }
    }

    /// The secure `state:` keys a spec lists, for the emit-context check.
    static func secureKeys(_ storage: JSONValue?) -> Set<String> {
        Set(PrototypeContractValidator.strings(storage?.objectFields?["secure"]))
    }

    static func validateEmit(_ fields: [String: JSONValue], path: String, secure: Set<String>) throws {
        guard fields["type"] == .string("emit"), !secure.isEmpty,
              let context = fields["context"]?.objectFields else { return }
        for name in context.keys.sorted() {
            guard case let .string(key)? = context[name]?.objectFields?["state"],
                  secure.contains("state:\(key)") else { continue }
            throw PrototypeContractValidator.invalid(
                PrototypeLimits.dataMemberPath("\(path).context", key: name),
                "Secure storage key state:\(key) cannot be sent in an emit context"
            )
        }
    }

    private static func keyError(_ entry: String?, state: [String: JSONValue], keys: [String]) -> String? {
        guard let entry, entry.hasPrefix("state:") else { return "Secure storage keys are state:<key>" }
        let key = String(entry.dropFirst("state:".count))
        guard PrototypeContractValidator.matches("stateKey", key) else {
            return "Secure storage keys are state:<key>"
        }
        guard let value = state[key] else { return "Secure storage key \(entry) is not declared in state" }
        guard case .string = value else { return "Secure storage keys must hold a string state value" }
        return keys.contains(entry) ? "Secure storage key \(entry) is also listed in storage.keys" : nil
    }
}
