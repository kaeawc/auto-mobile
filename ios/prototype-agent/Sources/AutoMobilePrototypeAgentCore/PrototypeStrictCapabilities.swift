import Foundation

/// Capability computation over authored vocabulary, including hidden and empty-template nodes.
/// Data, literal values and emit payloads are opaque and cannot introduce capabilities.
enum PrototypeStrictCapabilities {
    static func required(_ spec: [String: JSONValue], includeAgentGates: Bool = false) -> Set<String> {
        var result = Set<String>()
        func need(_ feature: String) { result.insert("prototype_\(feature)_v1") }
        if includeAgentGates {
            if spec["theme"] != nil { need("theme_modes") }
            if spec["window"]?.objectFields?["chrome"] != nil { need("window_chrome") }
        }
        if spec["strings"] != nil { need("strings") }
        for key in ["window", "theme"] {
            if let block = spec[key]?.objectFields, block["ios"] != nil || block["android"] != nil {
                need("platform_namespace")
            }
        }
        if spec["theme"]?.objectFields?["design"]?.stringValue == "platform" { need("design_platform") }
        if spec["motion"] == .string("reduced") { need("reduced_motion") }
        if spec["data"] != nil { need("data_model") }
        if spec["derive"] != nil { need("format") }
        if spec["storage"] != nil { need("storage") }
        if spec["window"]?.objectFields?["backdrop"] != nil { need("backdrop") }
        if let colors = spec["theme"]?.objectFields?["colors"]?.objectFields,
           colors["light"] != nil || colors["dark"] != nil { need("theme_modes") }
        func scan(_ value: JSONValue, field: String = "") {
            if case let .array(items) = value { for item in items {
                scan(item)
            }; return }
            guard let fields = value.objectFields else { return }
            if fields.count == 1, fields["value"] != nil { return }
            func textBinding(_ text: String) {
                if text.contains("{t:") { need("strings") }
                if PrototypeDataText.substitutionLength(text, data: nil).recognized { need("data_model") }
            }
            var own = fields
            PrototypeRepeat.bindTextFields(&own) { text in textBinding(text); return text }
            if PrototypeStylePolishV2.themedBorder(fields) { need("theme_modes") }
            if PrototypeStylePolishV2.required(fields) { result.insert(PrototypeStylePolishV2.capability) }
            if fields["semantics"] != nil { need("semantics") }
            if fields["onAppear"] != nil { need("timers") }
            if fields["scrollLinked"] != nil || fields["scrollTransition"] != nil { need("scroll_motion") }
            let type = fields["type"]?.stringValue ?? ""
            if PrototypeStringConditions.uses(fields) { need("string_conditions") }
            let types = [
                "startTimer": "timers",
                "cancelTimer": "timers",
                "stack": "stack",
                "flow": "flow_grid",
                "grid": "flow_grid",
                "carousel": "carousel",
                "searchBar": "search_bar",
                "chart": "chart",
                "list": "lazy_list",
                "menu": "menus",
                "tooltip": "tooltip",
                "drawer": "drawer",
                "select": "menus",
                "scrollTo": "chat_scroll",
            ]
            if ["topAppBar", "bottomNav", "tabBar"].contains(type),
               fields["onScroll"] != nil || fields["scroll"] != nil { need("bar_scroll") }
            if let feature = types[type] { need(feature) }
            if fields["ios"] != nil || fields["android"] != nil { need("platform_namespace") }
            if fields["sharedKey"] != nil { need("shared_element") }
            let navigation = ["stack", "push", "replace"].contains(type)
            if navigation, fields["transition"] != nil { need("stack_transitions") }
            if includeAgentGates, type == "icon",
               ["rounded", "sharp", "twoTone"].contains(fields["variant"]?.stringValue ?? "") { need("icon_variant") }
            if type == "text", fields["spans"] != nil { need("rich_text") }
            if type == "text", let mode = fields["contentTransition"]?.stringValue,
               mode != "none" { need("content_transition") }
            if type == "textField" {
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
            }
            if type == "pager" {
                if fields["stateKey"] != nil { need("pager_state_key") }
                if ["axis", "pageSpacing", "peek", "pageSize"]
                    .contains(where: { fields[$0] != nil }) { need("pager_options") }
                if fields["indicator"] != nil { need("carousel") }
            }
            if type == "scroll",
               ["reverse", "stickToEnd", "atEndKey", "onStartReached"]
               .contains(where: { fields[$0] != nil }) { need("chat_scroll") }
            if type == "request" {
                need("network")
                if fields["append"] != nil { need("lazy_list") }
                if fields["via"] == .string("device") { need("network_device") }
                if let url = fields["url"]?.stringValue { textBinding(url) }
                for key in ["headers", "query"] {
                    for value in (fields[key]?.objectFields ?? [:]).values {
                        if let text = value.stringValue { textBinding(text) }
                    }
                }
            }
            if ["setData", "appendData", "prependData", "removeData"].contains(type) { need("data_actions") }
            if type == "prependData" { need("lazy_list") }
            if type == "emit", fields["context"] != nil { need("emit_context") }
            if type == "platform" { need("platform") }
            for (key, child) in fields {
                if key == "strings" { continue }
                if key == "payload" ||
                    (key == "value" && !["setData", "appendData", "prependData"].contains(type)) { continue }
                if key == "repeat" {
                    if child.objectFields?["derive"] != nil { need("format") }
                    if let repeatSpec = child.objectFields,
                       repeatSpec["items"]?
                       .objectFields != nil || repeatSpec["key"] != nil { need("data_model") }; continue
                }
                if ["checks", "validateOn", "enabledWhen", "valid", "requireValid"].contains(key) { need("checks") }
                if ["onLongPress", "onDoubleTap"].contains(key) { need("gestures") }
                if key == "swipeActions" { need("swipe_actions") }
                if key == "refresh" { need("refresh") }
                if key == "linkify" { need("linkify") }
                if key == "empty" || key == "shimmer" { need("loading_states") }
                if key == "effects" { need("effects") }
                let transitionType = child.objectFields?["type"]?.stringValue ?? child.stringValue ?? ""
                if ["animate", "scale", "rotation", "zoomable"]
                    .contains(key) ||
                    (key == "transition" && !navigation && ["slideStart", "slideEnd", "scale"].contains(transitionType))
                {
                    result.insert("prototype_motion_v2")
                }
                if key == "stagger" ||
                    (
                        key == "transition" && !navigation &&
                            (child.objectFields != nil || transitionType == "blurReplace")
                    )
                {
                    need("choreography")
                }
                if key == "style", child.objectFields?["shader"] != nil { need("custom_shaders") }
                if key == "data", child.stringValue != nil { need("data_model") }
                if key == "light" || key == "dark", !field.isEmpty { need("theme_modes") }
                // An effect's own `animate`, colours and params are not spec features of their own.
                if key == "linkify" {
                    if let actions = child.objectFields?["onTap"] { scan(actions, field: "onTap") }
                } else if !["series", "effects", "scrollLinked", "scrollTransition"]
                    .contains(key) { scan(child, field: key) }
            }
        }
        if let root = spec["root"] { scan(root) }
        if let handlers = spec["platform"] { scan(handlers) }
        if let scrim = spec["window"]?.objectFields?["placement"]?.objectFields?["scrim"],
           scrim.objectFields != nil { need("theme_modes") }
        if let requires = spec["requires"]?.objectFields {
            for module in PrototypeContractValidator
                .strings(requires["platform"]) { need("platform"); need("platform_\(module)") }
        }
        if spec["platform"] != nil { need("platform") }
        return result
    }
}
