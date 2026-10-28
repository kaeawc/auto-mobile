import Foundation

/// Transport manifests derive advisory requirements from authored feature slots, including unused
/// component definitions. Capability enforcement remains the importing app's responsibility.
enum PrototypeBundleCapabilities {
    static func required(_ data: Data) throws -> [String] {
        let value = try PrototypeBundleJSON(data, code: .specInvalidJSON, path: "spec.json").value
        guard let spec = value.objectFields else { return [] }
        var names = Set<String>()
        if spec["motion"] == .string("expressive") { names.insert(PrototypeMotionV3.capability) }
        func need(_ feature: String) { names.insert("prototype_\(feature)_v1") }
        for key in ["window", "theme"] {
            if let block = spec[key]?.objectFields,
               block["ios"] != nil || block["android"] != nil { need("platform_namespace") }
        }
        if spec["strings"] != nil { need("strings") }
        if spec["theme"]?.objectFields?["design"]?.stringValue == "platform" { need("design_platform") }
        if spec["motion"] == .string("reduced") { need("reduced_motion") }
        if spec["window"]?.objectFields?["transition"] != nil { need("window_motion") }
        if spec["data"] != nil { need("data_model") }
        if spec["derive"] != nil { need("format") }
        if spec["theme"] != nil { need("theme_modes") }
        if spec["storage"] != nil { need("storage") }
        if PrototypeContractValidator.strings(spec["storage"]?.objectFields?["keys"])
            .contains(where: { $0.hasPrefix("stack:") }) { need("routes") }
        if spec["window"]?.objectFields?["backdrop"] != nil { need("backdrop") }
        if let window = spec["window"]?.objectFields,
           ["keepScreenOn", "brightness", "orientation", "statusBar"].contains(where: { window[$0] != nil }) {
            need("platform_window_controls")
        }
        if spec["platform"] != nil || spec["requires"] != nil { need("platform") }
        if case let .array(modules) = spec["requires"]?.objectFields?["platform"] {
            for module in modules {
                if let name = module.stringValue,
                   let capability = PrototypePlatformValidator.modules[name]?.capability
                {
                    names.insert(capability)
                }
            }
        }
        if let handlers = spec["platform"] { scanSlots(handlers, names: &names) }
        if let channels = spec["channels"] {
            need("platform_realtime")
            if (channels.objectFields ?? [:]).values
                .contains(where: { $0.objectFields?["via"] == .string("device") }) { need("platform_realtime_device") }
            for channel in (channels.objectFields ?? [:]).values {
                scanSlots(channel, names: &names)
            }
        }
        var pending = [spec["root"]].compactMap { $0 }
        for component in spec["components"]?.objectFields?.values ?? [:].values {
            if let root = component.objectFields?["root"] { pending.append(root) }
        }
        while let node = pending.popLast()?.objectFields {
            names.formUnion(PrototypeGlass.capabilities(node))
            if PrototypeGlass.needsNamespace(node) { need("platform_namespace") }
            if PrototypeStylePolishV2.themedColors(node) { need("theme_modes") }
            if PrototypeStylePolishV2.required(node) { names.insert(PrototypeStylePolishV2.capability) }
            if node["semantics"] != nil { need("semantics") }
            if PrototypeStrings.textFields(.object(node))
                .contains(where: { $0.text.contains("{t:") }) { need("strings") }
            if node["repeat"]?.objectFields?["stagger"] != nil { need("window_motion") }
            if node["sharedKey"] != nil { need("shared_element") }
            if PrototypeMotionV3.required(node) { names.insert(PrototypeMotionV3.capability) }
            if PrototypeMediaItems.usedBy(node) { names.insert(PrototypeMediaItems.capability) }
            if node["shared"] != nil { names.insert("prototype_shared_element_v2") }
            let type = node["type"]?.stringValue ?? ""
            if PrototypeStringConditions.uses(node) { need("string_conditions") }
            if type == "icon", node["effect"] != nil { need("icon_effects") }
            if type == "icon",
               node["effect"]?.objectFields?["trigger"]?.objectFields?["data"] != nil { need("data_model") }
            let featureTypes = [
                "flow": "flow_grid",
                "grid": "flow_grid",
                "carousel": "carousel",
                "searchBar": "search_bar",
                "menu": "menus",
                "tooltip": "tooltip",
                "drawer": "drawer",
                "adaptive": "adaptive",
                "select": "menus",
                "stack": "stack",
                "chart": "chart",
            ]
            if ["topAppBar", "bottomNav", "tabBar"].contains(type),
               node["onScroll"] != nil || node["scroll"] != nil { need("bar_scroll") }
            if let feature = featureTypes[type] { need(feature) }
            if let repeated = node["repeat"]?.objectFields,
               repeated["items"]?.objectFields != nil || repeated["key"] != nil { need("data_model") }
            if node["repeat"]?.objectFields?["derive"] != nil { need("format") }
            if node["span"] != nil { need("flow_grid") }
            if node["onLongPress"] != nil || node["onDoubleTap"] != nil { need("gestures") }
            if node["swipeActions"] != nil { need("swipe_actions") }
            if node["refresh"] != nil { need("refresh") }
            if type == "text", node["spans"] != nil { need("rich_text") }
            if type == "text", let mode = node["contentTransition"]?.stringValue,
               mode != "none" { need("content_transition") }
            if node["linkify"] != nil { need("linkify") }
            if type == "scroll", ["reverse", "stickToEnd", "atEndKey", "onStartReached"]
                .contains(where: { node[$0] != nil }) { need("chat_scroll") }
            if ["checks", "enabledWhen", "validateOn"].contains(where: { node[$0] != nil }) { need("checks") }
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
                ]
                .contains(where: { node[$0] != nil }) { need("text_field_options") }
                if ["trailingIcon", "imeAction", "onSubmit"]
                    .contains(where: { node[$0] != nil }) { need("text_field_actions") }
                if node["leadingIcon"] != nil { need("text_field_leading_icon") }
            }
            if type == "pager" {
                if node["stateKey"] != nil { need("pager_state_key") }
                if ["axis", "pageSpacing", "peek", "pageSize"]
                    .contains(where: { node[$0] != nil }) { need("pager_options") }
                if node["indicator"] != nil { need("carousel") }
            }
            if type == "stack", node["transition"] != nil { need("stack_transitions") }
            if type == "stack",
               ["sharedAxisX", "sharedAxisY", "fadeThrough", "zoom"]
               .contains(node["transition"]?.stringValue ?? "") { need("stack_patterns") }
            let transition = type == "stack" ? nil : node["transition"]
            let transitionType = transition?.objectFields?["type"]?.stringValue
                ?? transition?.stringValue ?? ""
            if node["animate"] != nil || (type == "image" && node["zoomable"] != nil) ||
                ["slideStart", "slideEnd", "scale"].contains(transitionType)
            {
                names.insert("prototype_motion_v2")
            }
            if node["stagger"] != nil || transition?.objectFields != nil || transitionType == "blurReplace" {
                names.insert("prototype_choreography_v1")
            }
            scanSlots(.object(node), names: &names)
            if case let .array(children) = node["children"] { pending += children }
            if let child = node["child"] { pending.append(child) }
            if type == "adaptive" { pending += PrototypeAdaptive.slots.compactMap { node[$0] } }
            pending += Array(node["screens"]?.objectFields?.values ?? [:].values)
        }
        return names.sorted()
    }

    private static func scanSlots(_ value: JSONValue, names: inout Set<String>) {
        if case let .array(items) = value { for item in items {
            scanSlots(item, names: &names)
        }; return }
        guard let fields = value.objectFields else { return }
        if fields["onAppear"] != nil { names.insert("prototype_timers_v1") }
        let type = fields["type"]?.stringValue
        if (type == "stack" && fields["routes"] != nil) ||
            (["push", "replace"].contains(type ?? "") && fields["params"] != nil) ||
            (type == "pop" && fields["force"] != nil) || type == "setStack" { names.insert("prototype_routes_v1") }
        if type == "startTimer" || type == "cancelTimer" { names.insert("prototype_timers_v1") }
        if type == "request" {
            for part in PrototypeStrictBindings.array(fields["body"]?.objectFields?["multipart"]) {
                if let binding = part.objectFields?["value"] { scanSlots(binding, names: &names) }
            }
            names.insert("prototype_network_v1")
            if fields["progressKey"] != nil || fields["body"]?.objectFields?.keys
                .contains(where: { ["multipart", "form", "file"].contains($0) }) ==
                true { names.insert("prototype_network_upload_v1") }
            if fields["via"]?.stringValue == "device" { names.insert("prototype_network_device_v1") }
        }
        if ["setData", "appendData", "prependData", "upsertData", "removeData"]
            .contains(type ?? "") { names.insert("prototype_data_actions_v1") }
        if type == "upsertData" ||
            (type == "appendData" && fields["maxItems"] != nil) || PrototypeChannels
            .needsValueCapability(fields) { names.insert("prototype_platform_realtime_v1") }
        if type == "prependData" { names.insert("prototype_lazy_list_v1") }
        if type == "emit", fields["context"] != nil { names.insert("prototype_emit_context_v1") }
        if type == "requireValid" { names.insert("prototype_checks_v1") }
        if type == "scrollTo" { names.insert("prototype_chat_scroll_v1") }
        if type == "hideKeyboard" { names.insert("prototype_hide_keyboard_v1") }
        if ["push", "replace"].contains(type ?? ""), fields["transition"] != nil {
            names.insert("prototype_stack_transitions_v1")
        }
        if ["push", "replace"].contains(type ?? ""),
           fields["source"] != nil || ["sharedAxisX", "sharedAxisY", "fadeThrough", "zoom"]
           .contains(fields["transition"]?.stringValue ?? "")
        {
            names.insert("prototype_stack_patterns_v1")
        }
        if type == nil, fields["data"]?.stringValue != nil { names.insert("prototype_data_model_v1") }
        if type == nil, let pointer = fields["platform"]?.stringValue {
            names.insert("prototype_platform_v1")
            if let module = PrototypeDataPointer.tokens(pointer).first,
               let capability = PrototypePlatformValidator.modules[module]?.capability { names.insert(capability) }
        }
        if type == "pasteButton" {
            names.insert("prototype_platform_v1")
            names.insert("prototype_platform_clipboard_v1")
        }
        if type == "platform", let method = fields["call"]?.stringValue {
            names.insert("prototype_platform_v1")
            if let module = method.split(separator: ".").first,
               let capability = PrototypePlatformValidator.modules[String(module)]?
               .capability { names.insert(capability) }
        }
        for (key, child) in fields where ![
            "ios",
            "android",
            "child",
            "children",
            "screens",
            "payload",
            "repeat",
            "data",
            "value"
        ].contains(key) {
            if ["checks", "validateOn", "enabledWhen", "valid", "requireValid"]
                .contains(key) { names.insert("prototype_checks_v1") }
            if ["empty", "shimmer"].contains(key) { names.insert("prototype_loading_states_v1") }
            if key == "style", let style = child.objectFields, style["scale"] != nil || style["rotation"] != nil {
                names.insert("prototype_motion_v2")
            }
            if key == "animate", child.objectFields?["tempo"] != nil { names.insert("prototype_motion_tokens_v1") }
            if key == "keyframes" { names.insert("prototype_keyframes_v1"); continue }
            if key == "style", child.objectFields?["shader"] != nil { names.insert("prototype_custom_shaders_v1") }
            if key == "style", child.objectFields?["effects"] != nil { names.insert("prototype_effects_v1") }
            if key == "style", child.objectFields?["runSpacing"] != nil { names.insert("prototype_flow_grid_v1") }
            let textKeys = [
                "text",
                "label",
                "title",
                "placeholder",
                "headline",
                "supporting",
                "supportingText",
                "errorText",
                "trailingText",
                "message",
                "hint",
                "url",
            ]
            if textKeys.contains(key), let text = child.stringValue {
                if PrototypeDataText.substitutionLength(text, data: nil)
                    .recognized { names.insert("prototype_data_model_v1") }
                for pointer in PrototypePlatformValidator.placeholders(text) {
                    names.insert("prototype_platform_v1")
                    if let module = PrototypeDataPointer.tokens(pointer).first,
                       let capability = PrototypePlatformValidator.modules[module]?
                       .capability { names.insert(capability) }
                }
            }
            scanSlots(child, names: &names)
        }
    }
}
