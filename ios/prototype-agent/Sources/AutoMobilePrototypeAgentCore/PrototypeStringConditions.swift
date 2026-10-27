import Foundation

/// String comparisons are recognized only in condition slots, never in opaque data or styles.
enum PrototypeStringConditions {
    static func uses(_ node: [String: JSONValue]) -> Bool {
        if node["type"] == .string("textField"), node["errorWhen"] != nil || node["errorText"] != nil { return true }
        if ["visibleWhen", "enabledWhen"].contains(where: { condition(node[$0]) }) { return true }
        guard case let .array(entries)? = node["styleWhen"] else { return false }
        return entries.contains { condition($0.objectFields?["when"]) }
    }

    private static func condition(_ value: JSONValue?) -> Bool {
        guard let fields = value?.objectFields else { return false }
        if ["contains", "startsWith", "lengthGt", "lengthLt"].contains(where: { fields[$0] != nil }) { return true }
        if condition(fields["not"]) { return true }
        return ["all", "any"].contains { group in
            guard case let .array(children)? = fields[group] else { return false }
            return children.contains { condition($0) }
        }
    }
}
