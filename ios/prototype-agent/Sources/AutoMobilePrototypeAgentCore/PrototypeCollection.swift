import Foundation

/// Bounded raw collection operations. Projection into scalar repeat fields happens later.
enum PrototypeCollection {
    static func clauses(_ collection: [String: JSONValue]) -> [[String: JSONValue]] {
        PrototypeStrictBindings.array(collection["where"]).compactMap(\.objectFields)
    }

    static func collect(
        _ collection: [String: JSONValue], reduce: [String: JSONValue]?,
        data: [String: JSONValue]?, state: [String: JSONValue]
    )
        -> JSONValue
    {
        let pointer = collection["of"]?.objectFields?["data"]?.stringValue ?? ""
        let source = PrototypeDataPointer.resolve(data, pointer: pointer)
        let filters = clauses(collection)
        var rows = PrototypeStrictBindings.array(source)
            .prefix(min(500, PrototypeLimits.maxDataArrayItems))
            .filter { item in
                guard let fields = item.objectFields else { return false }
                return filters.allSatisfy { matches(fields, clause: $0, state: state) }
            }
        if let sort = collection["sort"]?.objectFields {
            // Explicit tie breaking makes stability independent of the sorting implementation.
            rows = rows.enumerated().sorted { left, right in
                let order = compareRows(left.element, right.element, sort: sort)
                return order == 0 ? left.offset < right.offset : order < 0
            }.map(\.element)
        }
        if let limit = collection["limit"]?.intValue { rows = Array(rows.prefix(max(0, limit))) }
        guard let reduce else { return .array(rows) }
        let operation = reduce["op"]?.stringValue
        if operation == "count" { return .number(Double(rows.count)) }
        let field = reduce["field"]?.stringValue ?? ""
        let numbers = rows.compactMap { numeric($0.objectFields?[field]) }
        switch operation {
        case "sum": return .number(numbers.reduce(0, +))
        case "min": return .number(numbers.min() ?? 0)
        default: return .number(numbers.max() ?? 0)
        }
    }

    private static func numeric(_ value: JSONValue?) -> Double? {
        value?.numberValue.flatMap { $0.isFinite ? $0 : nil }
    }

    private static func sortable(_ value: JSONValue?) -> Bool {
        value?.stringValue != nil || numeric(value) != nil
    }

    private static func matches(
        _ row: [String: JSONValue], clause: [String: JSONValue], state: [String: JSONValue]
    )
        -> Bool
    {
        let left = row[clause["field"]?.stringValue ?? ""]
        let binding = clause["value"]?.objectFields ?? [:]
        let right = binding["state"]?.stringValue.map { state[$0] } ?? binding["value"]
        let operation = clause["op"]?.stringValue
        if operation == "contains" {
            guard let left = left?.stringValue, let right = right?.stringValue else { return false }
            // Swift's default lowercasing is Unicode based, independent of the current locale.
            // Match code units rather than canonically equivalent grapheme clusters.
            return right.isEmpty || left.lowercased().range(of: right.lowercased(), options: .literal) != nil
        }
        guard sortable(left), sortable(right),
              (left?.stringValue != nil) == (right?.stringValue != nil) else { return false }
        let order = compareValues(left, right)
        switch operation {
        case "eq": return order == 0
        case "neq": return order != 0
        case "gt": return order > 0
        case "gte": return order >= 0
        case "lt": return order < 0
        case "lte": return order <= 0
        default: return false
        }
    }

    private static func compareRows(_ left: JSONValue, _ right: JSONValue, sort: [String: JSONValue]) -> Int {
        let field = sort["field"]?.stringValue ?? ""
        let lhs = left.objectFields?[field], rhs = right.objectFields?[field]
        if !sortable(lhs) { return sortable(rhs) ? 1 : 0 }
        if !sortable(rhs) { return -1 }
        let order = compareValues(lhs, rhs)
        return sort["order"] == .string("desc") ? -order : order
    }

    private static func compareValues(_ left: JSONValue?, _ right: JSONValue?) -> Int {
        if let lhs = numeric(left) {
            guard let rhs = numeric(right) else { return -1 }
            return lhs == rhs ? 0 : (lhs < rhs ? -1 : 1)
        }
        guard let rhs = right?.stringValue else { return 1 }
        let lhs = left?.stringValue ?? ""
        let leftScalars = lhs.unicodeScalars.map(\.value), rightScalars = rhs.unicodeScalars.map(\.value)
        if leftScalars == rightScalars { return 0 }
        return leftScalars.lexicographicallyPrecedes(rightScalars) ? -1 : 1
    }
}
