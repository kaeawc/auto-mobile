import Foundation

// Device-free semantics of the Material 3 component nodes (#10439), mirroring Android's
// `OverlayComponents.kt`, `OverlaySelectionComponents.kt`, `OverlayMaterialComponents.kt` and the
// matching `OverlayRuntime` interactions. The SwiftUI views only draw; what a tap does lives here,
// so the renderer and the `simulate_tap` test hook share one implementation.

/// Node types drawn above the whole author tree while their `openWhen` holds, never inline.
let overlayModalTypes: Set<String> = ["dialog", "snackbar"]

extension OverlayNode {
    /// The accessibility identifier: `testTag`, else `id`.
    var identifier: String? {
        testTag ?? id
    }

    /// The identifier of a part of a composite node: the node's identifier, a dot, then the part
    /// (`confirm`, `dismiss`, `action`, `navigation`, `actions.<index>`, or an option value).
    func partIdentifier(_ part: String) -> String? {
        identifier.map { "\($0).\(part)" }
    }

    /// The boolean key a tap on this node flips: a `switch`, a `checkbox`, a filter `chip` (one
    /// with a `stateKey`) or a `listItem` with a trailing switch or checkbox. Nil otherwise.
    var toggleKey: String? {
        switch type {
        case "switch", "checkbox", "chip": stateKey
        case "listItem": ["switch", "checkbox"].contains(trailing?.type) ? trailing?.stateKey : nil
        default: nil
        }
    }

    /// The `{key, equals}` boolean condition that opens a `dialog`, `snackbar` or `bottomSheet`.
    var openCondition: (key: String, equals: Bool)? {
        guard case let .equals(key, .bool(equals))? = openWhen else { return nil }
        return (key, equals)
    }

    /// Open dialogs and snackbars in tree order, as Android's `modalOverlaySheets`: hidden subtrees
    /// and closed modals are skipped, a pager contributes only its current page, and an open
    /// modal's own content is searched too.
    func openModals(state: [String: JSONValue], pages: [String: Int]) -> [OverlayNode] {
        if let visibleWhen, !visibleWhen.holds(state) { return [] }
        let modal = overlayModalTypes.contains(type)
        if modal, !(openWhen?.holds(state) ?? false) { return [] }
        var nested = children ?? []
        if type == "pager" {
            let page = id.flatMap { pages[$0] } ?? 0
            nested = nested.indices.contains(page) ? [nested[page]] : []
        }
        if let child { nested.append(child) }
        return (modal ? [self] : []) + nested.flatMap { $0.openModals(state: state, pages: pages) }
    }

    /// The node or composite part whose identifier is `identifier`, depth-first in tree order.
    /// Parts of a closed dialog or snackbar are not on screen, so they never match.
    func tapTarget(identifier wanted: String, state: [String: JSONValue]) -> OverlayTapTarget? {
        if identifier == wanted { return .node(self) }
        if let part = part(named: wanted, state: state) { return part }
        for node in (children ?? []) + [child].compactMap({ $0 }) {
            if let match = node.tapTarget(identifier: wanted, state: state) { return match }
        }
        return nil
    }

    private func part(named wanted: String, state: [String: JSONValue]) -> OverlayTapTarget? {
        guard let identifier, wanted.hasPrefix(identifier + ".") else { return nil }
        let name = String(wanted.dropFirst(identifier.count + 1))
        switch type {
        case "dialog", "snackbar":
            guard openWhen?.holds(state) ?? false else { return nil }
            return modalButton(named: name).map { .modalButton(self, $0) }
        case "topAppBar":
            return appBarButton(named: name).map { .appBarButton($0) }
        case "radioGroup", "segmentedButton":
            return options?.first { $0.value == name }.map { .option(self, $0) }
        default:
            return nil
        }
    }

    /// A dialog's `confirm`/`dismiss` or a snackbar's `action`.
    private func modalButton(named name: String) -> OverlayDialogButton? {
        switch (type, name) {
        case ("dialog", "confirm"): confirm
        case ("dialog", "dismiss"): dismiss
        case ("snackbar", "action"): action
        default: nil
        }
    }

    /// `navigation`, or `actions.<index>`.
    private func appBarButton(named name: String) -> OverlayAppBarAction? {
        if name == "navigation" { return navigationIcon }
        guard name.hasPrefix("actions."), let index = Int(name.dropFirst("actions.".count)),
              let actions, actions.indices.contains(index) else { return nil }
        return actions[index]
    }
}

/// What a tap lands on: a node's own target, or one part of a composite node.
enum OverlayTapTarget {
    case node(OverlayNode)
    /// A `dialog` confirm/dismiss button or the `snackbar` action.
    case modalButton(OverlayNode, OverlayDialogButton)
    /// A `topAppBar` navigation icon or action.
    case appBarButton(OverlayAppBarAction)
    /// One `radioGroup` or `segmentedButton` option.
    case option(OverlayNode, OverlayOption)
}

extension OverlaySession {
    /// A tap on `target`, as the matching Android control handles its click. Nil when the target
    /// has nothing to do (a plain node without `onTap`, an app-bar button without actions).
    mutating func activate(_ target: OverlayTapTarget) -> [OverlayEvent]? {
        switch target {
        case let .node(node):
            if let key = node.toggleKey { return toggle(key: key, then: node.onTap ?? []) }
            guard let actions = node.onTap, !actions.isEmpty else { return nil }
            return run(actions)
        case let .modalButton(node, button):
            return closeModal(node, then: button.onTap ?? [])
        case let .appBarButton(button):
            guard let actions = button.onTap, !actions.isEmpty else { return nil }
            return run(actions)
        case let .option(node, option):
            guard let key = node.stateKey else { return nil }
            return choose(key: key, value: option.value, then: node.onTap ?? [])
        }
    }

    /// A `radioGroup`/`segmentedButton` option or `datePicker` day: binds the string key, emits
    /// `change` when it moved, then runs the node's actions. A non-string key leaves it inert.
    mutating func choose(key: String, value: String, then actions: [OverlayAction]) -> [OverlayEvent] {
        guard isShown, case .string? = state[key] else { return [] }
        return change(key: key, value: .string(value)) + run(actions)
    }

    /// A `slider` drag: stores the already-snapped number, then runs the node's actions. An
    /// unchanged value, or a key that no longer holds a number, does nothing.
    mutating func slide(key: String, value: Double, then actions: [OverlayAction]) -> [OverlayEvent] {
        guard isShown, case let .number(stored)? = state[key], stored != value else { return [] }
        return change(key: key, value: .number(value)) + run(actions)
    }

    /// A `timePicker` change: both keys are stored together and reported by one `change` event
    /// (`{key, value}` when only one moved), then the node's actions run. Unchanged or non-numeric
    /// keys do nothing.
    mutating func setTime(
        hourKey: String,
        minuteKey: String,
        hour: Int,
        minute: Int,
        then actions: [OverlayAction]
    )
        -> [OverlayEvent]
    {
        guard isShown, state[hourKey]?.numberValue != nil, state[minuteKey]?.numberValue != nil else { return [] }
        let next: [(String, JSONValue)] = [(hourKey, .number(Double(hour))), (minuteKey, .number(Double(minute)))]
        let moved = next.filter { state[$0.0] != $0.1 }
        guard !moved.isEmpty else { return [] }
        return setStates(moved) + run(actions)
    }

    /// A `dialog` or `snackbar` button, or the dialog scrim: closes the modal by writing the
    /// opposite of `openWhen.equals` (emitting `change`), then runs the button's actions.
    mutating func closeModal(_ node: OverlayNode, then actions: [OverlayAction] = []) -> [OverlayEvent] {
        guard isShown else { return [] }
        var events: [OverlayEvent] = []
        if let (key, equals) = node.openCondition, state[key] == .bool(equals) {
            events = change(key: key, value: .bool(!equals))
        }
        return events + run(actions)
    }
}

// MARK: Value helpers

/// The step-aligned, in-range value a slider drag lands on, rounded to micro-units, as Android's
/// `snapOverlaySlider` (whose `Math.round` rounds halves up).
func snapOverlaySlider(_ raw: Double, min lower: Double, max upper: Double, step: Double?) -> Double {
    let clamped = Swift.min(Swift.max(raw, lower), upper)
    guard let step, step > 0 else { return clamped }
    let snapped = lower + roundHalfUp((clamped - lower) / step) * step
    return Swift.min(Swift.max(roundHalfUp(snapped * 1e6) / 1e6, lower), upper)
}

private func roundHalfUp(_ value: Double) -> Double {
    (value + 0.5).rounded(.down)
}

/// The drawn fraction of a determinate `progress`: the bound value over `max` (default 1).
func overlayProgressFraction(_ value: Double, max: Double?) -> Double {
    let fraction = value / (max ?? 1)
    return fraction.isFinite ? Swift.min(Swift.max(fraction, 0), 1) : 0
}

/// `datePicker` values are `YYYY-MM-DD` strings; the picker works in UTC midnights, as Android's.
enum OverlayDate {
    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }()

    /// UTC midnight of a real `YYYY-MM-DD` date; nil for anything else (including `2026-02-30`).
    static func date(from text: String) -> Date? {
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else { return nil }
        let components = DateComponents(year: year, month: month, day: day)
        guard let date = calendar.date(from: components), string(from: date) == text else { return nil }
        return date
    }

    /// The `YYYY-MM-DD` day of `date` in UTC.
    static func string(from date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// The range Android's validator accepts for a bound date.
    static let range: ClosedRange<Date> = {
        let lower = calendar.date(from: DateComponents(year: 1900, month: 1, day: 1)) ?? .distantPast
        let upper = calendar.date(from: DateComponents(year: 2100, month: 12, day: 31)) ?? .distantFuture
        return lower ... upper
    }()
}

/// `timePicker` hours and minutes as a UTC date on a fixed day, so a picker showing UTC reads them
/// back unchanged on any device time zone.
enum OverlayTime {
    static func date(hour: Int, minute: Int) -> Date {
        OverlayDate.calendar.date(from: DateComponents(year: 2000, month: 1, day: 1, hour: hour, minute: minute))
            ?? Date(timeIntervalSince1970: 0)
    }

    static func components(of date: Date) -> (hour: Int, minute: Int) {
        let parts = OverlayDate.calendar.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0, parts.minute ?? 0)
    }

    /// The accessibility value Android reports: `07:30`, 24-hour.
    static func label(hour: Int, minute: Int) -> String {
        String(format: "%02d:%02d", hour, minute)
    }

    /// The 12-hour clock face (1...12) of a 24-hour `hour`.
    static func hour12(of hour: Int) -> Int {
        let h = hour % 12
        return h == 0 ? 12 : h
    }

    static func isPM(hour: Int) -> Bool { hour % 24 >= 12 }

    /// The 24-hour `hour` for a 12-hour face and meridiem.
    static func hour24(hour12: Int, pm: Bool) -> Int {
        (hour12 % 12) + (pm ? 12 : 0)
    }

    /// Accessibility labels of the wheels, naming what each one sets as Android's picker does.
    static let hourLabel = "Hour"
    static let minuteLabel = "Minute"
    static let meridiemLabel = "AM/PM"
}

/// One accessibility element of an open dialog, in reading order. The icon is decorative and never
/// listed. Each part is its own element, as on Android, so `tapOn` can find a button by its label.
enum OverlayDialogPart: Equatable {
    /// The title, exposed as a header.
    case title(String)
    /// The body text.
    case text(String)
    /// The dialog's `child` subtree (pickers, fields), whose nodes expose themselves.
    case content
    /// The `dismiss` or `confirm` button, identified `<tag>.dismiss` / `<tag>.confirm`.
    case button(part: String, label: String, identifier: String?)
}

extension OverlayNode {
    /// The parts a dialog exposes for an already interpolated `title` and `text`: empty title or
    /// text are not drawn, so they are not listed.
    func dialogParts(title: String, text: String?) -> [OverlayDialogPart] {
        var parts: [OverlayDialogPart] = []
        if !title.isEmpty { parts.append(.title(title)) }
        if let text, !text.isEmpty { parts.append(.text(text)) }
        if child != nil { parts.append(.content) }
        if let dismiss { parts.append(.button(
            part: "dismiss",
            label: dismiss.label,
            identifier: partIdentifier("dismiss")
        )) }
        if let confirm { parts.append(.button(
            part: "confirm",
            label: confirm.label,
            identifier: partIdentifier("confirm")
        )) }
        return parts
    }
}
