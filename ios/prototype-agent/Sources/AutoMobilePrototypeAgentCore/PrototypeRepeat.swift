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
    static func expand(
        _ node: JSONValue,
        formatter: PrototypeValueFormatter = FoundationPrototypeValueFormatter(),
        environment: PrototypeFormatEnvironment = .device()
    )
        -> JSONValue
    {
        guard case var .object(fields) = node else { return node }
        let lazy = fields["type"] == .string("list")
        if !lazy, case let .array(children)? = fields["children"] {
            let expanded: [JSONValue] = if case let .object(spec)? = fields["repeat"] {
                instances(of: spec, formatter: formatter, environment: environment).flatMap { instance in
                    children.enumerated().map { index, child in
                        var bound = instance.bind(child)
                        // As on Android, the first template child anchors the repeat row.
                        if index == 0, let key = spec["key"]?.stringValue,
                           let value = instance.item[key], var fields = bound.objectFields,
                           let rendered = PrototypeScrollTarget.scalarKey(value)
                        {
                            fields["_repeatKey"] = .string(rendered)
                            bound = .object(fields)
                        }
                        return bound
                    }
                }
            } else {
                children
            }
            fields["children"] = .array(expanded.map { expand($0, formatter: formatter, environment: environment) })
        }
        if !lazy { fields["repeat"] = nil }
        for name in ["child", "header", "footer"] {
            if let child = fields[name] { fields[name] = expand(child, formatter: formatter, environment: environment) }
        }
        if case let .object(screens)? = fields["screens"] {
            fields["screens"] = .object(screens
                .mapValues { expand($0, formatter: formatter, environment: environment) })
        }
        return .object(fields)
    }

    /// Runtime-only checks whose answers depend on device locale and the build's clock snapshot.
    static func validateDerivedRows(
        _ node: JSONValue, path: String = "root", formatter: PrototypeValueFormatter,
        environment: PrototypeFormatEnvironment
    )
        throws
    {
        guard let fields = node.objectFields else { return }
        if let repeated = fields["repeat"]?.objectFields,
           let derived = repeated["derive"]?.objectFields, !derived.isEmpty
        {
            let rows = instances(of: repeated, formatter: formatter, environment: environment)
            for child in PrototypeStrictRepeats.children(fields, path: path) {
                for row in rows {
                    try derivedBindings(
                        .object(child.value),
                        path: child.path,
                        repeatPath: path,
                        row: row,
                        names: Set(derived.keys)
                    )
                }
            }
            if let key = repeated["key"]?.stringValue, derived[key] != nil {
                var seen: [[UInt16]: Int] = [:]
                for row in rows {
                    guard let value = row.item[key] else {
                        throw PrototypeContractValidator.invalid(
                            "\(path).repeat.key",
                            "Unknown repeat field \(PrototypeContractValidator.quoted(key))"
                        )
                    }
                    let text = value.displayString
                    let identity = Array(text.utf16)
                    if let first = seen[identity] {
                        throw PrototypeContractValidator.invalid(
                            "\(path).repeat.key",
                            "Duplicate repeat key \(PrototypeContractValidator.quoted(text)) (items \(first) and \(row.index))"
                        )
                    }
                    seen[identity] = row.index
                }
            }
        }
        for child in PrototypeStrictRepeats.children(fields, path: path) {
            try validateDerivedRows(
                .object(child.value),
                path: child.path,
                formatter: formatter,
                environment: environment
            )
        }
    }

    private static func derivedBindings(
        _ value: JSONValue, path: String, repeatPath: String, row: PrototypeRepeatInstance, names: Set<String>
    )
        throws
    {
        if case let .array(items) = value {
            for (index, item) in items.enumerated() {
                try derivedBindings(item, path: "\(path)[\(index)]", repeatPath: repeatPath, row: row, names: names)
            }
            return
        }
        guard let fields = value.objectFields else { return }
        if fields.count == 1, fields["value"] != nil { return }
        let keyFields: Set<String> = [
            "key",
            "stateKey",
            "activeKey",
            "hourKey",
            "minuteKey",
            "atEndKey",
            "statusKey",
            "state",
        ]
        for key in PrototypeContractValidator.sorted(fields.keys) {
            guard !["payload", "repeat", "linkify"].contains(key), let child = fields[key] else { continue }
            let fieldPath = PrototypeContractValidator.keyPath(path, key)
            if let text = child.stringValue, segments(text, alias: row.alias).contains(where: {
                if case let .field(name) = $0 { return names.contains(name) }; return false
            }) {
                let bound = row.interpolate(text)
                if keyFields.contains(key), !isFieldName(bound) {
                    throw PrototypeContractValidator.invalid(
                        "\(repeatPath).repeat.items[\(row.index)]",
                        "Bound state key \(PrototypeContractValidator.quoted(bound)) is invalid"
                    )
                }
                if key == "name", fields["type"] == .string("emit") {
                    if bound.isEmpty {
                        throw PrototypeContractValidator.invalid(
                            fieldPath,
                            "Expanded emit name is empty for item \(row.index)"
                        )
                    }
                    if bound.hasPrefix(PrototypePlatformValidator.reservedEmitPrefix) {
                        throw PrototypeContractValidator.invalid(
                            fieldPath,
                            "Emit names starting with prototype_ are reserved for runtime events"
                        )
                    }
                }
            } else { try derivedBindings(child, path: fieldPath, repeatPath: repeatPath, row: row, names: names) }
        }
    }

    /// `key` is accepted but rows keep positional identity until keyed patching (#11675).
    private static func instances(
        of spec: [String: JSONValue],
        formatter: PrototypeValueFormatter,
        environment: PrototypeFormatEnvironment
    )
        -> [PrototypeRepeatInstance]
    {
        let derive = (
            try? spec["derive"]
                .map { try JSONDecoder().decode([String: PrototypeDerivedEntry].self, from: JSONEncoder().encode($0)) }
        ) ??
            [:]
        guard case let .string(alias)? = spec["as"], case let .array(items)? = spec["items"] else { return [] }
        return items.enumerated().map { index, item in
            guard case let .object(fields) = item else { return PrototypeRepeatInstance(
                alias: alias,
                item: [:],
                index: index
            ) }
            return PrototypeRepeatInstance(
                alias: alias,
                item: PrototypeDerivedValues
                    .project(fields, derive: derive, formatter: formatter, environment: environment),
                index: index
            )
        }
    }

    private static func bindCompositeTextFields(
        _ fields: inout [String: JSONValue],
        string: (String, inout [String: JSONValue]) -> Void,
        part: (String, inout [String: JSONValue]) -> Void,
        list: (String, inout [String: JSONValue]) -> Void
    ) {
        switch fields["type"] {
        case .string("topAppBar")?:
            string("title", &fields)
            part("navigationIcon", &fields)
            list("actions", &fields)
        case .string("textField")?:
            string("errorText", &fields)
            part("trailingIcon", &fields)
        case .string("searchBar")?:
            string("placeholder", &fields)
            list("trailingActions", &fields)
        case .string("dialog")?:
            string("title", &fields)
            string("text", &fields)
            part("confirm", &fields)
            part("dismiss", &fields)
        case .string("snackbar")?:
            string("text", &fields)
            part("action", &fields)
        default: break
        }
    }

    private static func bindBasicTextFields(
        _ fields: inout [String: JSONValue],
        string: (String, inout [String: JSONValue]) -> Void,
        part: (String, inout [String: JSONValue]) -> Void,
        list: (String, inout [String: JSONValue]) -> Void
    ) {
        switch fields["type"] {
        case .string("text")?:
            string("text", &fields)
            if case let .array(spans)? = fields["spans"] {
                fields["spans"] = .array(spans.map { span in
                    guard case var .object(member) = span else { return span }
                    string("text", &member)
                    return .object(member)
                })
            }
        case .string("button")?, .string("fab")?: string("label", &fields)
        case .string("listItem")?:
            string("headline", &fields)
            string("supporting", &fields)
        case .string("segmentedButton")?: list("options", &fields)
        case .string("select")?:
            string("label", &fields)
            list("options", &fields)
        case .string("menu")?:
            guard case let .array(items)? = fields["items"] else { break }
            fields["items"] = .array(items.map { item in
                guard case var .object(entry) = item else { return item }
                string("label", &entry)
                string("trailingText", &entry)
                return .object(entry)
            })
        default: bindCompositeTextFields(&fields, string: string, part: part, list: list)
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
        if case var .object(swipe)? = fields["swipeActions"] {
            list("start", in: &swipe)
            list("end", in: &swipe)
            fields["swipeActions"] = .object(swipe)
        }
        if case let .array(checks)? = fields["checks"] {
            fields["checks"] = .array(checks.map { check in
                guard case var .object(rule) = check else { return check }
                string("message", in: &rule)
                return .object(rule)
            })
        }
        if case var .object(semantics)? = fields["semantics"] {
            string("label", in: &semantics)
            string("hint", in: &semantics)
            fields["semantics"] = .object(semantics)
        }
        bindBasicTextFields(&fields, string: string, part: part, list: list)
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
        return (alias == "route" ? PrototypeContractValidator.matches("pathKey", field) : isFieldName(field)) ?
            (.field(field), end) : nil
    }

    static func isFieldName(_ name: String) -> Bool {
        PrototypeContractValidator.matches("stateKey", name)
    }
}

/// Only emit-context scope checks are added here; full spec cross-field validation stays on the host.
extension PrototypeRepeat {
    static func validateEmitContexts(_ root: JSONValue, data: [String: JSONValue]?) throws {
        var repeats = PrototypeRepeatData(data: data)
        try validateEmitContexts(root, path: "root", scope: nil, repeats: &repeats)
    }

    private struct EmitScope {
        let alias: String
        let items: [JSONValue]
    }

    private static func emitChildScope(
        _ fields: [String: JSONValue],
        scope: EmitScope?,
        repeats: inout PrototypeRepeatData
    )
        -> EmitScope?
    {
        var childScope = scope
        if case let .object(spec)? = fields["repeat"], let alias = spec["as"]?.stringValue {
            let items: JSONValue
            if case let .object(source)? = spec["items"], let pointer = source["path"]?.stringValue {
                items = repeats.items(pointer)
            } else {
                items = spec["items"] ?? .array([])
            }
            if case let .array(rows) = items {
                let names = spec["derive"]?.objectFields?.keys ?? [:].keys
                let derivedFields = Dictionary(uniqueKeysWithValues: names.map { ($0, JSONValue.string("")) })
                let projected = rows.map { row in
                    JSONValue.object((row.objectFields ?? [:]).merging(derivedFields) { old, _ in old })
                }
                childScope = EmitScope(alias: alias, items: projected)
            }
        }
        return childScope
    }

    private static func validateEmitContexts(
        _ node: JSONValue, path: String, scope: EmitScope?, repeats: inout PrototypeRepeatData
    )
        throws
    {
        guard case let .object(fields) = node else { return }
        for name in ["onTap", "onLongPress", "onDoubleTap", "onEndReached", "onAppear"] {
            try validateEmitActions(fields[name], path: "\(path).\(name)", scope: scope)
        }
        if let linkify = fields["linkify"]?.objectFields {
            try validateEmitActions(linkify["onTap"], path: "\(path).linkify.onTap", scope: scope, matchBindings: true)
        }
        if let refresh = fields["refresh"]?.objectFields {
            try validateEmitActions(refresh["onRefresh"], path: "\(path).refresh.onRefresh", scope: scope)
        }
        for name in ["header", "footer"] {
            if let child = fields[name] { try validateEmitContexts(
                child,
                path: "\(path).\(name)",
                scope: scope,
                repeats: &repeats
            ) }
        }
        // Existing composite-part action locations, matching Instance.bindComponentActions.
        for part in ["navigationIcon", "confirm", "dismiss", "action"] {
            if case let .object(member)? = fields[part] {
                try validateEmitActions(member["onTap"], path: "\(path).\(part).onTap", scope: scope)
            }
        }
        if case let .array(actions)? = fields["actions"] {
            for (index, action) in actions.enumerated() {
                if case let .object(member) = action {
                    try validateEmitActions(member["onTap"], path: "\(path).actions[\(index)].onTap", scope: scope)
                }
            }
        }
        let childScope = emitChildScope(fields, scope: scope, repeats: &repeats)
        if case let .array(children)? = fields["children"] {
            for (index, child) in children.enumerated() {
                try validateEmitContexts(
                    child,
                    path: "\(path).children[\(index)]",
                    scope: childScope,
                    repeats: &repeats
                )
            }
        }
        if let child = fields["child"] {
            try validateEmitContexts(child, path: "\(path).child", scope: childScope, repeats: &repeats)
        }
        for (screen, screenPath) in PrototypeStacks.screenChildren(in: fields, path: path) {
            try validateEmitContexts(screen, path: screenPath, scope: childScope, repeats: &repeats)
        }
    }

    private static func validateEmitBinding(
        _ binding: [String: JSONValue],
        path bindingPath: String,
        scope: EmitScope?
    )
        throws
    {
        if binding["item"] != nil || binding["index"] != nil {
            guard let scope else {
                throw PrototypeEmitContext.violation(
                    bindingPath,
                    "Emit item/index binding outside a repeat template"
                )
            }
            if let field = binding["item"]?
                .stringValue { try requireEmitField(field, at: bindingPath, scope: scope) }
        }
        if let key = binding["state"]?.stringValue, let scope {
            for segment in segments(key, alias: scope.alias) {
                if case let .field(field) = segment { try requireEmitField(
                    field,
                    at: "\(bindingPath).state",
                    scope: scope
                ) }
            }
        }
    }

    private static func validateEmitActions(
        _ raw: JSONValue?, path: String, scope: EmitScope?, matchBindings: Bool = false
    )
        throws
    {
        guard case let .array(actions)? = raw else { return }
        for (index, rawAction) in actions.enumerated() {
            guard case let .object(action) = rawAction else { continue }
            let lists = action["type"] == .string("startTimer") ? ["actions"] : ["onSuccess", "onError"]
            for list in lists {
                try validateEmitActions(
                    action[list],
                    path: "\(path)[\(index)].\(list)",
                    scope: scope,
                    matchBindings: matchBindings
                )
            }
            guard action["type"] == .string("emit"), let context = action["context"] else { continue }
            let contextPath = "\(path)[\(index)].context"
            // Match values are strings supplied at tap time, after the row is bound.
            let checkedContext: JSONValue = if matchBindings, let fields = context.objectFields {
                .object(fields.mapValues { binding in
                    if let form = binding.objectFields, form.count == 1, form["match"] != nil {
                        return .object(["value": .string("")])
                    }
                    return binding
                })
            } else { context }
            let bindings = try PrototypeEmitContext.validate(checkedContext, path: contextPath)
            for name in bindings.keys.sorted(by: { $0.utf8.lexicographicallyPrecedes($1.utf8) }) {
                guard case let .object(binding)? = bindings[name] else { continue }
                let bindingPath = PrototypeLimits.dataMemberPath(contextPath, key: name)
                try validateEmitBinding(binding, path: bindingPath, scope: scope)
            }
        }
    }

    private static func requireEmitField(_ field: String, at path: String, scope: EmitScope) throws {
        guard scope.items.allSatisfy({ row in
            if case let .object(fields) = row { return fields[field] != nil }
            return false
        }) else {
            let encoder = JSONEncoder()
            encoder.outputFormatting = .withoutEscapingSlashes
            let quoted = try String(data: encoder.encode(field), encoding: .utf8) ?? "\"\""
            throw PrototypeEmitContext.violation(path, "Unknown repeat field \(quoted)")
        }
    }
}

struct PrototypeRepeatInstance {
    let alias: String
    let item: [String: JSONValue]
    let index: Int

    /// One template node bound to this instance; descendants are bound too.
    func bind(_ node: JSONValue) -> JSONValue {
        guard case var .object(fields) = node else { return node }
        PrototypeRepeat.bindTextFields(&fields, transform: interpolate)
        bindComponentActions(&fields)
        if case let .array(actions)? = fields["onStartReached"] {
            fields["onStartReached"] = .array(actions.map(bindAction))
        }
        if fields["type"] == .string("text") {
            bindList("spans", in: &fields) { bindPartFields(&$0) }
            bindPart("linkify", in: &fields)
        }
        bindStateKeys(&fields)
        bindPartFields(&fields)
        if case var .object(refresh)? = fields["refresh"], case let .array(actions)? = refresh["onRefresh"] {
            refresh["onRefresh"] = .array(actions.map(bindAction))
            fields["refresh"] = .object(refresh)
        }
        for key in ["visibleWhen", "enabledWhen", "errorWhen"] {
            if let condition = fields[key] { fields[key] = bindCondition(condition) }
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
        if case let .object(screens)? = fields["screens"] {
            fields["screens"] = .object(screens.mapValues(bind))
        }
        return .object(fields)
    }

    private func bindTextFieldActions(_ fields: inout [String: JSONValue]) {
        bindPart("trailingIcon", in: &fields)
        if case let .array(actions)? = fields["onSubmit"] {
            fields["onSubmit"] = .array(actions.map(bindAction))
        }
    }

    /// Part actions bind independently of the shared text-kind field mapping.
    private func bindComponentActions(_ fields: inout [String: JSONValue]) {
        if case var .object(swipe)? = fields["swipeActions"] {
            bindList("start", in: &swipe) { bindPartFields(&$0) }
            bindList("end", in: &swipe) { bindPartFields(&$0) }
            fields["swipeActions"] = .object(swipe)
        }
        guard case let .string(type)? = fields["type"] else { return }
        switch type {
        case "topAppBar":
            bindPart("navigationIcon", in: &fields)
            bindList("actions", in: &fields) { bindPartFields(&$0) }
        case "textField":
            bindTextFieldActions(&fields)
        case "searchBar":
            bindList("trailingActions", in: &fields) { bindPartFields(&$0) }
            if case let .array(actions)? = fields["onSubmit"] {
                fields["onSubmit"] = .array(actions.map(bindAction))
            }
        case "chart":
            // A repeat-bound series path takes the row's placeholders, as Android's repeat does.
            bindList("series", in: &fields) { bindString("path", in: &$0) }
        case "menu":
            bindList("items", in: &fields) { bindPartFields(&$0) }
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
        for key in ["stateKey", "hourKey", "minuteKey", "activeKey", "atEndKey"] {
            bindString(key, in: &fields)
        }
        for (part, key) in [("trailing", "stateKey"), ("openWhen", "key"), ("refresh", "stateKey")] {
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
        for key in ["onTap", "onLongPress", "onDoubleTap", "onAppear"] {
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

    private func bindEmit(_ fields: inout [String: JSONValue]) {
        if case let .string(name)? = fields["name"] { fields["name"] = .string(interpolate(name)) }
        if case let .object(context)? = fields["context"] {
            fields["context"] = .object(context.mapValues { raw in
                guard case var .object(binding) = raw else { return raw }
                if let field = binding["item"]?.stringValue {
                    return .object(["value": item[field] ?? .null])
                }
                if binding["index"] == .bool(true) { return .object(["value": .number(Double(index))]) }
                bindString("state", in: &binding)
                return .object(binding)
            })
        }
    }

    private func bindDataAction(_ fields: inout [String: JSONValue]) {
        if case let .string(path)? = fields["path"] { fields["path"] = .string(bindDataPath(path)) }
        if case let .object(binding)? = fields["value"] { fields["value"] = bindDataValue(binding) }
    }

    func bindAction(_ action: JSONValue) -> JSONValue {
        guard case var .object(fields) = action else { return action }
        switch fields["type"] {
        case .string("setState")?:
            bindString("key", in: &fields)
            if let value = fields["value"] { fields["value"] = interpolateScalar(value) }
        case .string("toggle")?, .string("increment")?, .string("decrement")?:
            bindString("key", in: &fields)
        case .string("emit")?:
            bindEmit(&fields)
        case .string("setData")?, .string("appendData")?, .string("prependData")?, .string("removeData")?:
            bindDataAction(&fields)
        case .string("startTimer")?:
            if case let .array(actions)? = fields["actions"] {
                fields["actions"] = .array(actions.map(bindAction))
            }
        case .string("request")?:
            bindRequest(&fields)
        case .string("platform")?:
            bindRequest(&fields)
            if case let .object(args)? = fields["args"] {
                fields["args"] = .object(args.mapValues { value in
                    guard case let .object(binding) = value else { return value }
                    return bindDataValue(binding)
                })
            }
        default:
            break
        }
        if case let .array(keys)? = fields["requireValid"] {
            fields["requireValid"] = .array(keys.map { .string(interpolate($0.stringValue ?? "")) })
        }
        return .object(fields)
    }

    /// A `request` (#12529): `url`, `statusKey` and literal header and query strings take the row's
    /// text placeholders, `into` binds like a data path, binding objects bind like a data value,
    /// and the follow-up lists bind recursively.
    private func bindRequest(_ fields: inout [String: JSONValue]) {
        bindString("url", in: &fields)
        bindString("statusKey", in: &fields)
        if case let .string(path)? = fields["into"] { fields["into"] = .string(bindDataPath(path)) }
        if var append = fields["append"]?.objectFields, let to = append["to"]?.stringValue {
            append["to"] = .string(bindDataPath(to))
            fields["append"] = .object(append)
        }
        for entries in ["headers", "query"] {
            guard case let .object(values)? = fields[entries] else { continue }
            fields[entries] = .object(values.mapValues { value in
                switch value {
                case let .string(text): .string(interpolate(text))
                case let .object(binding): bindDataValue(binding)
                default: value
                }
            })
        }
        if case let .object(binding)? = fields["body"] { fields["body"] = bindDataValue(binding) }
        for list in ["onSuccess", "onError"] {
            if case let .array(actions)? = fields[list] { fields[list] = .array(actions.map(bindAction)) }
        }
    }

    /// Only a whole `{index}` segment binds (#12519), so item content cannot inject pointer syntax.
    private func bindDataPath(_ path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: false)
            .map { $0 == "{index}" ? String(index) : String($0) }
            .joined(separator: "/")
    }

    /// A data action's value binding, bound like an `emit.context` entry: `item` and `index` become
    /// literals of this row, and a `state` key interpolates.
    private func bindDataValue(_ binding: [String: JSONValue]) -> JSONValue {
        if let field = binding["item"]?.stringValue { return .object(["value": item[field] ?? .null]) }
        if binding["index"] == .bool(true) { return .object(["value": .number(Double(index))]) }
        var bound = binding
        bindString("state", in: &bound)
        return .object(bound)
    }

    private func bindCondition(_ condition: JSONValue) -> JSONValue {
        guard case var .object(fields) = condition else { return condition }
        bindString("key", in: &fields)
        if case let .array(keys)? = fields["valid"] {
            fields["valid"] = .array(keys.map { .string(interpolate($0.stringValue ?? "")) })
        } else {
            bindString("valid", in: &fields)
        }
        for operand in ["equals", "notEquals"] {
            if let value = fields[operand] { fields[operand] = interpolateScalar(value) }
        }
        // Substring operands always bind as text, so `contains: "{item.n}"` matches the rendered number.
        for operand in ["contains", "startsWith"] {
            if case let .string(text)? = fields[operand] { fields[operand] = .string(interpolate(text)) }
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
    func interpolate(_ text: String) -> String {
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
