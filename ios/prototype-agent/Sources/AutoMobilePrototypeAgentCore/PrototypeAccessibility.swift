import Foundation

/// A pager's current page, for the `{page}`/`{pageCount}` placeholders inside it.
struct PagerPosition: Equatable {
    let page: Int
    let count: Int
}

/// Fills `{key}` state placeholders (and `{page}`/`{pageCount}` inside a pager) the way
/// Android's `interpolatePrototypeText` does: one left-to-right scan over `{token}` placeholders
/// whose key is `[A-Za-z_][A-Za-z0-9_]*`. A substituted value is never scanned again, an unknown
/// placeholder stays as written, and `{page}`/`{pageCount}` resolve only inside a pager (they stay
/// literal outside one even when state has keys of those names). Unicode scalars are scanned, so a
/// brace followed by a combining mark is not mistaken for part of a token.
///
/// Values inserted by earlier passes (data, platform and row values) carry `PrototypeTextShield`'s
/// mark, so they stay literal here; this pass removes it from the text around its placeholders (#18628).
func interpolatePrototypeText(
    _ text: String,
    state: [String: JSONValue],
    pager: PagerPosition?,
    derived: PrototypeDerivedContext? = nil,
    derivedOnly: Bool = false
)
    -> String
{
    let scalars = Array(text.unicodeScalars)
    var out = String.UnicodeScalarView()
    var index = 0
    var literalStart = 0
    var substitutedLength = 0
    while index < scalars.count {
        guard let end = interpolationTokenEnd(scalars, from: index) else {
            index += 1
            continue
        }
        PrototypeTextShield.appendUnshielded(scalars[literalStart ..< index], to: &out)
        let key = String(String.UnicodeScalarView(scalars[(index + 1) ..< (end - 1)]))
        let token = String(String.UnicodeScalarView(scalars[index ..< end]))
        let value: String?
        if key.hasPrefix("derived:") {
            value = derived?.resolve(String(key.dropFirst(8)), state: state)
        } else { value = derivedOnly ? nil : resolveInterpolation(key: key, state: state, pager: pager) }
        if let value, value.utf16.count <= PrototypeLimits.maxSubstitutedTextLength - substitutedLength {
            substitutedLength += value.utf16.count
            out.append(contentsOf: value.unicodeScalars)
        } else {
            out.append(contentsOf: token.unicodeScalars)
        }
        index = end
        literalStart = end
    }
    PrototypeTextShield.appendUnshielded(scalars[literalStart...], to: &out)
    return String(out)
}

/// The index just past the `{key}` token starting at `start`, or nil when none starts there.
private func interpolationTokenEnd(_ scalars: [Unicode.Scalar], from start: Int) -> Int? {
    guard scalars[start] == "{", start + 1 < scalars.count, isInterpolationKeyStart(scalars[start + 1]) else {
        return nil
    }
    var first = start + 1
    let prefix = Array("derived:".unicodeScalars)
    if scalars[first...].starts(with: prefix) { first += prefix.count }
    guard first < scalars.count, isInterpolationKeyStart(scalars[first]) else { return nil }
    var index = first + 1
    while index < scalars.count, isInterpolationKeyPart(scalars[index]) {
        index += 1
    }
    return index < scalars.count && scalars[index] == "}" ? index + 1 : nil
}

private func isInterpolationKeyStart(_ scalar: Unicode.Scalar) -> Bool {
    ("A" ... "Z").contains(scalar) || ("a" ... "z").contains(scalar) || scalar == "_"
}

private func isInterpolationKeyPart(_ scalar: Unicode.Scalar) -> Bool {
    isInterpolationKeyStart(scalar) || ("0" ... "9").contains(scalar)
}

private func resolveInterpolation(
    key: String,
    state: [String: JSONValue],
    pager: PagerPosition?
)
    -> String?
{
    if key == "page" || key == "pageCount" {
        guard let pager else { return nil }
        return key == "page" ? String(pager.page + 1) : String(pager.count)
    }
    return state[key]?.displayString
}

extension PrototypeNode {
    func announcementText(state: [String: JSONValue], pager: PagerPosition?) -> String {
        if let label = semantics?.label ?? contentDescription {
            return interpolatePrototypeText(label, state: state, pager: pager)
        }
        let authored = [label, title, headline, supporting, supportingText].compactMap { $0 }
            .map { interpolatePrototypeText($0, state: state, pager: pager) }
        // A button's or fab's plain text is its derived-only label; the fully resolved label is in `authored`.
        let shown = type == "button" || type == "fab" ? [] : [plainText(state: state, pager: pager)]
        let own = (shown + authored)
            .filter { !$0.isEmpty }.joined(separator: " ")
        let descendants = (children ?? []) + [child].compactMap { $0 }
        return ([own] + descendants.map { $0.announcementText(state: state, pager: pager) })
            .filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// The accessible label for this node, in Android's priority order (contentDescription, text,
    /// icon, node kind); `iconButton` and `fab` fall back to an extended FAB's label, then the icon. Placeholders are
    /// resolved in each. Nil means "let the native control
    /// name itself": SwiftUI controls and containers are not labelled by their kind (the Android
    /// kind fallback exists only because Compose layouts have no native name), and a decorative
    /// icon has no name until it is tappable.
    func accessibilityLabel(
        state: [String: JSONValue],
        pager: PagerPosition?,
        tappable: Bool,
        derived: PrototypeDerivedContext? = nil
    )
        -> String?
    {
        let authored = (semantics?.label ?? contentDescription).map {
            interpolatePrototypeText($0, state: state, pager: pager, derived: derived)
        }
        if let authored, !authored.isEmpty { return authored }
        let shown = plainText(state: state, pager: pager, derived: derived)
        if !shown.isEmpty { return shown }
        if type == "icon", tappable, let name, !name.isEmpty { return name }
        // Icon-only controls (#10439): an extended FAB's label, else the icon name.
        if type == "iconButton" || type == "fab" {
            return [label.map(PrototypeTextShield.unshield), icon].compactMap(\.self).first { !$0.isEmpty }
        }
        return nil
    }
}

/// Keeps an inserted value literal through every later placeholder scan (#18628), like Android's
/// `PrototypeTextShield`. Data, platform and row values are inserted into authored text before later
/// passes read that text for `{key}`, `{derived:name}`, `{data:/pointer}`, string and row
/// placeholders. `shield` puts U+2060 WORD JOINER right after each `{` in the value that opens a key,
/// so no scanner matches it. `interpolatePrototypeText` removes it from the fields it draws, and
/// `unshieldDrawnFields` from the fields components read as written. The joiner is zero-width.
///
/// A `{` already followed by joiners before a key gets one more, and `unshield` removes exactly one,
/// so every inserted value round-trips exactly.
enum PrototypeTextShield {
    static let mark: Unicode.Scalar = "\u{2060}"

    static func shield(_ value: String) -> String {
        guard value.unicodeScalars.contains("{") else { return value }
        let scalars = Array(value.unicodeScalars)
        var out = String.UnicodeScalarView()
        for (index, scalar) in scalars.enumerated() {
            out.append(scalar)
            if scalar == "{", opensAfterMarks(scalars[...], from: index + 1) { out.append(mark) }
        }
        return String(out)
    }

    static func unshield(_ text: String) -> String {
        guard text.unicodeScalars.contains(mark) else { return text }
        var out = String.UnicodeScalarView()
        appendUnshielded(Array(text.unicodeScalars)[...], to: &out)
        return String(out)
    }

    /// Appends `scalars` to `out`, removing one joiner after each shielded `{`.
    static func appendUnshielded(_ scalars: ArraySlice<Unicode.Scalar>, to out: inout String.UnicodeScalarView) {
        var index = scalars.startIndex
        while index < scalars.endIndex {
            out.append(scalars[index])
            index += isShieldedOpen(scalars, at: index) ? 2 : 1
        }
    }

    /// Top-level fields a later `interpolatePrototypeText` draws, which keep their shield until then:
    /// text and spans, a button, fab or select label, a list item's headline and supporting text,
    /// titles, an image or web view url and semantics.
    private static let interpolatedFields: Set = [
        "text", "spans", "label", "headline", "supporting", "title", "url", "semantics",
    ]

    /// `node`'s tree with the shield removed from every other text field, such as option, menu,
    /// action and button-part labels, placeholders and error messages, which components read as
    /// written. A lazy list's row template keeps its shield until each row is resolved.
    static func unshieldDrawnFields(_ node: JSONValue) -> JSONValue {
        guard case var .object(fields) = node else { return node }
        let interpolated = fields.filter { interpolatedFields.contains($0.key) }
        PrototypeRepeat.bindTextFields(&fields, transform: unshield)
        fields.merge(interpolated) { _, original in original }
        let slots = fields["type"] == .string("adaptive") ? PrototypeAdaptive.slots : ["child", "header", "footer"]
        for name in slots {
            if let child = fields[name] { fields[name] = unshieldDrawnFields(child) }
        }
        if fields["type"] != .string("list"), case let .array(children)? = fields["children"] {
            fields["children"] = .array(children.map(unshieldDrawnFields))
        }
        if case let .object(screens)? = fields["screens"] {
            fields["screens"] = .object(screens.mapValues(unshieldDrawnFields))
        }
        return .object(fields)
    }

    /// Whether a shielded `{` starts at `index`: a joiner follows it and then a key.
    private static func isShieldedOpen(_ scalars: ArraySlice<Unicode.Scalar>, at index: Int) -> Bool {
        scalars[index] == "{" && index + 1 < scalars.endIndex && scalars[index + 1] == mark &&
            opensAfterMarks(scalars, from: index + 1)
    }

    /// Whether the joiners from `start` are followed by a key's first character.
    private static func opensAfterMarks(_ scalars: ArraySlice<Unicode.Scalar>, from start: Int) -> Bool {
        var index = start
        while index < scalars.endIndex, scalars[index] == mark {
            index += 1
        }
        guard index < scalars.endIndex else { return false }
        let scalar = scalars[index]
        return ("A" ... "Z").contains(scalar) || ("a" ... "z").contains(scalar) || scalar == "_"
    }
}
