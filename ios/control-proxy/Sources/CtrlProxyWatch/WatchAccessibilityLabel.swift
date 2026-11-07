/// Expose unlabeled text inputs to exact-text selectors without exposing secure values.
func watchAccessibilityLabel(elementType: UInt, label: String, value: String?, placeholder: String?) -> String {
    guard label.isEmpty, [45, 49, 50].contains(elementType) else { return label }
    if elementType != 50, let value, !value.isEmpty { return value }
    return placeholder ?? ""
}
