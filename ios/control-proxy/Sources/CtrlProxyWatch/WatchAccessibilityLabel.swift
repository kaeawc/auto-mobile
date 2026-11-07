/// Expose unlabeled text inputs to exact-text selectors without exposing secure values.
func watchAccessibilityLabel(elementType: UInt, label: String, value: String?, placeholder: String?) -> String {
    guard label.isEmpty, [45, 49, 50].contains(elementType) else { return label }
    if elementType != 50, let value, !value.isEmpty { return value }
    return placeholder ?? ""
}

/// The wire node carries one label, so a labeled, populated text field would hide its value from
/// exact-text selectors. Expose that value as a child of the same type and identifier; tapping it
/// taps the field. Secure fields never expose values.
func watchTextValueChild(elementType: UInt, label: String, value: String?) -> String? {
    guard [45, 49].contains(elementType), !label.isEmpty, let value, !value.isEmpty, value != label else {
        return nil
    }
    return value
}
