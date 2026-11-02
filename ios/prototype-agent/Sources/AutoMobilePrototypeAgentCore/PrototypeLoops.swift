import Foundation

/// Android attention-loop vocabulary is validated here without being advertised or rendered.
enum PrototypeLoops {
    static func charge(_ node: [String: JSONValue], path: String, count: inout Int) throws {
        if node["loop"] != nil { count += 1 }
        if count > PrototypeContractValidator.limit("MAX_PROTOTYPE_LOOPS") {
            throw PrototypeContractValidator.invalid("\(path).loop", "Loop node limit exceeded")
        }
    }

    static func validate(nodes: [PrototypeLocatedValue]) throws {
        for node in nodes {
            guard let effect = node.value["loop"]?.objectFields?["effect"]?.stringValue else { continue }
            let field = effect == "pulse" ? "scale" : "rotation"
            let conditional: [JSONValue]
            if case let .array(entries)? = node.value["styleWhen"] {
                conditional = entries.compactMap { $0.objectFields?["style"] }
            } else { conditional = [] }
            let styles = [node.value["style"]].compactMap { $0 } + conditional
            if styles.contains(where: { $0.objectFields?[field] != nil }) {
                throw PrototypeContractValidator.invalid(
                    "\(node.path).loop",
                    "\(effect) loop cannot set style.\(field)"
                )
            }
        }
    }
}
