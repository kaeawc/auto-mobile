import Foundation

/// A pager's current page, for the `{page}`/`{pageCount}` placeholders inside it.
struct PagerPosition: Equatable {
    let page: Int
    let count: Int
}

/// Fills `{key}` state placeholders (and `{page}`/`{pageCount}` inside a pager) the way
/// Android's `interpolatePrototypeText` does; an unknown placeholder stays as written.
func interpolatePrototypeText(
    _ text: String,
    state: [String: JSONValue],
    pager: PagerPosition?
)
    -> String
{
    var result = text
    if let pager {
        result = result.replacingOccurrences(of: "{page}", with: String(pager.page + 1))
            .replacingOccurrences(of: "{pageCount}", with: String(pager.count))
    }
    for (key, value) in state where result.contains("{\(key)}") {
        result = result.replacingOccurrences(of: "{\(key)}", with: value.displayString)
    }
    return result
}

extension PrototypeNode {
    /// The accessible label for this node, in Android's priority order (contentDescription, text,
    /// icon, node kind); `iconButton` and `fab` fall back to an extended FAB's label, then the icon. Placeholders are
    /// resolved in each. Nil means "let the native control
    /// name itself": SwiftUI controls and containers are not labelled by their kind (the Android
    /// kind fallback exists only because Compose layouts have no native name), and a decorative
    /// icon has no name until it is tappable.
    func accessibilityLabel(
        state: [String: JSONValue],
        pager: PagerPosition?,
        tappable: Bool
    )
        -> String?
    {
        let authored = contentDescription.map {
            interpolatePrototypeText($0, state: state, pager: pager)
        }
        if let authored, !authored.isEmpty { return authored }
        let shown = interpolatePrototypeText(text ?? "", state: state, pager: pager)
        if !shown.isEmpty { return shown }
        if type == "icon", tappable, let name, !name.isEmpty { return name }
        // Icon-only controls (#10439): an extended FAB's label, else the icon name.
        if type == "iconButton" || type == "fab" {
            return [label, icon].compactMap(\.self).first { !$0.isEmpty }
        }
        return nil
    }
}
