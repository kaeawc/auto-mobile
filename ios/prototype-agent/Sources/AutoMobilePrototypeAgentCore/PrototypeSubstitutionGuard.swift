import Foundation

extension PrototypeLimits {
    /// Checks authored fields before either data resolution or repeat expansion allocates text.
    static func guardSubstitutedText(
        _ root: JSONValue,
        data: [String: JSONValue]?,
        derived: PrototypeDerivedContext? = nil,
        state: [String: JSONValue] = [:]
    )
        throws
    {
        var guarder = PrototypeSubstitutionGuard(data: data, derived: derived, state: state)
        try guarder.visit(root, path: "root", scope: nil)
    }
}

private struct PrototypeSubstitutionGuard {
    struct Scope {
        let alias: String
        let items: [[String: JSONValue]]
    }

    let data: [String: JSONValue]?
    let derived: PrototypeDerivedContext?
    let state: [String: JSONValue]
    private var repeats: PrototypeRepeatData
    private var total = 0

    init(data: [String: JSONValue]?, derived: PrototypeDerivedContext?, state: [String: JSONValue]) {
        self.data = data
        self.derived = derived
        self.state = state
        repeats = PrototypeRepeatData(data: data)
    }

    mutating func visit(_ node: JSONValue, path: String, scope: Scope?) throws {
        guard case let .object(fields) = node else { return }
        if scope != nil, fields["repeat"] != nil {
            throw PrototypeLimits.violation("\(path).repeat", "Nested repeat is not supported")
        }
        for name in ["header", "footer"] {
            if let child = fields[name] { try visit(child, path: "\(path).\(name)", scope: scope) }
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
        let derive = (
            try? spec["derive"]
                .map { try JSONDecoder().decode([String: PrototypeDerivedEntry].self, from: JSONEncoder().encode($0)) }
        ) ??
            [:]
        return Scope(alias: alias, items: items.map { item in
            if case let .object(fields) = item {
                guard let derived else { return fields }
                return PrototypeDerivedValues.project(
                    fields,
                    derive: derive,
                    formatter: derived.formatter,
                    environment: derived.environment
                )
            }
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
            let dataSubstitution = PrototypeDataText.substitutionLength(authored, data: data)
            let spans = PrototypeDerivedText.spans(authored)
            // Derived values are bounded at render time; only their authored tokens count here.
            let substitution = (
                recognized: dataSubstitution.recognized || !spans.isEmpty,
                length: dataSubstitution.length
            )
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

    private mutating func optionFields(_ fields: [String: JSONValue], path: String, scope: Scope?) throws {
        if case let .array(options)? = fields["options"] {
            for (index, option) in options.enumerated() {
                if case let .object(part) = option {
                    try field(part, "label", path: "\(path).options[\(index)]", text: true, scope: scope)
                }
            }
        }
    }

    private mutating func swipeFields(_ fields: [String: JSONValue], path: String, scope: Scope?) throws {
        if case let .object(swipe)? = fields["swipeActions"] {
            for side in ["start", "end"] {
                guard case let .array(entries)? = swipe[side] else { continue }
                for (index, entry) in entries.enumerated() {
                    try part(entry, path: "\(path).swipeActions.\(side)[\(index)]", scope: scope)
                }
            }
        }
    }

    private mutating func appBarFields(_ fields: [String: JSONValue], path: String, scope: Scope?) throws {
        try field(fields, "title", path: path, text: true, scope: scope)
        try part(fields["navigationIcon"], path: "\(path).navigationIcon", scope: scope)
        if case let .array(parts)? = fields["actions"] {
            for (index, value) in parts.enumerated() {
                try part(value, path: "\(path).actions[\(index)]", scope: scope)
            }
        }
    }

    private mutating func componentFields(_ fields: [String: JSONValue], path: String, scope: Scope?) throws {
        switch fields["type"]?.stringValue {
        case "text": try field(fields, "text", path: path, text: true, scope: scope)
        case "button", "fab": try field(fields, "label", path: path, text: true, scope: scope)
        case "segmentedButton":
            try optionFields(fields, path: path, scope: scope)
        case "textField":
            try part(fields["trailingIcon"], path: "\(path).trailingIcon", scope: scope)
            try actions(fields, path: path, scope: scope, list: "onSubmit")
        case "row", "listItem":
            try swipeFields(fields, path: path, scope: scope)
        case "topAppBar":
            try appBarFields(fields, path: path, scope: scope)
        case "dialog":
            try field(fields, "title", path: path, text: true, scope: scope)
            try field(fields, "text", path: path, text: true, scope: scope)
            try part(fields["confirm"], path: "\(path).confirm", scope: scope)
            try part(fields["dismiss"], path: "\(path).dismiss", scope: scope)
        case "tooltip":
            try field(fields, "text", path: path, text: true, scope: scope)
            try actions(fields, path: path, scope: scope, list: "onDismiss")
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

    /// Every action list a node runs: a tap, a long press or a double tap binds the same way. A
    /// caller may name one list instead (`refresh.onRefresh`).
    private mutating func actions(
        _ fields: [String: JSONValue], path: String, scope: Scope?, list: String? = nil
    )
        throws
    {
        for name in list.map({ [$0] }) ?? ["onTap", "onLongPress", "onDoubleTap", "onEndReached"] {
            guard case let .array(entries)? = fields[name] else { continue }
            for (index, entry) in entries.enumerated() {
                guard case let .object(action) = entry else { continue }
                try actionFields(action, path: "\(path).\(name)[\(index)]", scope: scope)
            }
        }
    }

    private mutating func actionFields(_ action: [String: JSONValue], path: String, scope: Scope?) throws {
        switch action["type"]?.stringValue {
        case "setState":
            try field(action, "key", path: path, scope: scope)
            try field(action, "value", path: path, scope: scope)
        case "emit": try field(action, "name", path: path, scope: scope)
        case "setData", "appendData", "removeData": try field(action, "path", path: path, scope: scope)
        case "startTimer":
            try actions(action, path: path, scope: scope, list: "actions")
        case "request":
            try field(action, "url", path: path, text: true, scope: scope)
            try field(action, "statusKey", path: path, scope: scope)
            for list in ["onSuccess", "onError"] {
                guard case let .array(entries)? = action[list] else { continue }
                for (index, entry) in entries.enumerated() {
                    guard case let .object(nested) = entry else { continue }
                    try actionFields(nested, path: "\(path).\(list)[\(index)]", scope: scope)
                }
            }
        case "toggle", "increment", "decrement":
            try field(action, "key", path: path, scope: scope)
        default: break
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
