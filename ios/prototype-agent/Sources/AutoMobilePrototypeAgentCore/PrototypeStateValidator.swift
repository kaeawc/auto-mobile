import Foundation

/// The binding rules Android re-checks after every state write, ported one for one from
/// `PrototypeSpecValidator` (`bindingErrors`, `listItemBindingErrors`, `sheetBindingErrors`,
/// `stateActionErrors`), which `PrototypeRuntime.validated` runs on the whole spec with the written
/// state (#11408). A write that leaves any control or state action invalid is rejected, and
/// `PrototypeSession` then drops the whole interaction.
///
/// `repeat` templates are already expanded in the Swift node tree, so each instance is checked as
/// Android's `keyInstances` does. Two Android checks cannot be affected by a state write and are
/// left out: the `setState` value-versus-control check (it reads only the action's own literal and
/// the controls' declared fields, never the stored state) and the spec byte cap (the agent keeps no
/// raw bytes). The static slider, chip, fab, progress and radio rules are kept: they live in the
/// same Android functions and cost nothing.
enum PrototypeStateValidator {
    /// The first rule `root` breaks when it holds `state`, or nil when the state is valid.
    /// `nonStateBytes` is the size of the shown spec outside its `state` (`PrototypeSession` measures it
    /// at show); the spec byte cap is checked first, as Android's `validate` does.
    static func rejection(root: PrototypeNode, state: [String: JSONValue], nonStateBytes: Int = 0) -> String? {
        if nonStateBytes + stateBytes(state) > PrototypeLimits.maxSpecBytes { return "Spec byte limit exceeded" }
        var nodes: [PrototypeNode] = []
        var actions: [PrototypeAction] = []
        collect(root, nodes: &nodes, actions: &actions)
        for node in nodes {
            if let message = bindingError(node, state) { return message }
        }
        for node in nodes {
            if let message = trailingError(node, state) { return message }
        }
        for node in nodes {
            if let message = openWhenError(node, state) { return message }
        }
        for node in nodes {
            if let message = refreshError(node, state) { return message }
        }
        for action in actions {
            if let message = stateActionError(action, state) { return message }
        }
        return nil
    }

    // MARK: Spec size

    /// The UTF-8 size of `state` as JSON. Android caps the re-encoded whole spec, but the agent keeps
    /// no raw spec bytes, so the cap is applied as `nonStateBytes` (measured once at show from the
    /// request's own spec) plus this. Swift's encoder and kotlinx differ by a few bytes (number
    /// spelling, default fields), so a state within a few bytes of the cap can differ per platform.
    static func stateBytes(_ state: [String: JSONValue]) -> Int {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        // A state that cannot be encoded (a non-finite number) cannot be sent back to the host either, so it counts as
        // over the cap.
        return (try? encoder.encode(JSONValue.object(state)).count) ?? PrototypeLimits.maxSpecBytes + 1
    }

    // MARK: Traversal

    private static func collect(_ node: PrototypeNode, nodes: inout [PrototypeNode], actions: inout [PrototypeAction]) {
        nodes.append(node)
        actions += node.onTap ?? []
        actions += node.onLongPress ?? []
        actions += node.onDoubleTap ?? []
        actions += node.onSubmit ?? []
        actions += node.trailingIcon?.onTap ?? []
        actions += node.refresh?.onRefresh ?? []
        actions += (node.trailingActions ?? []).flatMap { $0.onTap ?? [] }
        actions += (node.spans ?? []).flatMap { $0.onTap ?? [] }
        actions += node.navigationIcon?.onTap ?? []
        actions += (node.actions ?? []).flatMap { $0.onTap ?? [] }
        actions += node.confirm?.onTap ?? []
        actions += node.dismiss?.onTap ?? []
        actions += node.action?.onTap ?? []
        actions += (node.menuItems ?? []).flatMap { $0.entry?.onTap ?? [] }
        node.children?.forEach { collect($0, nodes: &nodes, actions: &actions) }
        if let child = node.child { collect(child, nodes: &nodes, actions: &actions) }
        node.screens?.values.forEach { collect($0, nodes: &nodes, actions: &actions) }
    }

    // MARK: Binding rules

    private static func bindingError(_ node: PrototypeNode, _ state: [String: JSONValue]) -> String? {
        if let message = componentError(node, state) { return message }
        guard let key = node.stateKey else {
            return node.type == "searchBar" ? "Text field requires a string state key" : nil
        }
        let stored = state[key]
        switch node.type {
        case "textField", "searchBar":
            if stored?.stringValue == nil { return "Text field requires a string state key" }
            if node.type == "searchBar", let activeKey = node.activeKey, state[activeKey]?.boolValue == nil {
                return "Search bar requires a boolean active key"
            }
            return nil
        case "switch", "checkbox":
            return stored?.boolValue == nil ? "Toggle control requires a boolean state key" : nil
        case "radioGroup", "segmentedButton", "select":
            return radioGroupError(node, stored)
        case "tabBar", "bottomNav":
            guard let number = stored?.numberValue, number.isFinite, number >= 0,
                  number.truncatingRemainder(dividingBy: 1) == 0
            else { return "Selection requires a nonnegative integer state key" }
            return nil
        default:
            return nil
        }
    }

    private static func componentError(_ node: PrototypeNode, _ state: [String: JSONValue]) -> String? {
        let stored = node.stateKey.flatMap { state[$0] }
        switch node.type {
        case "slider": return sliderError(node, stored)
        case "chip": return chipError(node, stored)
        case "fab":
            return node.label != nil && node.size != nil ? "Extended FAB cannot set size" : nil
        case "progress": return progressError(node, stored)
        case "timePicker": return timePickerError(node, state)
        case "datePicker":
            return isDate(stored?.stringValue) ? nil : "Date picker requires a YYYY-MM-DD state key in 1900..2100"
        default: return nil
        }
    }

    private static func sliderError(_ node: PrototypeNode, _ stored: JSONValue?) -> String? {
        guard let min = node.min, let max = node.max, min < max else { return "Slider max must be greater than min" }
        if let step = node.step, !stepFitsRange(step, max - min) {
            return "Slider step must be positive and divide the range evenly"
        }
        guard let number = stored?.numberValue, number.isFinite, number >= min, number <= max else {
            return "Slider requires a numeric state key within min and max"
        }
        return nil
    }

    private static func stepFitsRange(_ step: Double, _ range: Double) -> Bool {
        let count = range / step
        return step > 0 && count >= 1 && abs(count - (count + 0.5).rounded(.down)) < 1e-9
    }

    private static func chipError(_ node: PrototypeNode, _ stored: JSONValue?) -> String? {
        let bound = node.stateKey != nil
        if node.variant == "filter", !bound { return "Filter chip requires a boolean state key" }
        if let variant = node.variant, variant != "filter", bound { return "Only a filter chip can bind a state key" }
        if bound, stored?.boolValue == nil { return "Filter chip requires a boolean state key" }
        return nil
    }

    /// A bound progress indicator is determinate over 0..max (default 1); unbound is indeterminate.
    private static func progressError(_ node: PrototypeNode, _ stored: JSONValue?) -> String? {
        guard node.stateKey != nil else { return node.max != nil ? "Requires stateKey" : nil }
        let max = node.max ?? 1
        if max <= 0 { return "Progress max must be greater than 0" }
        guard let number = stored?.numberValue, number.isFinite, number >= 0, number <= max else {
            return "Progress requires a numeric state key within 0 and max"
        }
        return nil
    }

    /// A time picker binds two distinct integer keys: hour 0..23 and minute 0..59.
    private static func timePickerError(_ node: PrototypeNode, _ state: [String: JSONValue]) -> String? {
        for (key, upper, unit) in [(node.hourKey, 23.0, "hour"), (node.minuteKey, 59.0, "minute")] {
            guard let number = key.flatMap({ state[$0] })?.numberValue,
                  number.truncatingRemainder(dividingBy: 1) == 0, number >= 0, number <= upper
            else { return "Time picker \(unit) requires an integer 0..\(Int(upper)) state key" }
        }
        return node.hourKey == node.minuteKey ? "Time picker hour and minute keys must differ" : nil
    }

    private static func radioGroupError(_ node: PrototypeNode, _ stored: JSONValue?) -> String? {
        let name = node.type == "select" ? "Select" : node
            .type == "segmentedButton" ? "Segmented button" : "Radio group"
        guard stored?.stringValue != nil else { return "\(name) requires a string state key" }
        var values = Set<String>()
        var selectValues = Set<[UInt16]>()
        for option in node.options ?? [] {
            let inserted = node.type == "select"
                ? selectValues.insert(Array(option.value.utf16)).inserted
                : values.insert(option.value).inserted
            if !inserted {
                return node.type == "select" ? "Duplicate select option value" : "Duplicate radio option value"
            }
        }
        return nil
    }

    /// A `YYYY-MM-DD` calendar date in 1900..2100, the Material date picker's year range.
    private static func isDate(_ text: String?) -> Bool {
        guard let text else { return false }
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].utf8.count == 4, parts[1].utf8.count == 2, parts[2].utf8.count == 2,
              parts.allSatisfy({ $0.utf8.allSatisfy { (0x30 ... 0x39).contains($0) } }),
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1900 ... 2100).contains(year), (1 ... 12).contains(month)
        else { return false }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return (1 ... days[month - 1]).contains(day)
    }

    // MARK: Other bound keys

    /// A list item's trailing switch or checkbox binds a boolean, like the standalone controls.
    private static func trailingError(_ node: PrototypeNode, _ state: [String: JSONValue]) -> String? {
        guard node.type == "listItem", let key = node.trailing?.stateKey else { return nil }
        return state[key]?.boolValue == nil ? "Toggle control requires a boolean state key" : nil
    }

    /// Nodes opened by a boolean `openWhen` key; an existing key must hold a boolean.
    private static func openWhenError(_ node: PrototypeNode, _ state: [String: JSONValue]) -> String? {
        let names = ["bottomSheet": "Sheet", "dialog": "Dialog", "snackbar": "Snackbar", "menu": "Menu"]
        guard let name = names[node.type], let key = node.openWhen?.key, let stored = state[key] else { return nil }
        return stored.boolValue == nil ? "\(name) requires a boolean state key" : nil
    }

    /// Pull-to-refresh binds a boolean key, like the other controls.
    private static func refreshError(_ node: PrototypeNode, _ state: [String: JSONValue]) -> String? {
        guard node.type == "scroll", let key = node.refresh?.stateKey, let stored = state[key] else { return nil }
        return stored.boolValue == nil ? "Refresh requires a boolean state key" : nil
    }

    // MARK: State actions

    /// `toggle`, `increment` and `decrement` actions in the spec need their key to keep its type.
    private static func stateActionError(_ action: PrototypeAction, _ state: [String: JSONValue]) -> String? {
        guard let key = action.key else { return nil }
        let stored = state[key]
        switch action.type {
        case "toggle":
            return stored?.boolValue == nil ? "Toggle requires a boolean state key" : nil
        case "increment":
            return stored?.numberValue?.isFinite == true ? nil : "Increment requires a numeric state key"
        case "decrement":
            return stored?.numberValue?.isFinite == true ? nil : "Decrement requires a numeric state key"
        default:
            return nil
        }
    }
}

extension Condition {
    /// The `key` of a `{key, equals | notEquals | gt | lt}` condition; the grouping forms have none.
    var key: String? {
        switch self {
        case let .equals(key, _), let .notEquals(key, _), let .greaterThan(key, _), let .lessThan(key, _): key
        case .all, .any, .not, .valid: nil
        }
    }
}
