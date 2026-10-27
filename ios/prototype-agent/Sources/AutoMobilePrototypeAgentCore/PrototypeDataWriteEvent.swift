import Foundation

/// A single replayable data change, including the window applied atomically by the writer.
struct PrototypeDataWriteEvent: Equatable {
    let op: PrototypeDataWrite.Operation
    let path: String
    let value: JSONValue?
    let maxItems: Int?
    let revision: Int

    var payload: JSONValue {
        var fields: [String: JSONValue] = ["op": .string(op.rawValue), "revision": .number(Double(revision))]
        if let value { fields["value"] = value }
        if let maxItems { fields["maxItems"] = .number(Double(maxItems)) }
        return .object(fields)
    }

    static func decode(kind: String, name: String?, payload: JSONValue?) -> Self? {
        guard kind == "change", let path = name, PrototypeDataWrite.pointer(ofPath: path) != nil,
              let fields = payload?.objectFields, let raw = fields["op"]?.stringValue,
              let op = PrototypeDataWrite.Operation(rawValue: raw),
              let revision = safeInteger(fields["revision"], minimum: 0)
        else { return nil }
        let windowed = op == .append || op == .extend || op == .prepend
        let allowed: Set<String> = Set(["op", "revision"])
            .union(op == .remove ? [] : ["value"])
            .union(windowed ? ["maxItems"] : [])
        guard Set(fields.keys).isSubset(of: allowed) else { return nil }
        let maxItems: Int?
        if fields["maxItems"] != nil {
            guard let count = safeInteger(fields["maxItems"], minimum: 1) else { return nil }
            maxItems = count
        } else { maxItems = nil }
        if op == .extend || op == .prepend, let value = fields["value"] {
            guard case .array = value else { return nil }
        }
        return Self(op: op, path: path, value: fields["value"], maxItems: maxItems, revision: revision)
    }

    private static func safeInteger(_ value: JSONValue?, minimum: Int) -> Int? {
        guard let number = value?.numberValue, number >= Double(minimum), number <= 9_007_199_254_740_991,
              let integer = Int(exactly: number) else { return nil }
        return integer
    }
}
