/// Pure text field input policy (#12066). The host validates the authored options before show.
struct PrototypeTextFieldOptions {
    enum ImeAction: String {
        case done, next, search, send
        case proceed = "go"
    }

    enum Keyboard: String {
        case text, number, decimal, email, phone, url
    }

    let keyboard: Keyboard
    let isSecure: Bool
    let isMultiline: Bool
    let lineRange: ClosedRange<Int>?
    let maxLength: Int?
    let usesDrawnChrome: Bool
    /// The supporting line is also the field's accessibility hint.
    let supportingAccessibilityValue: String?
    /// The keyboard action key: `imeAction`, else done when only `onSubmit` is authored.
    let imeAction: ImeAction?

    init(node: PrototypeNode) {
        keyboard = Keyboard(rawValue: node.keyboardType ?? "text") ?? .text
        isSecure = node.secure == true || node.keyboardType == "password"
        isMultiline = node.multiline == true
        lineRange = isMultiline ? (node.minLines ?? 1) ... (node.maxLines ?? Int.max) : nil
        maxLength = node.maxLength
        usesDrawnChrome = node.label != nil || node.variant != nil || node.supportingText != nil || node
            .maxLength != nil
        supportingAccessibilityValue = node.supportingText
        imeAction = node.imeAction.flatMap(ImeAction.init(rawValue:))
            ?? (node.onSubmit?.isEmpty == false ? .done : nil)
    }

    /// Number, decimal and phone pads draw no Return key, so a single-line field with a keyboard
    /// action gets a keyboard toolbar button with this title that submits it instead (#12998).
    var submitAccessoryTitle: String? {
        guard [.number, .decimal, .phone].contains(keyboard), !isMultiline, let imeAction else { return nil }
        switch imeAction {
        case .done: return "Done"
        case .next: return "Next"
        case .search: return "Search"
        case .send: return "Send"
        case .proceed: return "Go"
        }
    }

    /// Count UTF-16 units like the host; a scalar is appended whole, never half a surrogate pair.
    func clip(_ text: String) -> String {
        guard let maxLength else { return text }
        var result = String.UnicodeScalarView()
        var remaining = maxLength
        for scalar in text.unicodeScalars {
            let units = scalar.value > 0xFFFF ? 2 : 1
            guard units <= remaining else { break }
            result.append(scalar)
            remaining -= units
        }
        return String(result)
    }

    func counterText(for text: String) -> String? {
        maxLength.map { "\(text.utf16.count)/\($0)" }
    }

    static func accessibilityHint(supportingText: String?, count: Int, maxLength: Int?) -> String {
        guard let maxLength else { return supportingText ?? "" }
        let counter = "\(count) of \(maxLength) characters"
        guard let supportingText, !supportingText.isEmpty else { return counter }
        return "\(supportingText). \(counter)"
    }
}
