import Foundation

extension PrototypeLimits {
    /// Checks authored fields before either data resolution or repeat expansion allocates text.
    static func guardSubstitutedText(_ root: JSONValue, data: [String: JSONValue]?) throws {
        var guarder = PrototypeSubstitutionGuard(data: data)
        try guarder.visit(root, path: "root", scope: nil)
    }
}

private struct PrototypeSubstitutionGuard {
    struct Scope {
        let alias: String
        let items: [[String: JSONValue]]
    }

    let data: [String: JSONValue]?
    private var repeats: PrototypeRepeatData
    private var total = 0

    init(data: [String: JSONValue]?) {
        self.data = data
        repeats = PrototypeRepeatData(data: data)
    }

    mutating func visit(_ node: JSONValue, path: String, scope: Scope?) throws {
        guard case let .object(fields) = node else { return }
        if scope != nil, fields["repeat"] != nil {
            throw PrototypeLimits.violation("\(path).repeat", "Nested repeat is not supported")
        }
        try ownFields(fields, path: path, scope: scope)
        let childScope = ownScope(fields) ?? scope
        if case let .array(children)? = fields["children"] {
            for (index, child) in children.enumerated() {
                try visit(child, path: "\(path).children[\(index)]", scope: childScope)
            }
        }
        if case .object? = fields["child"], let child = fields["child"] {
            try visit(child, path: "\(path).child", scope: childScope)
        }
        if case let .object(screens)? = fields["screens"] {
            for name in screens.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                if let screen = screens[name] {
                    try visit(screen, path: PrototypeStacks.screenPath(path, name: name), scope: childScope)
                }
            }
        }
    }

    private mutating func ownScope(_ fields: [String: JSONValue]) -> Scope? {
        guard case let .object(spec)? = fields["repeat"], let alias = spec["as"]?.stringValue else {
            return nil
        }
        let source: JSONValue?
        if case let .object(pointer)? = spec["items"], let path = pointer["path"]?.stringValue {
            source = repeats.items(path)
        } else {
            source = spec["items"]
        }
        guard case let .array(items)? = source else { return Scope(alias: alias, items: []) }
        return Scope(alias: alias, items: items.map { item in
            if case let .object(fields) = item { return fields }
            return [:]
        })
    }

    private mutating func field(
        _ fields: [String: JSONValue], _ key: String, path: String, text: Bool = false, scope: Scope?
    )
        throws
    {
        guard let authored = fields[key]?.stringValue else { return }
        let fieldPath = "\(path).\(key)"
        var bound = authored
        var dataRecognized = false
        if text {
            let substitution = PrototypeDataText.substitutionLength(authored, data: data)
            if substitution.length > PrototypeLimits.maxSubstitutedTextLength {
                throw PrototypeLimits.violation(fieldPath, "Substituted text length limit exceeded")
            }
            if substitution.recognized {
                dataRecognized = true
                try charge(authored.utf16.count + substitution.length, path: fieldPath)
                // Outside a repeat no intermediate text needs to be built by this guard.
                if scope != nil { bound = PrototypeDataText.bind(authored, data: data) }
            }
        }
        if let scope {
            try repeatText(bound, path: fieldPath, scope: scope, dataRecognized: dataRecognized)
        }
    }

    private mutating func charge(_ length: Int, path: String) throws {
        total += length
        if total > PrototypeLimits.maxSubstitutedTextTotal {
            throw PrototypeLimits.violation(path, "Substituted text total limit exceeded")
        }
    }

    private mutating func repeatText(
        _ text: String, path: String, scope: Scope, dataRecognized: Bool
    )
        throws
    {
        let segments = PrototypeRepeat.segments(text, alias: scope.alias)
        let counts = segments.reduce(into: (indices: 0, fields: [String: Int]())) { counts, segment in
            switch segment {
            case .index: counts.indices += 1
            case let .field(name): counts.fields[name, default: 0] += 1
            case .literal: break
            }
        }
        guard dataRecognized || counts.indices != 0 || !counts.fields.isEmpty else { return }
        let textLength = text.utf16.count
        for (index, item) in scope.items.enumerated() {
            var length = counts.indices * String(index).utf16.count
            if length > PrototypeLimits.maxSubstitutedTextLength {
                throw PrototypeLimits.violation(path, "Substituted text length limit exceeded")
            }
            for (name, count) in counts.fields {
                length += count * (item[name]?.displayString.utf16.count ?? 0)
                if length > PrototypeLimits.maxSubstitutedTextLength {
                    throw PrototypeLimits.violation(path, "Substituted text length limit exceeded")
                }
            }
            try charge(textLength + length, path: path)
        }
    }

    private mutating func ownFields(_ fields: [String: JSONValue], path: String, scope: Scope?) throws {
        try componentFields(fields, path: path, scope: scope)
        if let condition = fields["visibleWhen"] {
            try conditionFields(condition, path: "\(path).visibleWhen", scope: scope)
        }
        if case let .array(styles)? = fields["styleWhen"] {
            for (index, style) in styles.enumerated() {
                if case let .object(entry) = style, let condition = entry["when"] {
                    try conditionFields(condition, path: "\(path).styleWhen[\(index)].when", scope: scope)
                }
            }
        }
        try actions(fields, path: path, scope: scope)
        for key in ["stateKey", "hourKey", "minuteKey"] {
            try field(fields, key, path: path, scope: scope)
        }
        if case let .object(part)? = fields["trailing"] {
            try field(part, "stateKey", path: "\(path).trailing", scope: scope)
        }
        if case let .object(part)? = fields["openWhen"] {
            try field(part, "key", path: "\(path).openWhen", scope: scope)
        }
        if case let .object(refresh)? = fields["refresh"] {
            try field(refresh, "stateKey", path: "\(path).refresh", scope: scope)
            try actions(refresh, path: "\(path).refresh", scope: scope, list: "onRefresh")
        }
    }

    private mutating func componentFields(_ fields: [String: JSONValue], path: String, scope: Scope?) throws {
        switch fields["type"]?.stringValue {
        case "text": try field(fields, "text", path: path, text: true, scope: scope)
        case "button", "fab": try field(fields, "label", path: path, text: true, scope: scope)
        case "segmentedButton":
            if case let .array(options)? = fields["options"] {
                for (index, option) in options.enumerated() {
                    if case let .object(part) = option {
                        try field(part, "label", path: "\(path).options[\(index)]", text: true, scope: scope)
                    }
                }
            }
        case "topAppBar":
            try field(fields, "title", path: path, text: true, scope: scope)
            try part(fields["navigationIcon"], path: "\(path).navigationIcon", scope: scope)
            if case let .array(parts)? = fields["actions"] {
                for (index, value) in parts.enumerated() {
                    try part(value, path: "\(path).actions[\(index)]", scope: scope)
                }
            }
        case "dialog":
            try field(fields, "title", path: path, text: true, scope: scope)
            try field(fields, "text", path: path, text: true, scope: scope)
            try part(fields["confirm"], path: "\(path).confirm", scope: scope)
            try part(fields["dismiss"], path: "\(path).dismiss", scope: scope)
        case "snackbar":
            try field(fields, "text", path: path, text: true, scope: scope)
            try part(fields["action"], path: "\(path).action", scope: scope)
        default: break
        }
    }

    private mutating func part(_ value: JSONValue?, path: String, scope: Scope?) throws {
        guard case let .object(fields)? = value else { return }
        try field(fields, "label", path: path, text: true, scope: scope)
        try actions(fields, path: path, scope: scope)
    }

    private mutating func actions(
        _ fields: [String: JSONValue], path: String, scope: Scope?, list: String = "onTap"
    ) throws {
        guard case let .array(entries)? = fields[list] else { return }
        for (index, entry) in entries.enumerated() {
            guard case let .object(action) = entry else { continue }
            let actionPath = "\(path).\(list)[\(index)]"
            switch action["type"]?.stringValue {
            case "setState":
                try field(action, "key", path: actionPath, scope: scope)
                try field(action, "value", path: actionPath, scope: scope)
            case "emit": try field(action, "name", path: actionPath, scope: scope)
            case "toggle", "increment", "decrement":
                try field(action, "key", path: actionPath, scope: scope)
            default: break
            }
        }
    }

    private mutating func conditionFields(_ value: JSONValue, path: String, scope: Scope?) throws {
        guard case let .object(fields) = value else { return }
        try field(fields, "key", path: path, scope: scope)
        if fields["data"] == nil {
            for key in ["equals", "notEquals"] { try field(fields, key, path: path, scope: scope) }
        }
        if let negated = fields["not"] {
            try conditionFields(negated, path: "\(path).not", scope: scope)
        }
        for group in ["all", "any"] {
            if case let .array(entries)? = fields[group] {
                for (index, entry) in entries.enumerated() {
                    try conditionFields(entry, path: "\(path).\(group)[\(index)]", scope: scope)
                }
            }
        }
    }
}
