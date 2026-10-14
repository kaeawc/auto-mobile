enum AccessibilityGrouping: Equatable, Sendable {
    case leaf
    case contain
    case combine
}

/// Composite containers preserve each child's identifier; tappable layouts become one element.
func prototypeAccessibilityGrouping(type: String, tappable: Bool) -> AccessibilityGrouping {
    if ["radioGroup", "segmentedButton", "topAppBar", "dialog", "snackbar", "bottomSheet"].contains(type) {
        return .contain
    }
    guard ["box", "row", "column", "scroll", "pager", "stack", "card"].contains(type) else { return .leaf }
    return tappable ? .combine : .contain
}
