import Foundation

/// A failure that prevents the entire embedded screen from being presented.
/// This enum may gain cases; include a default branch when switching over it.
public enum PrototypeLoadError: Error, Equatable, Sendable, LocalizedError {
    /// A validation diagnostic using the shared structural contract's JSON paths.
    case invalidSpec(path: String, message: String)
    /// Required capabilities absent from `AutoMobilePrototypeCapabilities.supported`, sorted by name.
    case unsupportedCapabilities([String])

    /// A visible, actionable diagnostic for the embedding app's error UI.
    public var errorDescription: String? {
        switch self {
        case let .invalidSpec(path, message): "\(path): \(message)"
        case let .unsupportedCapabilities(missing): "Unsupported prototype capabilities: " + missing
            .joined(separator: ", ")
        }
    }

    /// Validates in-memory spec bytes without starting a renderer, storage, or networking.
    public static func validate(spec: Data) throws {
        _ = try PrototypeEmbeddedSpec.load(data: spec)
    }
}

enum PrototypeEmbeddedSpec {
    static func load(
        data: Data, supported: [String] = AutoMobilePrototypeCapabilities.supported
    )
        throws -> (spec: PrototypeSpec, bytes: Int)
    {
        try PrototypeContractValidator.validate(data: data)
        switch PrototypeViewerSpecLoader.load(data: data) {
        case let .invalid(path, message): throw PrototypeLoadError.invalidSpec(path: path, message: message)
        case let .loaded(spec, bytes):
            let required = requiredCapabilities(spec)
            let missing = required.subtracting(supported).sorted()
            guard missing.isEmpty else { throw PrototypeLoadError.unsupportedCapabilities(missing) }
            return (spec, bytes)
        default:
            // The Data loader has only loaded/invalid outcomes; saved-layout outcomes stay file-only.
            throw PrototypeLoadError.invalidSpec(path: "$", message: "Expected prototype JSON")
        }
    }

    /// Walks the authored tree, including hidden screens and empty repeat templates, rather than
    /// the expanded screen. Data and emit payloads are never interpreted as feature declarations.
    private static func requiredCapabilities(_ spec: PrototypeSpec) -> Set<String> {
        var required = Set<String>()
        func need(_ feature: String) { required.insert("prototype_\(feature)_v1") }
        if spec.storage != nil { need("storage") }
        if spec.data != nil { need("data_model") }
        if spec.theme != nil { need("theme_modes") }
        if spec.window.chrome != nil { need("window_chrome") }
        func actions(_ value: JSONValue?) {
            guard case let .array(items) = value else { return }
            for item in items {
                guard let fields = item.objectFields else { continue }
                switch fields["type"]?.stringValue {
                case "request":
                    need("network")
                    if fields["via"]?.stringValue == "device" { need("network_device") }
                case "setData", "appendData", "removeData": need("data_actions")
                case "emit" where fields["context"] != nil: need("emit_context")
                case "requireValid": need("checks")
                default: break
                }
                actions(fields["onSuccess"])
                actions(fields["onError"])
            }
        }
        func node(_ value: JSONValue) {
            guard let fields = value.objectFields else { return }
            let type = fields["type"]?.stringValue
            switch type {
            case "flow", "grid": need("flow_grid")
            case "carousel": need("carousel")
            case "searchBar": need("search_bar")
            case "text" where fields["spans"] != nil: need("rich_text")
            case "menu", "select": need("menus")
            case "stack": need("stack")
            case "textField":
                if [
                    "label",
                    "variant",
                    "supportingText",
                    "keyboardType",
                    "secure",
                    "multiline",
                    "minLines",
                    "maxLines",
                    "maxLength",
                ].contains(where: { fields[$0] != nil }) { need("text_field_options") }
                if ["trailingIcon", "imeAction", "onSubmit"]
                    .contains(where: { fields[$0] != nil }) { need("text_field_actions") }
                if fields["leadingIcon"] != nil { need("text_field_leading_icon") }
            case "pager":
                if ["axis", "pageSpacing", "peek", "pageSize"]
                    .contains(where: { fields[$0] != nil }) { need("pager_options") }
                if fields["indicator"] != nil { need("carousel") }
            default: break
            }
            if fields["onLongPress"] != nil || fields["onDoubleTap"] != nil { need("gestures") }
            if fields["swipeActions"] != nil { need("swipe_actions") }
            if fields["refresh"] != nil { need("refresh") }
            if ["checks", "enabledWhen", "validateOn"].contains(where: { fields[$0] != nil }) { need("checks") }
            if fields["repeat"] != nil { need("data_model") }
            if type == "icon" {
                if ["rounded", "sharp", "twoTone"]
                    .contains(fields["variant"]?.stringValue ?? "") { need("icon_variant") }
            }
            for key in ["onTap", "onLongPress", "onDoubleTap", "onSubmit", "onChange"] { actions(fields[key]) }
            for key in ["navigationIcon", "trailingIcon", "refresh", "confirm", "dismiss", "action"] {
                if let nested = fields[key]?.objectFields { actions(nested["onTap"]); actions(nested["onRefresh"]) }
            }
            for key in ["actions", "trailingActions", "items"] {
                if case let .array(items) = fields[key] {
                    for item in items {
                        if let item = item.objectFields { actions(item["onTap"]) }
                    }
                }
            }
            if let swipes = fields["swipeActions"]?.objectFields {
                for key in ["start", "end"] {
                    if case let .array(items) = swipes[key] {
                        for item in items {
                            if let item = item.objectFields { actions(item["onTap"]) }
                        }
                    }
                }
            }
            // Node containers, rather than arbitrary recursive objects (payload/data can contain `type`).
            for key in ["children", "spans", "options"] {
                if case let .array(children) = fields[key] { for child in children {
                    node(child)
                } }
            }
            if let screens = fields["screens"]?.objectFields { for screen in screens.values { node(screen) } }
            if let child = fields["child"] { node(child) }
        }
        node(spec.authoredRoot)
        return required
    }
}
