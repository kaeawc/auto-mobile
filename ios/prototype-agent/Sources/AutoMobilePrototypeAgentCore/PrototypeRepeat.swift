import Foundation

/// The `repeat` list template, mirroring Android's `prototypeChildEntries` and `PrototypeRepeatTemplate`.
///
/// A `box`/`row`/`column` with `repeat: {items, as}` renders its children once per item, in item
/// order. Expansion runs on the raw node tree before it is decoded, so the renderer and session
/// only ever see concrete nodes. The host validator has already checked the template (fields exist
/// in every item, no nested `repeat`, expanded limits), so this only binds values.
///
/// Bound per instance, as on Android: a `text` node's `text`, the component label, title and
/// button fields listed on `bindTextFields`; `setState` values and `emit` names in
/// `onTap`, `onLongPress` and `onDoubleTap`; the `equals`/`notEquals` operands of `visibleWhen`
/// and `styleWhen` conditions,
/// recursively through `all`/`any`/`not`; and every state key (#11051): `stateKey`,
/// `hourKey`/`minuteKey`, a list item's trailing key, `openWhen.key`, condition keys and the keys
/// of `setState`, `toggle`, `increment` and `decrement`. A string that is exactly one placeholder keeps the
/// item's own type, so `equals: "{item.id}"` can match a numeric state value.
enum PrototypeRepeat {
    /// One piece of a string with `{as.field}` / `{index}` placeholders resolved.
    enum Segment: Equatable {
        case literal(String)
        case index
        case field(String)
    }

    /// Splits `text` into placeholder segments by a plain scan over Unicode scalars; any other
    /// brace text, including a `{state_key}` placeholder, stays literal for the ordinary state
    /// interpolation. Scalars, not `Character`s: a combining mark after `}` would otherwise fuse
    /// with it into one grapheme cluster that is not `}`, unlike the host's UTF-16 scan
    /// (`templateSegments` in src/features/prototype/prototypeTemplate.ts) and Kotlin's.
    static func segments(_ text: String, alias: String) -> [Segment] {
        let scalars = text.unicodeScalars
        var segments: [Segment] = []
        var literal = String.UnicodeScalarView()
        var cursor = scalars.startIndex
        func flush() {
            if !literal.isEmpty { segments.append(.literal(String(literal))) }
            literal = String.UnicodeScalarView()
        }
        while cursor < scalars.endIndex {
            let token = scalars[cursor] == "{" ? placeholder(in: scalars, openingAt: cursor, alias: alias) : nil
            if let (segment, end) = token {
                flush()
                segments.append(segment)
                cursor = end
            } else {
                literal.append(scalars[cursor])
                cursor = scalars.index(after: cursor)
            }
        }
        flush()
        return segments
    }

    /// Expands every `repeat` in the node tree rooted at `node`.
    static func expand(_ node: JSONValue) -> JSONValue {
        guard case var .object(fields) = node else { return node }
        if case let .array(children)? = fields["children"] {
            let expanded: [JSONValue] = if case let .object(spec)? = fields["repeat"] {
                instances(of: spec).flatMap { instance in children.map { instance.bind($0) } }
            } else {
                children
            }
            fields["children"] = .array(expanded.map(expand))
        }
        fields["repeat"] = nil
        if let child = fields["child"] { fields["child"] = expand(child) }
        return .object(fields)
    }

    /// `key` is accepted but rows keep positional identity until keyed patching (#11675).
    private static func instances(of spec: [String: JSONValue]) -> [Instance] {
        guard case let .string(alias)? = spec["as"], case let .array(items)? = spec["items"] else { return [] }
        return items.enumerated().map { index, item in
            guard case let .object(fields) = item else { return Instance(alias: alias, item: [:], index: index) }
            return Instance(alias: alias, item: fields, index: index)
        }
    }

    /// The contract's text-kind fields, shared by data resolution and repeat binding.
    /// This maps only this node's authored text, never actions, operands or descendants.
    static func bindTextFields(_ fields: inout [String: JSONValue], transform: (String) -> String) {
        func string(_ key: String, in object: inout [String: JSONValue]) {
            if case let .string(text)? = object[key] { object[key] = .string(transform(text)) }
        }
        func part(_ key: String, in object: inout [String: JSONValue]) {
            guard case var .object(member)? = object[key] else { return }
            string("label", in: &member)
            object[key] = .object(member)
        }
        func list(_ key: String, in object: inout [String: JSONValue]) {
            guard case let .array(entries)? = object[key] else { return }
            object[key] = .array(entries.map { entry in
                guard case var .object(member) = entry else { return entry }
                string("label", in: &member)
                return .object(member)
            })
        }
        switch fields["type"] {
        case .string("text")?:
            string("text", in: &fields)
            if case let .array(spans)? = fields["spans"] {
                fields["spans"] = .array(spans.map { span in
                    guard case var .object(member) = span else { return span }
                    string("text", in: &member)
                    return .object(member)
                })
            }
        case .string("button")?, .string("fab")?: string("label", in: &fields)
        case .string("segmentedButton")?: list("options", in: &fields)
        case .string("topAppBar")?:
            string("title", in: &fields)
            part("navigationIcon", in: &fields)
            list("actions", in: &fields)
        case .string("searchBar")?:
            string("placeholder", in: &fields)
            list("trailingActions", in: &fields)
        case .string("dialog")?:
            string("title", in: &fields)
            string("text", in: &fields)
            part("confirm", in: &fields)
            part("dismiss", in: &fields)
        case .string("snackbar")?:
            string("text", in: &fields)
            part("action", in: &fields)
        default: break
        }
    }

    /// A placeholder segment and the scalar index just past its closing brace.
    private typealias Scalars = String.UnicodeScalarView
    private typealias Token = (segment: Segment, end: Scalars.Index)

    private static func placeholder(in scalars: Scalars, openingAt open: Scalars.Index, alias: String) -> Token? {
        let start = scalars.index(after: open)
        guard let close = scalars[start...].firstIndex(of: "}") else { return nil }
        let inner = Array(scalars[start ..< close])
        let end = scalars.index(after: close)
        if inner == Array("index".unicodeScalars) { return (.index, end) }
        let prefix = Array("\(alias).".unicodeScalars)
        guard inner.starts(with: prefix) else { return nil }
        var name = String.UnicodeScalarView()
        name.append(contentsOf: inner.dropFirst(prefix.count))
        let field = String(name)
        return isFieldName(field) ? (.field(field), end) : nil
    }

    static func isFieldName(_ name: String) -> Bool {
        guard (1 ... 64).contains(name.unicodeScalars.count),
              let first = name.unicodeScalars.first else { return false }
        func letter(_ scalar: Unicode.Scalar) -> Bool {
            ("A" ... "Z").contains(scalar) || ("a" ... "z").contains(scalar) || scalar == "_"
        }
        return letter(first) && name.unicodeScalars.allSatisfy { letter($0) || ("0" ... "9").contains($0) }
    }
}

private struct Instance {
    let alias: String
    let item: [String: JSONValue]
    let index: Int

    /// One template node bound to this instance; descendants are bound too.
    func bind(_ node: JSONValue) -> JSONValue {
        guard case var .object(fields) = node else { return node }
        PrototypeRepeat.bindTextFields(&fields, transform: interpolate)
        bindComponentActions(&fields)
        if fields["type"] == .string("text") {
            bindList("spans", in: &fields) { bindPartFields(&$0) }
        }
        bindStateKeys(&fields)
        bindPartFields(&fields)
        if let condition = fields["visibleWhen"] {
            fields["visibleWhen"] = bindCondition(condition)
        }
        if case let .array(entries)? = fields["styleWhen"] {
            fields["styleWhen"] = .array(entries.map { entry in
                guard case var .object(entryFields) = entry, let condition = entryFields["when"] else { return entry }
                entryFields["when"] = bindCondition(condition)
                return .object(entryFields)
            })
        }
        if case let .array(children)? = fields["children"] {
            fields["children"] = .array(children.map(bind))
        }
        if let child = fields["child"] { fields["child"] = bind(child) }
        return .object(fields)
    }

    /// Part actions bind independently of the shared text-kind field mapping.
    private func bindComponentActions(_ fields: inout [String: JSONValue]) {
        guard case let .string(type)? = fields["type"] else { return }
        switch type {
        case "topAppBar":
            bindPart("navigationIcon", in: &fields)
            bindList("actions", in: &fields) { bindPartFields(&$0) }
        case "searchBar":
            bindList("trailingActions", in: &fields) { bindPartFields(&$0) }
            if case let .array(actions)? = fields["onSubmit"] {
                fields["onSubmit"] = .array(actions.map(bindAction))
            }
        case "dialog":
            bindPart("confirm", in: &fields)
            bindPart("dismiss", in: &fields)
        case "snackbar":
            bindPart("action", in: &fields)
        default:
            break
        }
    }

    /// State-key fields bind to text (#11051): the node's own keys, a list item's trailing control
    /// and a sheet, dialog or snackbar `openWhen`. Condition and action keys bind with their owners.
    private func bindStateKeys(_ fields: inout [String: JSONValue]) {
        for key in ["stateKey", "hourKey", "minuteKey", "activeKey"] {
            bindString(key, in: &fields)
        }
        for (part, key) in [("trailing", "stateKey"), ("openWhen", "key")] {
            guard case var .object(partFields)? = fields[part] else { continue }
            bindString(key, in: &partFields)
            fields[part] = .object(partFields)
        }
    }

    private func bindString(_ key: String, in fields: inout [String: JSONValue]) {
        if case let .string(text)? = fields[key] { fields[key] = .string(interpolate(text)) }
    }

    /// A part's actions; its label was already mapped by `bindTextFields`.
    private func bindPartFields(_ part: inout [String: JSONValue]) {
        for key in ["onTap", "onLongPress", "onDoubleTap"] {
            if case let .array(actions)? = part[key] { part[key] = .array(actions.map(bindAction)) }
        }
    }

    private func bindPart(_ key: String, in fields: inout [String: JSONValue]) {
        guard case var .object(part)? = fields[key] else { return }
        bindPartFields(&part)
        fields[key] = .object(part)
    }

    private func bindList(
        _ key: String,
        in fields: inout [String: JSONValue],
        _ bind: (inout [String: JSONValue]) -> Void
    ) {
        guard case let .array(entries)? = fields[key] else { return }
        fields[key] = .array(entries.map { entry in
            guard case var .object(entryFields) = entry else { return entry }
            bind(&entryFields)
            return .object(entryFields)
        })
    }

    private func bindAction(_ action: JSONValue) -> JSONValue {
        guard case var .object(fields) = action else { return action }
        switch fields["type"] {
        case .string("setState")?:
            bindString("key", in: &fields)
            if let value = fields["value"] { fields["value"] = interpolateScalar(value) }
        case .string("toggle")?, .string("increment")?, .string("decrement")?:
            bindString("key", in: &fields)
        case .string("emit")?:
            if case let .string(name)? = fields["name"] { fields["name"] = .string(interpolate(name)) }
        default:
            break
        }
        return .object(fields)
    }

    private func bindCondition(_ condition: JSONValue) -> JSONValue {
        guard case var .object(fields) = condition else { return condition }
        bindString("key", in: &fields)
        for operand in ["equals", "notEquals"] {
            if let value = fields[operand] { fields[operand] = interpolateScalar(value) }
        }
        for group in ["all", "any"] {
            if case let .array(conditions)? = fields[group] { fields[group] = .array(conditions.map(bindCondition)) }
        }
        if let negated = fields["not"] { fields["not"] = bindCondition(negated) }
        return .object(fields)
    }

    /// A string operand: text is interpolated, numbers and booleans pass through. A string that is
    /// exactly one placeholder keeps the item's own type.
    private func interpolateScalar(_ value: JSONValue) -> JSONValue {
        guard case let .string(text) = value else { return value }
        let segments = PrototypeRepeat.segments(text, alias: alias)
        if segments.count == 1 {
            switch segments[0] {
            case .index: return .number(Double(index))
            case let .field(name): if let typed = item[name] { return typed }
            case .literal: break
            }
        }
        return .string(interpolate(text))
    }

    /// Unknown fields cannot occur after validation; they are left as their literal placeholder.
    private func interpolate(_ text: String) -> String {
        PrototypeRepeat.segments(text, alias: alias).map { segment in
            switch segment {
            case let .literal(literal): literal
            case .index: String(index)
            case let .field(name): item[name].map(rendered) ?? "{\(alias).\(name)}"
            }
        }.joined()
    }

    /// Numbers render as the host does (`PrototypeScalarText`); strings and booleans pass through.
    private func rendered(_ value: JSONValue) -> String {
        value.displayString
    }
}
