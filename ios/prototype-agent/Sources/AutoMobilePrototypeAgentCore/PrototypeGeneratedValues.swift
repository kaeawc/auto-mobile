import Foundation

protocol PrototypeIdGenerator {
    func next() -> String
}

protocol PrototypeEpochClock {
    func nowEpochMs() -> Int64
}

struct SystemPrototypeEpochClock: PrototypeEpochClock {
    func nowEpochMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

struct SystemPrototypeIdGenerator: PrototypeIdGenerator {
    func next() -> String { UUID().uuidString.lowercased() }
}

/// One mutable scope per invocation; callbacks capture a copy at dispatch.
final class PrototypeActionContext {
    let ids: PrototypeIdGenerator
    let clock: PrototypeEpochClock
    var lastGenerated: String?

    init(
        ids: PrototypeIdGenerator = SystemPrototypeIdGenerator(),
        clock: PrototypeEpochClock = SystemPrototypeEpochClock(),
        lastGenerated: String? = nil
    ) {
        self.ids = ids
        self.clock = clock
        self.lastGenerated = lastGenerated
    }

    func copy() -> PrototypeActionContext {
        PrototypeActionContext(ids: ids, clock: clock, lastGenerated: lastGenerated)
    }
}

enum PrototypeGeneratedValues {
    static func form(_ value: JSONValue?) -> String? {
        guard let fields = value?.objectFields, fields.count == 1 else { return nil }
        if fields["generate"] == .string("id") { return "generate" }
        if fields["now"] == .string("epochMs") || fields["now"] == .string("iso") { return "now" }
        return fields["lastGenerated"] == .bool(true) ? "lastGenerated" : nil
    }

    private static func children(_ value: JSONValue?) -> [JSONValue] {
        if case let .array(items)? = value { return items }
        let fields = value?.objectFields ?? [:]
        return fields.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.compactMap { fields[$0] }
    }

    static func forms(_ binding: JSONValue?) -> [String] {
        if let form = form(binding) { return [form] }
        return binding?.objectFields?["value"].map(literalForms) ?? []
    }

    private static func literalForms(_ value: JSONValue) -> [String] {
        if let form = form(value) { return [form] }
        return children(value).flatMap(literalForms)
    }

    static func resolve(_ value: JSONValue, context: PrototypeActionContext) -> JSONValue {
        switch form(value) {
        case "generate":
            let id = context.ids.next()
            context.lastGenerated = id
            return .string(id)
        case "lastGenerated": return context.lastGenerated.map(JSONValue.string) ?? .null
        case "now":
            let milliseconds = context.clock.nowEpochMs()
            if value.objectFields?["now"] != .string("iso") { return .number(Double(milliseconds)) }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            return .string(formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1000)))
        default:
            switch value {
            case let .array(items): return .array(items.map { resolve($0, context: context) })
            case let .object(fields):
                var result: [String: JSONValue] = [:]
                for key in fields.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                    if let child = fields[key] { result[key] = resolve(child, context: context) }
                }
                return .object(result)
            default: return value
            }
        }
    }

    static func resolveBinding(_ binding: JSONValue?, context: PrototypeActionContext?)
        -> Result<JSONValue, PrototypeDataWriteFailure>?
    {
        let forms = forms(binding)
        guard !forms.isEmpty, let binding else { return nil }
        guard let context else {
            return .failure(.init(
                code: forms.first == "lastGenerated" ? .lastGeneratedUnset : .invalidValue,
                message: "Generated bindings require an action-list context"
            ))
        }
        var generated = context.lastGenerated != nil
        for form in forms {
            if form == "generate" { generated = true }
            if form == "lastGenerated", !generated {
                return .failure(.init(code: .lastGeneratedUnset, message: "No preceding generate in this action list"))
            }
        }
        return .success(resolve(binding.objectFields?["value"] ?? binding, context: context))
    }

    static func bindings(_ action: [String: JSONValue]) -> [JSONValue] {
        let type = action["type"]?.stringValue ?? ""
        var result: [JSONValue] = []
        if ["setData", "appendData", "prependData", "upsertData", "setState"].contains(type),
           let value = action["value"]
        {
            result.append(value)
        }
        if type == "request" {
            result += children(action["headers"]) + children(action["query"])
            let body = action["body"]?.objectFields
            if body?["form"] != nil { result += children(body?["form"]) }
            else if case let .array(parts)? = body?["multipart"] {
                result += parts.compactMap { $0.objectFields?["value"] }
            } else if let body = action["body"] { result.append(body) }
        }
        if ["setData", "removeData", "request"].contains(type), let equals = action["where"]?.objectFields?["equals"] {
            result.append(equals)
        }
        return result
    }

    static func needsDataV2(_ action: [String: JSONValue]) -> Bool {
        guard ["setData", "appendData", "prependData", "upsertData", "removeData", "setState", "request"]
            .contains(action["type"]?.stringValue ?? "") else { return false }
        return action["where"] != nil || action["member"] != nil || bindings(action).contains { !forms($0).isEmpty }
    }

    static func validate(_ actions: [PrototypeLocatedValue]) throws {
        let lists = Dictionary(grouping: actions) { action in
            action.path.lastIndex(of: "[").map { String(action.path[..<$0]) } ?? action.path
        }
        func check(_ path: String, inherited: Bool) throws {
            var generated = inherited
            for action in lists[path] ?? [] {
                for form in bindings(action.value).flatMap(forms) {
                    if form == "generate" { generated = true }
                    if form == "lastGenerated", !generated {
                        throw PrototypeContractValidator.invalid(
                            action.path,
                            "lastGenerated_unset: no preceding generate in this action list"
                        )
                    }
                }
                for branch in ["onSuccess", "onError"] { try check("\(action.path).\(branch)", inherited: generated) }
            }
        }
        for path in lists.keys.sorted() where !path.hasSuffix(".onSuccess") && !path.hasSuffix(".onError") {
            try check(path, inherited: false)
        }
    }
}
