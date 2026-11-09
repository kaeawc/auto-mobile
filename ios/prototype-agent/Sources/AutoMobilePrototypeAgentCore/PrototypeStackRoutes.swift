import Foundation

/// Route params, enter and back actions and the persisted path of a `stack` (#14188,
/// `prototype_routes_v1`). Pure pieces shared by the session, the storage restore and the tree build;
/// the semantics match Android's runtime.
enum PrototypeStackRoutes {
    /// Lifecycle (onEnter/onBack) dispatch nests at most this deep; deeper lists are skipped.
    static let maxLifecycleDepth = 8

    /// The params a stack declares for `screen`; a screen without a declaration takes none.
    static func declared(_ node: PrototypeNode, screen: String) -> [String: String] {
        node.routes?[screen]?.params ?? [:]
    }

    /// Whether `params` match `declared` exactly: every declared name present, nothing undeclared, and
    /// each value a scalar of the declared type (a finite number for "number").
    static func matches(_ params: [String: JSONValue], declared: [String: String]) -> Bool {
        guard Set(params.keys) == Set(declared.keys) else { return false }
        return params.allSatisfy { name, value in
            switch (declared[name], value) {
            case (.some("string"), .string): true
            case (.some("boolean"), .bool): true
            case let (.some("number"), .number(number)): number.isFinite
            default: false
            }
        }
    }

    /// Whether every entry names a screen of `node` with params matching its declaration.
    static func isValid(_ entries: [PrototypeStackPathEntry], stack node: PrototypeNode) -> Bool {
        entries.allSatisfy { entry in
            node.screens?[entry.screen] != nil && matches(entry.params, declared: declared(node, screen: entry.screen))
        }
    }

    /// `screen_changed`'s payload: `{screen, depth}`, plus the top entry's `params` when it has any.
    static func screenChangedPayload(_ snapshot: PrototypeStackSnapshot) -> JSONValue {
        var payload: [String: JSONValue] = [
            "screen": .string(snapshot.entries.last?.screen ?? ""),
            "depth": .number(Double(snapshot.depth)),
        ]
        if let params = snapshot.entries.last?.params, !params.isEmpty { payload["params"] = .object(params) }
        return .object(payload)
    }

    // MARK: Persisted path

    /// The `stack:<id>` storage value: `[{screen, params?}]`, params omitted when empty.
    static func storedValue(_ snapshot: PrototypeStackSnapshot) -> JSONValue {
        .array(snapshot.entries.map { entry in
            var fields: [String: JSONValue] = ["screen": .string(entry.screen)]
            if !entry.params.isEmpty { fields["params"] = .object(entry.params) }
            return .object(fields)
        })
    }

    /// A stored `stack:<id>` value as a path of `node`, or nil when it no longer fits: not an array of
    /// 1...MAX_PROTOTYPE_STACK_DEPTH `{screen, params?}` objects, an unknown screen, or params that do
    /// not match the screen's declaration (literal scalars only).
    static func storedPath(_ value: JSONValue, stack node: PrototypeNode) -> [PrototypeStackPathEntry]? {
        guard case let .array(items) = value, (1 ... PrototypeLimits.maxStackDepth).contains(items.count) else {
            return nil
        }
        var entries: [PrototypeStackPathEntry] = []
        for item in items {
            guard let fields = item.objectFields, let screen = fields["screen"]?.stringValue,
                  fields.keys.allSatisfy({ $0 == "screen" || $0 == "params" }) else { return nil }
            var params: [String: JSONValue] = [:]
            if let raw = fields["params"] {
                guard let object = raw.objectFields else { return nil }
                params = object
            }
            entries.append(PrototypeStackPathEntry(screen: screen, params: params))
        }
        return isValid(entries, stack: node) ? entries : nil
    }

    // MARK: Placeholder scope

    /// For each stack, the params `{route.<name>}` binds to in each screen of its path: the top entry's
    /// for the top screen and, so a screen still drawn under the top (an edge swipe, an exit animation)
    /// shows its own values, the topmost entry's for each other screen in the path. Screens without
    /// params are left out, and so are stacks with none.
    static func scope(_ stacks: [String: PrototypeStackSnapshot]) -> PrototypeRouteBinder.Scope {
        stacks.reduce(into: [:]) { scope, stack in
            var screens: [String: [String: JSONValue]] = [:]
            for entry in stack.value.entries.reversed() where screens[entry.screen] == nil {
                screens[entry.screen] = entry.params
            }
            screens = screens.filter { !$0.value.isEmpty }
            if !screens.isEmpty { scope[stack.key] = screens }
        }
    }
}

/// Binds `{route.<name>}` placeholders in the authored tree before data resolution (#14188), with the
/// same ordered field projection the validator reads (`PrototypeRouteFields`). A stack's screen subtree
/// and its `routes` onEnter/onBack lists bind to that screen's params in the scope; a nested stack's
/// screens bind to the nested stack's own. In a string field the param renders as repeat text does;
/// a condition operand or `setState` value that is exactly one placeholder keeps the param's JSON type;
/// a whole data-pointer segment takes the rendered value escaped per RFC 6901. `{index}` and every
/// other brace text are left as authored, as is a placeholder whose param the scope lacks.
enum PrototypeRouteBinder {
    /// Stack id, then screen name, then that screen's params.
    typealias Scope = [String: [String: [String: JSONValue]]]

    static func bind(_ root: JSONValue, scope: Scope) -> JSONValue {
        scope.isEmpty ? root : walk(root, params: nil, scope: scope)
    }

    private static func walk(_ value: JSONValue, params: Fields.Params?, scope: Scope) -> JSONValue {
        guard case var .object(node) = value else { return value }
        if let params { Fields(params: params).node(&node) }
        let slots = node["type"] == .string("adaptive") ? PrototypeAdaptive.slots : ["header", "footer", "child"]
        for key in slots {
            if let child = node[key] { node[key] = walk(child, params: params, scope: scope) }
        }
        if case let .array(children)? = node["children"] {
            node["children"] = .array(children.map { walk($0, params: params, scope: scope) })
        }
        guard case let .object(screens)? = node["screens"] else { return .object(node) }
        var own: [String: Fields.Params] = [:]
        if node["type"] == .string("stack"), let id = node["id"]?.stringValue { own = scope[id] ?? [:] }
        var bound: [String: JSONValue] = [:]
        for (name, screen) in screens {
            bound[name] = walk(screen, params: own[name], scope: scope)
        }
        node["screens"] = .object(bound)
        if case var .object(routes)? = node["routes"] {
            for (name, params) in own {
                guard case var .object(route)? = routes[name] else { continue }
                let binder = Fields(params: params)
                for key in ["onEnter", "onBack"] {
                    binder.list(&route, key) { binder.action(&$0) }
                }
                routes[name] = .object(route)
            }
            node["routes"] = .object(routes)
        }
        return .object(node)
    }

    /// The mutating twin of `PrototypeRouteFields.Walker` for one owner's params.
    struct Fields {
        typealias Params = [String: JSONValue]
        typealias Object = [String: JSONValue]
        let params: Params

        private enum Kind { case text, pointer, typed }

        private func segments(_ text: String) -> [PrototypeRepeat.Segment] {
            PrototypeRepeat.segments(text, alias: "route")
        }

        func text(_ text: String) -> String {
            let parts = segments(text)
            var inDataReference = false
            return parts.enumerated().map { index, segment in
                switch segment {
                case let .literal(literal):
                    if let opening = literal.range(of: "{data:/", options: .backwards) {
                        inDataReference = !literal[opening.upperBound...].contains("}")
                    } else if literal.contains("}") {
                        inDataReference = false
                    }
                    return literal
                case .index: return "{index}"
                case let .field(name):
                    guard let value = params[name]?.displayString else { return "{route.\(name)}" }
                    // Only a whole segment inside a data reference is a pointer operand.
                    if inDataReference, index > 0, index + 1 < parts.count,
                       case let .literal(before) = parts[index - 1], before.hasSuffix("/"),
                       case let .literal(after) = parts[index + 1], after.hasPrefix("/") || after.hasPrefix("}")
                    {
                        return value.replacingOccurrences(of: "~", with: "~0")
                            .replacingOccurrences(of: "/", with: "~1")
                    }
                    return value
                }
            }.joined()
        }

        func typed(_ text: String) -> JSONValue {
            let parts = segments(text)
            if parts.count == 1, case let .field(name) = parts[0], let value = params[name] { return value }
            return .string(self.text(text))
        }

        func pointer(_ text: String) -> String {
            text.split(separator: "/", omittingEmptySubsequences: false).map { part in
                let parts = segments(String(part))
                guard parts.count == 1, case let .field(name) = parts[0], let value = params[name] else {
                    return String(part)
                }
                return value.displayString
                    .replacingOccurrences(of: "~", with: "~0")
                    .replacingOccurrences(of: "/", with: "~1")
            }.joined(separator: "/")
        }

        private func field(_ object: inout Object, _ key: String, _ kind: Kind = .text) {
            guard case let .string(value)? = object[key] else { return }
            switch kind {
            case .text: object[key] = .string(text(value))
            case .pointer: object[key] = .string(pointer(value))
            case .typed: object[key] = typed(value)
            }
        }

        private func object(_ value: inout Object, _ key: String, _ visit: (inout Object) -> Void) {
            guard case var .object(child)? = value[key] else { return }
            visit(&child)
            value[key] = .object(child)
        }

        func list(_ value: inout Object, _ key: String, _ visit: (inout Object) -> Void) {
            guard case let .array(items)? = value[key] else { return }
            value[key] = .array(items.map { item in
                guard case var .object(child) = item else { return item }
                visit(&child)
                return .object(child)
            })
        }

        private func keys(_ value: inout Object, _ key: String) {
            if case let .array(items)? = value[key] {
                value[key] = .array(items.map { item in
                    if case let .string(entry) = item { return .string(text(entry)) }
                    return item
                })
            } else {
                field(&value, key)
            }
        }

        private func condition(_ value: inout Object) {
            field(&value, "data", .pointer)
            field(&value, "key")
            keys(&value, "valid")
            for key in ["equals", "notEquals"] { field(&value, key, .typed) }
            for key in ["contains", "startsWith"] { field(&value, key) }
            object(&value, "not") { condition(&$0) }
            for key in ["all", "any"] { list(&value, key) { condition(&$0) } }
        }

        private func binding(_ raw: JSONValue) -> JSONValue {
            guard case var .object(value) = raw else { return raw }
            field(&value, "data", .pointer)
            field(&value, "state")
            return .object(value)
        }

        private func entries(_ value: inout Object, _ key: String) {
            guard case let .object(members)? = value[key] else { return }
            value[key] = .object(members.mapValues { raw in
                if case let .string(entry) = raw { return .string(text(entry)) }
                return binding(raw)
            })
        }

        private func bindings(_ value: inout Object, _ key: String) {
            guard case let .object(members)? = value[key] else { return }
            value[key] = .object(members.mapValues(binding))
        }

        func action(_ value: inout Object) {
            let type = value["type"]?.stringValue ?? ""
            if ["push", "replace"].contains(type) { entries(&value, "params") }
            if type == "setStack" { list(&value, "path") { entries(&$0, "params") } }
            switch type {
            case "setState":
                field(&value, "key")
                field(&value, "value", .typed)
            case "toggle", "increment", "decrement": field(&value, "key")
            case "emit":
                field(&value, "name")
                bindings(&value, "context")
                keys(&value, "requireValid")
            case "setData", "appendData", "prependData", "upsertData", "removeData":
                field(&value, "path", .pointer)
                if type != "removeData", let raw = value["value"] { value["value"] = binding(raw) }
            case "request", "platform":
                if type == "request" {
                    field(&value, "url")
                    for key in ["headers", "query"] { entries(&value, key) }
                    if let raw = value["body"] { value["body"] = binding(raw) }
                } else {
                    bindings(&value, "args")
                }
                field(&value, "into", .pointer)
                if type == "request" { object(&value, "append") { field(&$0, "to", .pointer) } }
                field(&value, "statusKey")
                for key in ["onSuccess", "onError"] { list(&value, key) { action(&$0) } }
            case "startTimer": list(&value, "actions") { action(&$0) }
            default: break
            }
        }

        private func actions(_ value: inout Object) {
            for key in ["onTap", "onLongPress", "onDoubleTap", "onEndReached", "onStartReached", "onAppear"] {
                list(&value, key) { action(&$0) }
            }
        }

        private func part(_ value: inout Object) {
            field(&value, "label")
            actions(&value)
        }

        /// One node's own bindable fields; children, screens and a stack's `routes` are bound by the walk.
        func node(_ value: inout Object) {
            let type = value["type"]?.stringValue ?? ""
            object(&value, "semantics") { semantics in
                field(&semantics, "label")
                field(&semantics, "hint")
            }
            componentFields(&value, type: type)
            field(&value, "errorText")
            object(&value, "errorWhen") { condition(&$0) }
            object(&value, "enabledWhen") { condition(&$0) }
            list(&value, "checks") { field(&$0, "message") }
            object(&value, "visibleWhen") { condition(&$0) }
            list(&value, "styleWhen") { entry in object(&entry, "when") { condition(&$0) } }
            actions(&value)
            object(&value, "swipeActions") { entry in
                for key in ["start", "end"] { list(&entry, key) { part(&$0) } }
            }
            object(&value, "refresh") { entry in list(&entry, "onRefresh") { action(&$0) } }
            for key in ["stateKey", "activeKey", "hourKey", "minuteKey", "atEndKey"] { field(&value, key) }
            for key in ["trailing", "openWhen", "refresh"] {
                object(&value, key) { field(&$0, key == "openWhen" ? "key" : "stateKey") }
            }
        }

        private func componentFields(_ value: inout Object, type: String) {
            switch type {
            case "image": field(&value, "asset")
            case "text":
                field(&value, "text")
                object(&value, "linkify") { actions(&$0) }
                list(&value, "spans") { span in
                    field(&span, "text")
                    actions(&span)
                }
            case "button", "fab": field(&value, "label")
            case "segmentedButton": list(&value, "options") { field(&$0, "label") }
            case "topAppBar":
                field(&value, "title")
                object(&value, "navigationIcon") { part(&$0) }
                list(&value, "actions") { part(&$0) }
            case "textField":
                object(&value, "trailingIcon") { part(&$0) }
                list(&value, "onSubmit") { action(&$0) }
            case "searchBar":
                field(&value, "placeholder")
                list(&value, "trailingActions") { part(&$0) }
                list(&value, "onSubmit") { action(&$0) }
            case "tooltip":
                field(&value, "text")
                list(&value, "onDismiss") { action(&$0) }
            case "dialog":
                field(&value, "title")
                field(&value, "text")
                for key in ["confirm", "dismiss"] { object(&value, key) { part(&$0) } }
            case "menu":
                list(&value, "items") { item in
                    field(&item, "trailingText")
                    part(&item)
                }
            case "select":
                field(&value, "label")
                list(&value, "options") { field(&$0, "label") }
            case "snackbar":
                field(&value, "text")
                object(&value, "action") { part(&$0) }
            default: break
            }
        }
    }
}
