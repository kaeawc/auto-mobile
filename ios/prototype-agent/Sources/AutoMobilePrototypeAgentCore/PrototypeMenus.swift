import Foundation

struct PrototypeMenuEntry: Decodable {
    let label: String
    let icon: String?
    let trailingText: String?
    let enabled: Bool?
    let onTap: [PrototypeAction]?
}

/// Entries have no discriminator; only dividers carry `type`.
enum PrototypeMenuItem: Decodable {
    case item(PrototypeMenuEntry)
    case divider

    init(from decoder: Decoder) throws {
        let raw = try JSONValue(from: decoder)
        try PrototypeMenus.validateItem(raw, path: "items", allowEmptyText: true)
        if case let .object(fields) = raw, fields["type"] == .string("divider") {
            self = .divider
        } else {
            self = try .item(PrototypeMenuEntry(from: decoder))
        }
    }

    var entry: PrototypeMenuEntry? {
        if case let .item(entry) = self { return entry }
        return nil
    }
}

/// Text length is checked before binding; expanded JSON still gets structural and state checks.
/// Existing node types keep their decoding behaviour.
enum PrototypeMenus {
    private static func fail(_ path: String, _ message: String) -> DecodingError {
        PrototypeThemeModes.violation(path, message)
    }

    private static func object(_ value: JSONValue?, _ path: String) throws -> [String: JSONValue] {
        guard case let .object(fields)? = value else { throw fail(path, "Expected object") }
        return fields
    }

    private static func strict(_ fields: [String: JSONValue], _ keys: Set<String>, _ path: String) throws {
        if let key = fields.keys.sorted().first(where: { !keys.contains($0) }) {
            throw fail("\(path).\(key)", "Unknown property")
        }
    }

    private static func string(_ value: JSONValue?, _ path: String, allowEmpty: Bool = false) throws -> String {
        guard let text = value?.stringValue, allowEmpty || !text.isEmpty else {
            throw fail(path, "Invalid string value")
        }
        return text
    }

    private static func key(_ value: JSONValue?, _ path: String) throws {
        let text = try string(value, path)
        guard PrototypeRepeat.isFieldName(text) else { throw fail(path, "Invalid string value") }
    }

    private static func array(_ value: JSONValue?, _ range: ClosedRange<Int>, _ path: String) throws -> [JSONValue] {
        guard case let .array(items)? = value else { throw fail(path, "Expected array") }
        guard range.contains(items.count) else { throw fail(path, "Array length out of range") }
        return items
    }

    static func validateItem(_ value: JSONValue, path: String, allowEmptyText: Bool = false) throws {
        let fields = try object(value, path)
        // The contract union tries the entry first: a divider with a label fails at `.type`.
        if fields["type"] == .string("divider"), fields.count == 1 { return }
        try strict(fields, ["label", "icon", "trailingText", "enabled", "onTap"], path)
        _ = try string(fields["label"], "\(path).label", allowEmpty: allowEmptyText)
        if let trailing = fields["trailingText"] {
            _ = try string(trailing, "\(path).trailingText", allowEmpty: allowEmptyText)
        }
        if let icon = fields["icon"] {
            let name = try string(icon, "\(path).icon")
            if PrototypeIconSymbolTable.shared.resolve(name) == .unknown {
                throw fail("\(path).icon", "Invalid string value")
            }
        }
        if let enabled = fields["enabled"], enabled.boolValue == nil {
            throw fail("\(path).enabled", "Expected boolean")
        }
        if let actions = fields["onTap"] { try validateActions(actions, path: "\(path).onTap") }
    }

    private static func validatePageAction(_ fields: [String: JSONValue], path: String) throws {
        _ = try string(fields["pager"], "\(path).pager")
        let page = fields["page"]
        let number = page?.numberValue
        guard page == .string("next") || page == .string("prev") ||
            (number.map { $0 >= 0 && $0 <= 2_147_483_647 && $0.rounded(.down) == $0 } ?? false)
        else { throw fail("\(path).page", "Invalid value") }
    }

    private static func validateActions(_ value: JSONValue, path: String) throws {
        for (index, action) in try array(value, 1 ... 32, path).enumerated() {
            let path = "\(path)[\(index)]"
            let fields = try object(action, path)
            let type = try string(fields["type"], "\(path).type")
            let keys: Set<String>
            switch type {
            case "emit":
                keys = ["type", "name", "payload"]
                _ = try string(fields["name"], "\(path).name")
            case "setState", "setData", "appendData", "prependData", "upsertData", "removeData":
                guard let rule = PrototypeContractValidator.definition("action") else {
                    throw fail(path, "Embedded structural contract is unavailable")
                }
                try PrototypeContractValidator.validateValue(action, rule: rule, path: path)
                continue
            case "toggle", "increment", "decrement":
                keys = type == "toggle" ? ["type", "key"] : ["type", "key", "by"]
                try key(fields["key"], "\(path).key")
                if let amount = fields["by"], amount.numberValue?.isFinite != true {
                    throw fail("\(path).by", "Expected number")
                }
            case "setPage":
                keys = ["type", "pager", "page"]
                try validatePageAction(fields, path: path)
            case "dismiss": keys = ["type"]
            default: throw fail("\(path).type", "Invalid string value")
            }
            try strict(fields, keys, path)
        }
    }

    private static func validateOwnAuthoredText(_ fields: [String: JSONValue], path: String) throws {
        if fields["type"] == .string("menu"), case let .array(items)? = fields["items"] {
            for (index, item) in items.enumerated() {
                guard case let .object(entry) = item, entry["type"] != .string("divider") else { continue }
                let itemPath = "\(path).items[\(index)]"
                _ = try string(entry["label"], "\(itemPath).label")
                if let trailing = entry["trailingText"] { _ = try string(trailing, "\(itemPath).trailingText") }
            }
        } else if fields["type"] == .string("select") {
            if let label = fields["label"] { _ = try string(label, "\(path).label") }
            if case let .array(options)? = fields["options"] {
                for (index, option) in options.enumerated() {
                    guard case let .object(entry) = option else { continue }
                    _ = try string(entry["label"], "\(path).options[\(index)].label")
                }
            }
        }
    }

    /// Repeat templates are visited even when they expand to no nodes. Keys and actions are
    /// checked after expansion, when their repeat placeholders have been bound.
    static func validateAuthoredText(_ raw: JSONValue, path: String = "root") throws {
        guard case let .object(fields) = raw else { return }
        try validateOwnAuthoredText(fields, path: path)
        if case let .array(children)? = fields["children"] {
            for (index, child) in children.enumerated() {
                try validateAuthoredText(child, path: "\(path).children[\(index)]")
            }
        }
        if let child = fields["child"] { try validateAuthoredText(child, path: "\(path).child") }
        for (screen, screenPath) in PrototypeStacks.screenChildren(in: fields, path: path) {
            try validateAuthoredText(screen, path: screenPath)
        }
    }

    private static func validateSelect(_ fields: [String: JSONValue], state: [String: JSONValue], path: String) throws {
        let options = try array(fields["options"], 2 ... 32, "\(path).options")
        if let label = fields["label"] { _ = try string(label, "\(path).label", allowEmpty: true) }
        var values = Set<[UInt16]>()
        for (index, option) in options.enumerated() {
            let optionPath = "\(path).options[\(index)]"
            let fields = try object(option, optionPath)
            try strict(fields, ["value", "label"], optionPath)
            let value = try string(fields["value"], "\(optionPath).value")
            _ = try string(fields["label"], "\(optionPath).label", allowEmpty: true)
            if !values.insert(Array(value.utf16)).inserted {
                throw fail("\(optionPath).value", "Duplicate select option value")
            }
        }
        if let key = fields["stateKey"]?.stringValue, state[key]?.stringValue == nil {
            throw fail("\(path).stateKey", "Select requires a string state key")
        }
    }

    static func validate(_ raw: JSONValue, state: [String: JSONValue], path: String = "root") throws {
        guard case let .object(fields) = raw else { return }
        let type = fields["type"]?.stringValue
        if type == "menu" || type == "select" {
            let common: Set<String> = [
                "type", "id", "testTag", "contentDescription", "onTap", "style", "styleWhen",
                "visibleWhen", "transition", "anchor", "safeAreaPadding",
            ]
            try strict(
                fields,
                common.union(type == "menu" ? ["items", "openWhen"] : ["options", "stateKey", "label"]),
                path
            )
            if type == "menu" {
                let items = try array(fields["items"], 1 ... 16, "\(path).items")
                for (index, item) in items.enumerated() {
                    try validateItem(item, path: "\(path).items[\(index)]", allowEmptyText: true)
                }
                let condition = try object(fields["openWhen"], "\(path).openWhen")
                try strict(condition, ["key", "equals"], "\(path).openWhen")
                try key(condition["key"], "\(path).openWhen.key")
                guard condition["equals"]?.boolValue != nil else {
                    throw fail("\(path).openWhen.equals", "Expected boolean")
                }
                if let key = condition["key"]?.stringValue, let stored = state[key], stored.boolValue == nil {
                    throw fail("\(path).openWhen.key", "Menu requires a boolean state key")
                }
            } else {
                try key(fields["stateKey"], "\(path).stateKey")
                try validateSelect(fields, state: state, path: path)
            }
        }
        if case let .array(children)? = fields["children"] {
            for (index, child) in children.enumerated() {
                try validate(child, state: state, path: "\(path).children[\(index)]")
            }
        }
        if let child = fields["child"] { try validate(child, state: state, path: "\(path).child") }
        for (screen, screenPath) in PrototypeStacks.screenChildren(in: fields, path: path) {
            try validate(screen, state: state, path: screenPath)
        }
    }

    /// Bottom-end alignment in window-local coordinates, clamped on both axes.
    static func origin(anchor: CGRect, surface: CGSize, window: CGSize, rightToLeft: Bool = false) -> CGPoint {
        PrototypePlacement.menuOrigin(anchor: anchor, surface: surface, window: window, rightToLeft: rightToLeft)
    }
}

extension PrototypeNode {
    /// Root menus fall back to the window; nested menus anchor to their immediate parent.
    func menuParent(of menu: PrototypeNode) -> PrototypeNode? {
        let nested = (children ?? []) + [child].compactMap { $0 }
        if nested.contains(where: { $0 === menu }) { return self }
        return nested.lazy.compactMap { $0.menuParent(of: menu) }.first
    }

    func visibleSelect(_ selected: PrototypeNode, state: [String: JSONValue], pages: [String: Int]) -> Bool {
        if let visibleWhen, !visibleWhen.holds(state) { return false }
        if prototypeModalTypes.contains(type), !(openWhen?.holds(state) ?? false) { return false }
        if self === selected { return type == "select" }
        var nested = children ?? []
        if type == "pager" {
            let page = id.flatMap { pages[$0] } ?? 0
            nested = nested.indices.contains(page) ? [nested[page]] : []
        }
        if let child { nested.append(child) }
        return nested.contains { $0.visibleSelect(selected, state: state, pages: pages) }
    }
}
