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
    var substitutedLength = 0
    while index < scalars.count {
        guard let end = interpolationTokenEnd(scalars, from: index) else {
            out.append(scalars[index])
            index += 1
            continue
        }
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
    }
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
        let own = ([plainText(state: state, pager: pager)] + authored)
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
            return [label, icon].compactMap(\.self).first { !$0.isEmpty }
        }
        return nil
    }
}
