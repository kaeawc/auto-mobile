import Foundation

/// Root `commerce` catalog rules (#14314) the contract cannot express, the twin of TypeScript's
/// `prototypeCommerce.ts`: the block needs `commerce` in `requires.platform`, product ids are unique, only a
/// subscription has a `period` or `trialPeriod`, a `commerce.*` call needs the catalog, and a literal
/// `commerce.purchase` product id names a catalog product.
enum PrototypeCommerceRules {
    static func validateBlock(_ commerce: JSONValue?, requires: JSONValue?) throws {
        guard let block = commerce?.objectFields else { return }
        guard PrototypeContractValidator.strings(requires?.objectFields?["platform"]).contains("commerce") else {
            throw PrototypeContractValidator.invalid(
                "commerce", "The commerce block requires commerce in requires.platform"
            )
        }
        guard case let .array(products)? = block["products"] else { return }
        var seen: [JSONValue?] = []
        for (index, entry) in products.enumerated() {
            let product = entry.objectFields ?? [:]
            let at = "commerce.products[\(index)]"
            if seen.contains(product["id"]) {
                throw PrototypeContractValidator.invalid("\(at).id", "Duplicate product id")
            }
            seen.append(product["id"])
            if let period = ["period", "trialPeriod"].first(where: { product[$0] != nil }),
               product["kind"] != .string("subscription")
            {
                throw PrototypeContractValidator.invalid("\(at).\(period)", "Only a subscription has a period")
            }
        }
    }

    /// The catalog's product ids, or nil when the spec has no `commerce` block.
    static func products(_ commerce: JSONValue?) -> Set<String>? {
        guard let block = commerce?.objectFields else { return nil }
        guard case let .array(products)? = block["products"] else { return [] }
        return Set(products.compactMap { $0.objectFields?["id"]?.stringValue })
    }

    static func validateCall(_ call: String, args: [String: JSONValue], path: String, products: Set<String>?) throws {
        guard call.hasPrefix("commerce.") else { return }
        guard let products else {
            throw PrototypeContractValidator.invalid("\(path).call", "\(call) requires a root commerce block")
        }
        if case let .string(productId)? = args["productId"]?.objectFields?["value"], !products.contains(productId) {
            throw PrototypeContractValidator.invalid("\(path).args.productId.value", "Unknown product")
        }
    }
}
