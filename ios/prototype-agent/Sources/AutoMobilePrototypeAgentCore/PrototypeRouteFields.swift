import Foundation

/// Route scope uses the same ordered, own-field projection as the TS/Kotlin bindable visitors.
/// Opaque values, list-item headlines, option values, chart series and navigation targets stay literal.
enum PrototypeRouteFields {
    typealias Fields = [String: JSONValue]
    struct Field {
        let text: String
        let path: String
        let pointer: Bool
    }

    static func own(_ node: Fields, path: String) -> [Field] {
        var walker = Walker()
        walker.node(node, path)
        return walker.result
    }

    static func action(_ action: Fields, path: String) -> [Field] {
        var walker = Walker()
        walker.action(action, path)
        return walker.result
    }

    private struct Walker {
        var result: [Field] = []
        mutating func field(_ object: Fields, _ key: String, _ path: String, pointer: Bool = false) {
            if let text = object[key]?.stringValue {
                result.append(.init(text: text, path: "\(path).\(key)", pointer: pointer))
            }
        }

        mutating func object(
            _ value: Fields,
            _ key: String,
            _ path: String,
            _ visit: (inout Walker, Fields, String) -> Void
        ) {
            if let child = value[key]?.objectFields { visit(&self, child, "\(path).\(key)") }
        }

        mutating func list(
            _ value: Fields,
            _ key: String,
            _ path: String,
            _ visit: (inout Walker, Fields, String) -> Void
        ) {
            for (index, raw) in PrototypeStrictBindings.array(value[key]).enumerated() {
                if let child = raw.objectFields { visit(&self, child, "\(path).\(key)[\(index)]") }
            }
        }

        mutating func keys(_ value: Fields, _ key: String, _ path: String) {
            if case let .array(items)? = value[key] {
                for (index, raw) in items.enumerated() {
                    if let text = raw.stringValue { result.append(.init(
                        text: text,
                        path: "\(path).\(key)[\(index)]",
                        pointer: false
                    )) }
                }
            } else { field(value, key, path) }
        }

        mutating func condition(_ value: Fields, _ path: String) {
            field(value, "data", path, pointer: true)
            field(value, "key", path)
            keys(value, "valid", path)
            for key in ["equals", "notEquals"] { field(value, key, path) }
            object(value, "not", path) { $0.condition($1, $2) }
            for key in ["all", "any"] { list(value, key, path) { $0.condition($1, $2) } }
        }

        mutating func binding(_ raw: JSONValue, _ path: String) {
            guard let value = raw.objectFields else { return }
            field(value, "data", path, pointer: true)
            field(value, "state", path)
        }

        mutating func entries(_ value: Fields, _ key: String, _ path: String) {
            let entries = value[key]?.objectFields ?? [:]
            for name in PrototypeContractValidator.sorted(entries.keys) {
                let raw = entries[name]!
                let at = PrototypeContractValidator.keyPath("\(path).\(key)", name)
                if let text = raw.stringValue { result.append(.init(text: text, path: at, pointer: false)) }
                else { binding(raw, at) }
            }
        }

        mutating func action(_ value: Fields, _ path: String) {
            let type = value["type"]?.stringValue ?? ""
            if ["push", "replace"].contains(type) { entries(value, "params", path) }
            if type == "setStack" { list(value, "path", path) { $0.entries($1, "params", $2) } }
            switch type {
            case "setState": field(value, "key", path); field(value, "value", path)
            case "toggle", "increment", "decrement": field(value, "key", path)
            case "emit":
                field(value, "name", path)
                for name in PrototypeContractValidator.sorted((value["context"]?.objectFields ?? [:]).keys) {
                    binding(
                        value["context"]!.objectFields![name]!,
                        PrototypeContractValidator.keyPath("\(path).context", name)
                    )
                }
                keys(value, "requireValid", path)
            case "setData", "appendData", "removeData":
                field(value, "path", path, pointer: true)
                if type != "removeData", let raw = value["value"] { binding(raw, "\(path).value") }
            case "request", "platform":
                if type == "request" {
                    field(value, "url", path)
                    for key in ["headers", "query"] { entries(value, key, path) }
                    if let raw = value["body"] { binding(raw, "\(path).body") }
                } else {
                    for name in PrototypeContractValidator.sorted((value["args"]?.objectFields ?? [:]).keys) {
                        binding(
                            value["args"]!.objectFields![name]!,
                            PrototypeContractValidator.keyPath("\(path).args", name)
                        )
                    }
                }
                field(value, "into", path, pointer: true)
                field(value, "statusKey", path)
                for key in ["onSuccess", "onError"] { list(value, key, path) { $0.action($1, $2) } }
            case "startTimer": list(value, "actions", path) { $0.action($1, $2) }
            default: break
            }
        }

        mutating func actions(_ value: Fields, _ path: String) {
            for key in ["onTap", "onLongPress", "onDoubleTap"] { list(value, key, path) { $0.action($1, $2) } }
        }

        mutating func part(_ value: Fields, _ path: String) { field(value, "label", path); actions(value, path) }
        mutating func node(_ value: Fields, _ path: String) {
            let type = value["type"]?.stringValue ?? ""
            switch type {
            case "text":
                field(value, "text", path)
                object(value, "linkify", path) { $0.actions($1, $2) }
                list(value, "spans", path) { walker, span, at in
                    walker.field(span, "text", at); walker.actions(span, at)
                }
            case "button", "fab": field(value, "label", path)
            case "segmentedButton": list(value, "options", path) { $0.field($1, "label", $2) }
            case "topAppBar":
                field(value, "title", path)
                object(value, "navigationIcon", path) { $0.part($1, $2) }
                list(value, "actions", path) { $0.part($1, $2) }
            case "textField":
                object(value, "trailingIcon", path) { $0.part($1, $2) }
                list(value, "onSubmit", path) { $0.action($1, $2) }
            case "searchBar":
                field(value, "placeholder", path)
                list(value, "trailingActions", path) { $0.part($1, $2) }
                list(value, "onSubmit", path) { $0.action($1, $2) }
            case "tooltip":
                field(value, "text", path)
                list(value, "onDismiss", path) { $0.action($1, $2) }
            case "dialog":
                field(value, "title", path); field(value, "text", path)
                for key in ["confirm", "dismiss"] { object(value, key, path) { $0.part($1, $2) } }
            case "menu": list(value, "items", path) { walker, item, at in
                    walker.field(item, "trailingText", at); walker.part(item, at)
                }
            case "select": field(value, "label", path); list(value, "options", path) { $0.field($1, "label", $2) }
            case "snackbar": field(value, "text", path); object(value, "action", path) { $0.part($1, $2) }
            default: break
            }
            object(value, "enabledWhen", path) { $0.condition($1, $2) }
            list(value, "checks", path) { $0.field($1, "message", $2) }
            object(value, "visibleWhen", path) { $0.condition($1, $2) }
            list(value, "styleWhen", path) { walker, entry, at in
                walker.object(entry, "when", at) { $0.condition($1, $2) }
            }
            actions(value, path)
            object(value, "swipeActions", path) { walker, entry, at in
                for key in ["start", "end"] { walker.list(entry, key, at) { $0.part($1, $2) } }
            }
            object(value, "refresh", path) { walker, entry, at in
                walker.list(entry, "onRefresh", at) { $0.action($1, $2) }
            }
            for key in ["stateKey", "activeKey", "hourKey", "minuteKey", "atEndKey"] { field(value, key, path) }
            for key in ["trailing", "openWhen", "refresh"] {
                object(value, key, path) { $0.field($1, key == "openWhen" ? "key" : "stateKey", $2) }
            }
            if type == "scroll" { list(value, "onStartReached", path) { $0.action($1, $2) } }
            if type == "stack" {
                let routes = value["routes"]?.objectFields ?? [:]
                for name in PrototypeContractValidator.sorted(routes.keys) {
                    let route = routes[name]?.objectFields ?? [:]
                    let at = PrototypeContractValidator.keyPath("\(path).routes", name)
                    for key in ["onEnter", "onBack"] { list(route, key, at) { $0.action($1, $2) } }
                }
            }
        }
    }
}
