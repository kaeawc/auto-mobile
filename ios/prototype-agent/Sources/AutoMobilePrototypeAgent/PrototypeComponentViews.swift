#if canImport(UIKit)
    import SwiftUI
    import UIKit

    // SwiftUI drawing of the Material 3 component nodes (#10439). What a tap or edit does is decided
    // by `PrototypeSession` (see PrototypeComponents.swift); these views only draw the bound state and
    // forward interactions. Sizes are points where Android uses dp.

    extension View {
        /// `accessibilityIdentifier` only when there is one, so an untagged part stays anonymous.
        @ViewBuilder
        func prototypeIdentifier(_ identifier: String?) -> some View {
            if let identifier { accessibilityIdentifier(identifier) } else { self }
        }
    }

    /// Material colour roles when the spec has a `theme`, else the matching iOS system colours, so a
    /// themeless spec keeps the platform look (as the rest of the renderer does).
    struct ComponentColors {
        let palette: PrototypePalette

        private func role(_ name: String, _ fallback: Color) -> Color {
            palette.themed ? palette.color(role: name).map { Color($0) } ?? fallback : fallback
        }

        /// A colour field as authored: hex or a role name.
        func authored(_ spec: PrototypeModeValue?) -> Color? {
            palette.color(spec)
        }

        var primary: Color { role("primary", .accentColor) }
        var onPrimary: Color { role("onPrimary", .white) }
        var content: Color { role("onSurface", .primary) }
        var contentVariant: Color { role("onSurfaceVariant", .secondary) }
        var outline: Color { role("outlineVariant", Color(UIColor.separator)) }
        var fieldOutline: Color { role("outline", Color(UIColor.separator)) }
        var surfaceHighest: Color { role("surfaceContainerHighest", Color(UIColor.systemFill)) }
        var tonal: Color { role("secondaryContainer", Color.accentColor.opacity(0.18)) }
        var onTonal: Color { role("onSecondaryContainer", .accentColor) }
        var surface: Color { role("surface", Color(UIColor.systemBackground)) }
        var surfaceHigh: Color { role("surfaceContainerHigh", Color(UIColor.secondarySystemBackground)) }
        var inverseSurface: Color { role("inverseSurface", Color(UIColor.label)) }
        var inverseOnSurface: Color { role("inverseOnSurface", Color(UIColor.systemBackground)) }
        var error: Color { role("error", .red) }
        var onError: Color { role("onError", .white) }
        var scrim: Color { role("scrim", .black).opacity(0.32) }
        var switchOn: Color { role("primary", Color(UIColor.systemGreen)) }
        var switchOff: Color { role("surfaceContainerHighest", Color(UIColor.systemFill)) }
        var switchThumb: Color { role("onPrimary", .white) }
    }

    /// Keeps refused text while focused so constrained values can be typed character by character;
    /// editing ends or external stored changes restore the session's value (#12206).
    @MainActor
    struct PrototypeTextFieldView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        private var options: PrototypeTextFieldOptions { PrototypeTextFieldOptions(node: node) }
        let node: PrototypeNode
        let model: PrototypeModel
        @State private var draft: PrototypeTextDraft
        @State private var clippingRevision = 0
        @FocusState private var focused: Bool

        init(node: PrototypeNode, model: PrototypeModel) {
            self.node = node
            self.model = model
            _draft =
                State(initialValue: PrototypeTextDraft(stored: model.state[node.stateKey ?? ""]?.displayString ?? ""))
        }

        @ViewBuilder var body: some View {
            let _: Int = clippingRevision
            if node.type == "searchBar" {
                HStack(spacing: 8) {
                    if let symbol = prototypeSymbol(node.leadingIcon) { PrototypeGlyph(symbol: symbol) }
                    field
                        .submitLabel(.search)
                        .prototypeIdentifier(node.testTag ?? node.id)
                        .simultaneousGesture(TapGesture().onEnded { model.activate(.node(node)) })
                    if !draft.text.isEmpty {
                        Button { draft.type("") } label: {
                            PrototypeGlyph(symbol: "xmark.circle.fill")
                                .frame(width: 48, height: 48)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear")
                        .prototypeIdentifier(node.partIdentifier("clear"))
                    }
                    ForEach(Array((node.trailingActions ?? []).enumerated()), id: \.offset) { index, action in
                        Button { model.activate(.appBarButton(action)) } label: {
                            ZStack {
                                if let symbol = prototypeSymbol(action.icon) { PrototypeGlyph(symbol: symbol) }
                            }
                            .frame(width: 48, height: 48)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(action.label)
                        .prototypeIdentifier(node.partIdentifier("actions.\(index)"))
                    }
                }
                .padding(.leading, 16)
                .frame(minHeight: 56)
            } else if node.trailingIcon != nil || node.leadingIcon != nil {
                HStack(spacing: 4) {
                    if let symbol = prototypeSymbol(node.leadingIcon) {
                        PrototypeGlyph(symbol: symbol).accessibilityHidden(true)
                    }
                    field
                    if let icon = node.trailingIcon { trailingIconView(icon) }
                }
            } else {
                field
            }
        }

        /// An SF Symbol button (or plain glyph without `onTap`) beside the field; the label names it.
        @ViewBuilder
        private func trailingIconView(_ icon: PrototypeAppBarAction) -> some View {
            if let symbol = prototypeSymbol(icon.icon) {
                if icon.onTap?.isEmpty == false {
                    Button { model.activate(.appBarButton(icon)) } label: {
                        PrototypeGlyph(symbol: symbol)
                            .frame(width: 48, height: 48)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(icon.label)
                    .prototypeIdentifier(node.partIdentifier("trailingIcon"))
                } else {
                    PrototypeGlyph(symbol: symbol).accessibilityHidden(true)
                }
            }
        }

        private var field: some View {
            let key = node.stateKey ?? ""
            let stored = model.state[key]?.displayString ?? ""
            return Group {
                if node.type == "searchBar" {
                    TextField(node.placeholder ?? "", text: Binding(get: { draft.text }, set: { draft.type($0) }))
                        .focused($focused)
                } else {
                    renderedField
                }
            }
            .onChange(of: draft.text) { _, _ in
                // Read live state: another callback may have changed the captured display value.
                let stored = model.state[key]?.displayString ?? ""
                if draft.needsCommit(stored: stored) {
                    model.change(key: key, value: draft.text)
                }
                if !focused {
                    draft.endEditing(stored: model.state[key]?.displayString ?? "")
                }
            }
            .onChange(of: focused) { _, value in
                if value { model.consumeDeadTap() }
                if !value {
                    model.blur(node)
                    draft.endEditing(stored: model.state[key]?.displayString ?? "")
                }
            }
            .onSubmit { submit() }
            .toolbar {
                if focused, let title = options.submitAccessoryTitle {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        // Submit, then dismiss the pad, in the Return key's order.
                        Button(title) {
                            submit()
                            focused = false
                        }
                    }
                }
            }
            .onChange(of: stored) { _, value in
                draft.storedChanged(to: value)
            }
            .onChange(of: model.showRevision) { _, _ in
                draft.endEditing(stored: model.state[key]?.displayString ?? "")
            }
        }

        /// The Return key, or the keyboard toolbar button on pads without one, ends editing and runs
        /// `onSubmit`.
        private func submit() {
            draft.endEditing(stored: model.state[node.stateKey ?? ""]?.displayString ?? "")
            if node.type == "searchBar" || node.type == "textField" { model.run(node.onSubmit ?? []) }
        }

        private var textBinding: Binding<String> {
            Binding(get: { options.clip(draft.text) }, set: { raw in
                let clipped = options.clip(raw)
                draft.type(clipped)
                // Repaint even when overflow clips to the existing draft, without replacing the focused field.
                if clipped != raw {
                    clippingRevision += 1
                }
            })
        }

        private var keyboardType: UIKeyboardType {
            switch options.keyboard {
            case .text: .default
            case .number: .numberPad
            case .decimal: .decimalPad
            case .email: .emailAddress
            case .phone: .phonePad
            case .url: .URL
            }
        }

        @ViewBuilder private var input: some View {
            Group {
                if options.isSecure {
                    SecureField(node.placeholder ?? "", text: textBinding)
                } else if let lines = options.lineRange {
                    TextField(node.placeholder ?? "", text: textBinding, axis: .vertical)
                        .lineLimit(lines)
                } else {
                    TextField(node.placeholder ?? "", text: textBinding)
                }
            }
            .focused($focused)
            .keyboardType(keyboardType)
            .submitLabel(options.submitLabel)
        }

        @ViewBuilder private var configuredInput: some View {
            if options.keyboard == .email || options.keyboard == .url {
                input.textInputAutocapitalization(.never).autocorrectionDisabled()
            } else if options.isSecure {
                input.autocorrectionDisabled()
            } else {
                input
            }
        }

        @ViewBuilder private var accessibleInput: some View {
            let hint = model.shownError(node).map { "Error: \($0)" } ?? PrototypeTextFieldOptions.accessibilityHint(
                supportingText: options.supportingAccessibilityValue,
                count: options.clip(draft.text).utf16.count,
                maxLength: options.maxLength
            )
            // Leave the native placeholder label intact when neither override is authored.
            if let label = node.contentDescription ?? node.label {
                configuredInput.accessibilityLabel(label)
                    .accessibilityHint(hint)
            } else {
                configuredInput.accessibilityHint(hint)
            }
        }

        @ViewBuilder private var chromedInput: some View {
            if node.variant == "outlined" {
                accessibleInput.textFieldStyle(.plain)
                    .padding(12)
                    .overlay {
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(
                                model.fieldError(node)
                                    .isError ? .red : (focused ? colors.primary : colors.fieldOutline),
                                lineWidth: focused ? 2 : 1
                            )
                            .accessibilityHidden(true)
                    }
            } else {
                accessibleInput.textFieldStyle(.plain)
                    .padding(12)
                    .background {
                        UnevenRoundedRectangle(topLeadingRadius: 4, topTrailingRadius: 4)
                            .fill(colors.surfaceHighest)
                            .accessibilityHidden(true)
                    }
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(
                            model.fieldError(node).isError ? .red : (focused ? colors.primary : colors.fieldOutline)
                        )
                        .frame(height: 1)
                        .accessibilityHidden(true)
                    }
            }
        }

        @ViewBuilder private var renderedField: some View {
            if options.usesDrawnChrome {
                VStack(alignment: .leading, spacing: 4) {
                    if let label = node.label {
                        Text(label).font(.footnote).foregroundColor(colors.contentVariant)
                            .accessibilityHidden(true)
                    }
                    chromedInput
                    if node.supportingText != nil || options.maxLength != nil {
                        HStack(alignment: .top) {
                            if let supporting = node.supportingText, !model.fieldError(node).isError {
                                Text(supporting).accessibilityHidden(true)
                            }
                            Spacer(minLength: 8)
                            if let counter = options.counterText(for: draft.text) {
                                Text(counter).accessibilityHidden(true)
                            }
                        }
                        .font(.caption)
                        .foregroundColor(colors.contentVariant)
                        .accessibilityHidden(true)
                    }
                }
            } else {
                accessibleInput.textFieldStyle(.roundedBorder)
            }
        }
    }

    // MARK: Slider, chip, card

    /// A labelled slider bound to a number. The visible label is hidden from accessibility because it
    /// is also the slider's own label, so the slider is one adjustable element.
    @MainActor
    struct PrototypeSliderView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel
        let style: Style?

        var body: some View {
            let _: Int = model.refusedChanges
            let lower = node.min ?? 0
            let upper = Swift.max(node.max ?? 1, lower + 0.000001)
            let key = node.stateKey ?? ""
            let value = Binding<Double>(
                get: {
                    _ = model.refusedChanges
                    return Swift.min(Swift.max(model.state[key]?.numberValue ?? lower, lower), upper)
                },
                set: { raw in
                    let snapped = snapPrototypeSlider(raw, min: lower, max: upper, step: node.step)
                    model.slide(key: key, value: snapped, then: node.onTap ?? [])
                }
            )
            VStack(alignment: .leading, spacing: 4) {
                if let label = node.label {
                    Text(label).foregroundColor(colors.authored(style?.color) ?? colors.content)
                        .accessibilityHidden(true)
                }
                if let step = node.step, step > 0 {
                    Slider(value: value, in: lower ... upper, step: step) { Text(node.label ?? "") }
                } else {
                    Slider(value: value, in: lower ... upper) { Text(node.label ?? "") }
                }
            }
        }
    }

    /// A filter chip (bound to a boolean) toggles and reads as selected; assist, input and suggestion
    /// chips are buttons that run `onTap`.
    @MainActor
    struct PrototypeChipView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel
        let style: Style?

        var body: some View {
            let checked = node.stateKey.flatMap { model.state[$0]?.boolValue }
            let isOn = checked ?? false
            let chip = Button { model.activate(.node(node)) } label: {
                HStack(spacing: 8) {
                    if isOn { PrototypeGlyph(symbol: "checkmark") }
                    Text(node.label ?? "")
                }
                .font(.subheadline.weight(.medium))
                .foregroundColor(colors.authored(style?.color) ?? colors.content)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(RoundedRectangle(cornerRadius: 8).fill(isOn ? colors.tonal : .clear))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(isOn ? .clear : colors.outline, lineWidth: 1))
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if checked != nil {
                chip.accessibilityValue(isOn ? "checked" : "unchecked").accessibilityAddTraits(isOn ? .isSelected : [])
            } else {
                chip
            }
        }
    }

    /// A filled (default), elevated or outlined card laying its children out as a column. An authored
    /// `style.background` replaces the container colour; an `onTap` makes the whole card tappable.
    @MainActor
    struct PrototypeCardView: View {
        @Environment(\.prototypePalette) private var palette
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel
        let style: Style?
        var cornerRadius: Double = 12

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: cornerRadius)
            let defaultFill = node.variant == "filled" || node.variant == nil
                ? colors.surfaceHigh
                : colors.surface
            VStack(alignment: .leading, spacing: style?.spacing ?? 0) {
                ForEach(node.drawnChildren(holds: model.holds, stacks: model.stacks), id: \.offset) { entry in
                    NodeView(node: entry.node, model: model, inStackSlot: true)
                }
            }
            .animation(
                PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
                    .containerSizeDuration.map { .easeInOut(duration: $0) },
                value: node.containerLayoutSignature(state: model.state) { model.holds($0) }
            )
            .frame(minWidth: 0, alignment: .leading)
            // An authored gradient is painted behind the card, over the authored background, by the
            // node's own style; the card's fill would cover it.
            .background(shape.fill(
                style?.gradient == nil ? colors.authored(style?.background) ?? defaultFill : .clear
            ))
            .overlay(shape.stroke(node.variant == "outlined" ? colors.outline : .clear, lineWidth: 1))
            .shadow(color: node.variant == "elevated" ? .black.opacity(0.2) : .clear, radius: 2, y: 1)
        }
    }

    // MARK: Radio group, list item

    /// One button per option, each its own element with the option label, a selected state and the
    /// identifier `<tag>.<value>`. A bound value matching no option leaves every option unselected.
    @MainActor
    struct PrototypeRadioGroupView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel
        let style: Style?

        var body: some View {
            let selected = node.stateKey.flatMap { model.state[$0]?.stringValue }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array((node.options ?? []).enumerated()), id: \.offset) { _, option in
                    let isSelected = option.value == selected
                    Button { model.activate(.option(node, option)) } label: {
                        HStack(spacing: 12) {
                            PrototypeGlyph(symbol: isSelected ? "largecircle.fill.circle" : "circle")
                                .foregroundColor(isSelected ? colors.primary : colors.contentVariant)
                            Text(option.label).foregroundColor(colors.authored(style?.color) ?? colors.content)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(option.label)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                    .prototypeIdentifier(node.partIdentifier(option.value))
                }
            }
        }
    }

    /// Headline, optional supporting line, optional leading icon and trailing switch, checkbox or
    /// icon. The row is one element: a toggle when it has a trailing switch or checkbox, else a button
    /// when it has `onTap`, else inert text.
    @MainActor
    struct PrototypeListItemView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel
        let style: Style?

        var body: some View {
            let isOn = node.toggleKey.flatMap { model.state[$0]?.boolValue } ?? false
            if node.toggleKey != nil {
                let button = Button { model.activate(.node(node)) } label: { row(isOn: isOn) }.buttonStyle(.plain)
                if case .switch = node.trailing {
                    button.accessibilityAddTraits(.isToggle).accessibilityValue(isOn ? "1" : "0")
                } else {
                    button.accessibilityValue(isOn ? "checked" : "unchecked")
                        .accessibilityAddTraits(isOn ? .isSelected : [])
                }
            } else if let actions = node.onTap, !actions.isEmpty {
                Button { model.activate(.node(node)) } label: { row(isOn: isOn) }.buttonStyle(.plain)
            } else {
                row(isOn: isOn).accessibilityElement(children: .combine)
            }
        }

        private func row(isOn: Bool) -> some View {
            HStack(spacing: 16) {
                if let symbol = prototypeSymbol(node.leadingIcon) {
                    PrototypeGlyph(symbol: symbol)
                        .foregroundColor(colors.authored(style?.color) ?? colors.contentVariant)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(node.headline ?? "").foregroundColor(colors.authored(style?.color) ?? colors.content)
                    if let supporting = node.supporting {
                        Text(supporting).font(.subheadline)
                            .foregroundColor(colors.authored(style?.color) ?? colors.contentVariant)
                    }
                }
                Spacer(minLength: 0)
                trailing(isOn: isOn).accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: node.supporting == nil ? 56 : 72, alignment: .leading)
            .contentShape(Rectangle())
        }

        @ViewBuilder
        private func trailing(isOn: Bool) -> some View {
            switch node.trailing {
            case .switch:
                PrototypeSwitchTrack(isOn: isOn)
            case .checkbox:
                PrototypeGlyph(symbol: isOn ? "checkmark.square.fill" : "square")
            case let .icon(name):
                if let symbol = prototypeSymbol(name) {
                    PrototypeGlyph(symbol: symbol).foregroundColor(colors.contentVariant)
                }
            default:
                EmptyView()
            }
        }
    }

    // MARK: Icon button, FAB, segmented button, top app bar

    /// An icon-only button: standard (default), filled, tonal or outlined. Its label comes from the
    /// node (`contentDescription`, else the icon name) via `IdentifierModifier`.
    /// A switch's track and thumb drawn in SwiftUI. A `Toggle` with the switch style hosts a UIKit
    /// `UISwitch`, which XCUITest still lists as its own switch elements under `accessibilityHidden`
    /// and inside a combined parent, so one switch row came back as three nodes (#10899). The
    /// control that draws this owns the single accessibility element.
    @MainActor
    struct PrototypeSwitchTrack: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let isOn: Bool

        var body: some View {
            Capsule()
                .fill(isOn ? colors.switchOn : colors.switchOff)
                .frame(width: 51, height: 31)
                .overlay(alignment: isOn ? .trailing : .leading) {
                    Circle()
                        .fill(colors.switchThumb)
                        .shadow(color: .black.opacity(0.2), radius: 1, y: 1)
                        .padding(2)
                }
                .accessibilityHidden(true)
        }
    }

    /// A decorative or button-internal SF Symbol drawn as a text glyph. A bare `Image(systemName:)`
    /// still surfaces as an image element on iOS 26 even under `accessibilityHidden(true)`; a `Text`
    /// glyph with the symbol inline does not, so the parent control's label stays the only element.
    @MainActor
    struct PrototypeGlyph: View {
        let symbol: String

        var body: some View {
            Text(Image(systemName: symbol)).accessibilityHidden(true)
        }
    }

    @MainActor
    struct PrototypeIconButtonView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel
        let style: Style?

        var body: some View {
            let variant = node.variant ?? "standard"
            let fill: Color = switch variant {
            case "filled": colors.primary
            case "tonal": colors.tonal
            default: .clear
            }
            let tint: Color = colors
                .authored(style?.color) ??
                (variant == "filled" ? colors.onPrimary : variant == "tonal" ? colors.onTonal : colors.content)
            Button { model.activate(.node(node)) } label: {
                ZStack {
                    if let symbol = prototypeSymbol(node.icon) { PrototypeGlyph(symbol: symbol) }
                }
                .font(.system(size: 20))
                .foregroundColor(tint)
                .frame(width: 40, height: 40)
                .background(Circle().fill(fill))
                .overlay(Circle().stroke(variant == "outlined" ? colors.outline : .clear, lineWidth: 1))
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    /// A floating action button: small, regular or large, or extended (icon and label) with a `label`.
    @MainActor
    struct PrototypeFabView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel
        let style: Style?
        let label: String

        var body: some View {
            let (side, radius): (CGFloat, CGFloat) = switch node.label == nil ? node.size : nil {
            case "small": (40, 12)
            case "large": (96, 28)
            default: (56, 16)
            }
            Button { model.activate(.node(node)) } label: {
                HStack(spacing: 12) {
                    if let symbol = prototypeSymbol(node.icon) {
                        PrototypeGlyph(symbol: symbol).font(.system(size: side >= 96 ? 36 : 22))
                    }
                    if node.label != nil { Text(label).font(.body.weight(.medium)) }
                }
                .foregroundColor(colors.authored(style?.color) ?? colors.primary)
                .padding(.horizontal, node.label == nil ? 0 : 20)
                .frame(minWidth: side, minHeight: side)
                .background(ZStack {
                    RoundedRectangle(cornerRadius: radius).fill(colors.surfaceHigh)
                    RoundedRectangle(cornerRadius: radius).fill(colors.tonal)
                })
                .shadow(color: .black.opacity(0.25), radius: 3, y: 2)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    /// A single-select segmented row bound to a string key. Each segment is its own button with its
    /// label, a selected state and the identifier `<tag>.<value>`; a native segmented `Picker` cannot
    /// carry per-segment identifiers, so the segments are drawn here.
    @MainActor
    struct PrototypeSegmentedButtonView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel

        var body: some View {
            let options = node.options ?? []
            let selected = node.stateKey.flatMap { model.state[$0]?.stringValue }
            HStack(spacing: 0) {
                ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                    let isSelected = option.value == selected
                    if index > 0 { colors.outline.frame(width: 1) }
                    Button { model.activate(.option(node, option)) } label: {
                        HStack(spacing: 4) {
                            if isSelected { PrototypeGlyph(symbol: "checkmark") }
                            Text(option.label).lineLimit(1)
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(colors.content)
                        .padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(isSelected ? colors.tonal : .clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(option.label)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                    .prototypeIdentifier(node.partIdentifier(option.value))
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(colors.outline, lineWidth: 1))
        }
    }

    /// A small (default), centerAligned, medium or large top app bar. The title is a header; the
    /// navigation icon and actions are icon buttons labelled by their `label` and identified
    /// `<tag>.navigation` and `<tag>.actions.<index>`. Insets come only from `safeAreaPadding`.
    @MainActor
    struct PrototypeTopAppBarView: View {
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel
        let style: Style?
        let title: String

        var body: some View {
            let variant = node.variant ?? "small"
            let extent = PrototypeBarScrollState.extent(variant: variant, behavior: node.onScroll)
            let fraction = model.barScroll(node).collapse(
                node.onScroll,
                extent: extent,
                reduced: reduceMotion || model.spec?.motion == "none"
            )
            VStack(alignment: .leading, spacing: 0) {
                ZStack {
                    if variant == "centerAligned" {
                        titleText(.title3.weight(.semibold)).padding(.horizontal, 56)
                    }
                    HStack(spacing: 0) {
                        if let navigation = node.navigationIcon {
                            button(navigation, identifier: node.partIdentifier("navigation"))
                        }
                        if variant == "small" || (fraction >= 1 && node.onScroll == "exitUntilCollapsed") {
                            titleText(.title3.weight(.semibold)).padding(.leading, node.navigationIcon == nil ? 12 : 4)
                        }
                        Spacer(minLength: 0)
                        ForEach(Array((node.actions ?? []).enumerated()), id: \.offset) { index, action in
                            button(action, identifier: node.partIdentifier("actions.\(index)"))
                        }
                    }
                }
                .padding(.horizontal, 4)
                .frame(minHeight: 64)
                if variant == "medium" || variant == "large" {
                    titleText(variant == "large" ? .largeTitle : .title)
                        .padding(.horizontal, 16)
                        .padding(.bottom, variant == "large" ? 28 : 20)
                        .frame(
                            height: ["enterAlways", "exitUntilCollapsed"]
                                .contains(node.onScroll ?? "") ? (variant == "large" ? 88 : 48) : nil,
                            alignment: .bottomLeading
                        )
                        .modifier(PrototypeBarClip(fraction: node.onScroll == "exitUntilCollapsed" ? fraction : 0))
                        .accessibilityHidden(node.onScroll == "exitUntilCollapsed" && fraction >= 1)
                }
            }
            .modifier(PrototypeBarClip(fraction: node.onScroll == "enterAlways" ? fraction : 0))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(style?.hasAuthoredFill ?? false ? .clear : colors.surface)
        }

        private func titleText(_ font: Font) -> some View {
            Text(title)
                .font(font)
                .foregroundColor(colors.authored(style?.color) ?? colors.content)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
        }

        private func button(_ action: PrototypeAppBarAction, identifier: String?) -> some View {
            Button { model.activate(.appBarButton(action)) } label: {
                ZStack {
                    if let symbol = prototypeSymbol(action.icon) { PrototypeGlyph(symbol: symbol) }
                }
                .font(.system(size: 20))
                .foregroundColor(colors.authored(style?.color) ?? colors.content)
                .frame(width: 48, height: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(action.label)
            .prototypeIdentifier(identifier)
        }
    }

    // MARK: Divider, badge, progress

    /// A horizontal (default) or vertical hairline; it is an accessibility element only when tagged.
    @MainActor
    struct PrototypeDividerView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let style: Style?

        var body: some View {
            let line = Rectangle().fill(colors.authored(style?.color) ?? colors.outline)
            if node.orientation == "vertical" {
                tagged(line.frame(width: 1).frame(maxHeight: .infinity))
            } else {
                tagged(line.frame(height: 1).frame(maxWidth: .infinity))
            }
        }

        @ViewBuilder
        private func tagged(_ view: some View) -> some View {
            if node.identifier != nil { view.accessibilityElement() } else { view.accessibilityHidden(true) }
        }
    }

    /// A small dot, or a short text such as a count; the text is its accessible label.
    @MainActor
    struct PrototypeBadgeView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let text: String
        let style: Style?
        let tagged: Bool

        var body: some View {
            let fill = colors.authored(style?.background) ?? colors.error
            if text.isEmpty {
                Circle().fill(fill).frame(width: 6, height: 6)
                    .accessibilityElement()
                    .accessibilityHidden(!tagged)
            } else {
                Text(text)
                    .font(.caption2.weight(.medium))
                    .foregroundColor(colors.authored(style?.color) ?? colors.onError)
                    .padding(.horizontal, 4)
                    .frame(minWidth: 16, minHeight: 16)
                    .background(Capsule().fill(fill))
            }
        }
    }

    /// Linear (default) or circular. Bound to a number it is determinate and reports `value / max`;
    /// unbound it is indeterminate.
    @MainActor
    struct PrototypeProgressView: View {
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel

        var body: some View {
            let fraction = node.stateKey.map { prototypeProgressFraction(
                model.state[$0]?.numberValue ?? 0,
                max: node.max
            ) }
            let animated = PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).spatial
            if node.variant == "circular" {
                if let fraction {
                    ZStack {
                        Circle().stroke(colors.tonal, lineWidth: 4)
                        Circle().trim(from: 0, to: fraction)
                            .stroke(colors.primary, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                    }
                    .frame(width: 40, height: 40)
                    .accessibilityElement()
                    .accessibilityValue("\(Int((fraction * 100).rounded())) percent")
                    .accessibilityAddTraits(.updatesFrequently)
                } else if animated {
                    ProgressView().progressViewStyle(.circular)
                } else {
                    Circle().trim(from: 0, to: 0.3)
                        .stroke(colors.primary, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .frame(width: 40, height: 40)
                        .accessibilityLabel("In progress")
                }
            } else if let fraction {
                ProgressView(value: fraction).progressViewStyle(.linear)
            } else {
                IndeterminateBar(animated: animated)
            }
        }
    }

    /// SwiftUI's linear `ProgressView` has no indeterminate form, so the sweep is drawn here.
    @MainActor
    private struct IndeterminateBar: View {
        let animated: Bool
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        var body: some View {
            TimelineView(.animation(paused: !animated)) { context in
                GeometryReader { proxy in
                    let phase = animated
                        ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.5) / 1.5
                        : 0.5
                    let width = proxy.size.width * 0.3
                    Capsule()
                        .fill(colors.primary)
                        .frame(width: width)
                        .offset(x: (proxy.size.width + width) * phase - width)
                }
            }
            .frame(height: 4)
            .frame(maxWidth: .infinity)
            .background(colors.tonal)
            .clipShape(Capsule())
            .accessibilityElement()
            .accessibilityValue("In progress")
            .accessibilityAddTraits(.updatesFrequently)
        }
    }

    // MARK: Pickers

    /// A wheel time picker bound to integer hour and minute keys. A change sends both keys at once;
    /// `is24Hour` picks the clock, and without it the device setting applies.
    @MainActor
    struct PrototypeTimePickerView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel

        var body: some View {
            let _: Int = model.refusedChanges
            let hourKey = node.hourKey ?? ""
            let minuteKey = node.minuteKey ?? ""
            let hour = model.state[hourKey]?.intValue ?? 0
            let minute = model.state[minuteKey]?.intValue ?? 0
            // Separate wheels so each carries its own label (hour, minute, AM/PM); a single
            // `DatePicker` wheel is one unlabelled element to accessibility.
            HStack(spacing: 0) {
                wheel(PrototypeTime.hourLabel, selection: Binding(
                    get: {
                        _ = model.refusedChanges
                        return use24 ? hour : PrototypeTime.hour12(of: hour)
                    },
                    set: { picked in
                        commit(
                            hour: use24 ? picked : PrototypeTime.hour24(
                                hour12: picked,
                                pm: PrototypeTime.isPM(hour: hour)
                            ),
                            minute: minute
                        )
                    }
                ), values: use24 ? Array(0 ..< 24) : Array(1 ... 12), format: use24 ? "%02d" : "%d")
                wheel(PrototypeTime.minuteLabel, selection: Binding(
                    get: {
                        _ = model.refusedChanges
                        return minute
                    },
                    set: { commit(hour: hour, minute: $0) }
                ), values: Array(0 ..< 60), format: "%02d")
                if !use24 {
                    Picker(PrototypeTime.meridiemLabel, selection: Binding(
                        get: {
                            _ = model.refusedChanges
                            return PrototypeTime.isPM(hour: hour) ? 1 : 0
                        },
                        set: {
                            commit(
                                hour: PrototypeTime.hour24(hour12: PrototypeTime.hour12(of: hour), pm: $0 == 1),
                                minute: minute
                            )
                        }
                    )) {
                        Text("AM").tag(0)
                        Text("PM").tag(1)
                    }
                    .labelsHidden()
                    .pickerStyle(.wheel)
                }
            }
            .frame(height: 162)
            .accessibilityElement(children: .contain)
        }

        private func wheel(_ label: String, selection: Binding<Int>, values: [Int], format: String) -> some View {
            Picker(label, selection: selection) {
                ForEach(values, id: \.self) { Text(String(format: format, $0)).tag($0) }
            }
            .labelsHidden()
            .pickerStyle(.wheel)
        }

        private func commit(hour: Int, minute: Int) {
            model.setTime(
                hourKey: node.hourKey ?? "",
                minuteKey: node.minuteKey ?? "",
                hour: hour,
                minute: minute,
                then: node.onTap ?? []
            )
        }

        private var use24: Bool {
            switch node.is24Hour {
            case let explicit?: explicit
            case nil: !(DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .autoupdatingCurrent) ?? "")
                .contains("a")
            }
        }
    }

    /// A calendar bound to a `YYYY-MM-DD` string key; picking another day binds it.
    @MainActor
    struct PrototypeDatePickerView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel

        var body: some View {
            let _: Int = model.refusedChanges
            let key = node.stateKey ?? ""
            let bound = model.state[key]?.stringValue
            let selection = Binding<Date>(
                get: {
                    _ = model.refusedChanges
                    return bound.flatMap(PrototypeDate.date(from:)) ?? PrototypeDate.range.lowerBound
                },
                set: { date in
                    let picked = PrototypeDate.string(from: date)
                    if picked != bound { model.choose(key: key, value: picked, then: node.onTap ?? []) }
                }
            )
            DatePicker("", selection: selection, in: PrototypeDate.range, displayedComponents: .date)
                .labelsHidden()
                .datePickerStyle(.graphical)
                .environment(\.calendar, PrototypeDate.calendar)
                .environment(\.timeZone, PrototypeDate.calendar.timeZone)
                .accessibilityValue(bound ?? "")
        }
    }

    // MARK: Dialog, snackbar

    /// Open dialogs and snackbars, drawn above the whole author tree inside the prototype window, in
    /// tree order. A dialog's scrim covers the window, intercepts every touch and closes it on tap; a
    /// snackbar takes touches only on itself.
    @MainActor
    struct PrototypeModalLayer: View {
        @Environment(\.prototypePalette) private var palette
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let model: PrototypeModel
        @State private var retainedDrawers: [PrototypeNode] = []

        var body: some View {
            let modals = model.spec?.root.openModals(state: model.state, pages: model.pages, stacks: model.stacks) ?? []
            let displayed = modals + retainedDrawers.filter { old in !modals.contains { $0 === old } }
            ZStack {
                ForEach(Array(displayed.enumerated()), id: \.element.identity) { index, node in
                    if node.type == "tooltip" {
                        PrototypeTooltipOverlay(node: node, model: model, hitKey: "modal.\(index)")
                    } else if node.type == "drawer" {
                        PrototypeDrawerOverlay(
                            node: node,
                            model: model,
                            isOpen: modals.contains { $0 === node },
                            hitKey: "modal.\(index)"
                        ) {
                            retainedDrawers.removeAll { $0 === node }
                        }
                    } else if node.type == "menu" {
                        PrototypeMenuOverlay(node: node, model: model)
                            .reportFrame(key: "modal.\(index)", model: model)
                    } else if node.type == "dialog" {
                        ZStack {
                            colors.scrim
                                .contentShape(Rectangle())
                                .onTapGesture { model.closeModal(node) }
                                .accessibilityHidden(true)
                            NodeView(node: node, model: model, presentedAsModal: true)
                        }
                        .reportFrame(key: "modal.\(index)", model: model)
                    } else {
                        NodeView(node: node, model: model, presentedAsModal: true)
                            .reportFrame(key: "modal.\(index)", model: model)
                            .padding(.bottom, model.safeInsets.bottom)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    }
                    // Anchored nodes in the modal's body draw above that modal, as on Android.
                    PrototypeAnchorLayer(
                        entries: PrototypeNode.layeredAnchors(
                            in: node.childEntries(path: "modal\(index)"),
                            state: model.state,
                            pages: model.pages,
                            stacks: model.stacks,
                            retainExiting: PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
                                .enabled
                        ),
                        model: model
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay {
                if let selected = model.expandedSelect,
                   model.spec?.root.visibleSelect(selected, state: model.state, pages: model.pages) == true
                {
                    PrototypeSelectOverlay(node: selected, model: model)
                        .reportFrame(key: "modal.select", model: model)
                }
            }
            .onChange(of: modals.map(\.identity), initial: true) { _, _ in
                for drawer in modals
                    where drawer.type == "drawer" && !retainedDrawers.contains(where: { $0 === drawer })
                {
                    retainedDrawers.append(drawer)
                }
            }
            .onChange(of: modals.dialogIdentities) { before, _ in
                if prototypeModalChangeEndsEditing(
                    from: before, to: modals, state: model.state, pages: model.pages, stacks: model.stacks
                ) { model.endEditing() }
            }
        }
    }

    /// An alert-dialog surface: optional icon, the title (a header), body text, optional `child`, then
    /// the dismiss and confirm buttons, identified `<tag>.dismiss` and `<tag>.confirm`. A button closes
    /// the dialog, then runs its own `onTap`; a tap on the body runs the dialog's `onTap`.
    @MainActor
    struct PrototypeDialogView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel
        let title: String
        let text: String?

        var body: some View {
            VStack(alignment: .leading, spacing: 16) {
                if let symbol = prototypeSymbol(node.icon) {
                    // Decorative, as Android's dialog icon (contentDescription = null). Drawn as a text
                    // glyph: a bare SF Symbol Image still surfaced as an image element on iOS 26 despite
                    // accessibilityHidden.
                    PrototypeGlyph(symbol: symbol)
                        .font(.title2)
                        .frame(maxWidth: .infinity)
                }
                let parts = node.dialogParts(title: title, text: text)
                ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                    partView(part)
                }
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                        if case let .button(part, label, identifier) = part {
                            textButton(part: part, label: label, identifier: identifier)
                        }
                    }
                }
            }
            .padding(24)
            .frame(minWidth: 280, maxWidth: 560)
            // Body taps never reach the scrim; the dialog's own onTap runs instead. The gesture sits on
            // the surface behind the parts, not on the stack: on the stack SwiftUI hands it to every
            // child as an accessibility action, which surfaced the decorative icon as a tappable image.
            .background(
                RoundedRectangle(cornerRadius: 28)
                    .fill(colors.surfaceHigh)
                    .contentShape(Rectangle())
                    .onTapGesture { model.run(node.onTap ?? []) }
                    .accessibilityHidden(true)
            )
            // Each part stays its own element (#10439). No `.isModal` trait here: added to this stack
            // it lands on every child element, and with several modal siblings the accessibility tree
            // kept only the last one (Save), dropping the title, text, pickers and Cancel. Android's
            // in-window dialog is not modal to accessibility either; the scrim blocks touches.
            .accessibilityElement(children: .contain)
            .padding(.horizontal, 24)
            .padding(.vertical, 24)
        }

        /// Title, text and content; the buttons share the trailing row.
        @ViewBuilder
        private func partView(_ part: PrototypeDialogPart) -> some View {
            switch part {
            case let .title(title):
                Text(title).font(.title2).accessibilityAddTraits(.isHeader)
            case let .text(text):
                Text(text).font(.body).foregroundColor(colors.contentVariant)
            case .content:
                if let child = node.child {
                    // A child taller than the screen scrolls, so the title and buttons stay on screen
                    // (the alarm fixture's wheel and calendar overflow an iPhone below the host bar).
                    // The scroll view is named after the dialog, and its indicator is hidden: UIKit
                    // exposes a visible indicator as its own "Vertical scroll bar" element (#10899).
                    ViewThatFits(in: .vertical) {
                        NodeView(node: child, model: model)
                        ScrollView(.vertical) { NodeView(node: child, model: model) }
                            .scrollIndicators(.hidden)
                            .accessibilityLabel(node.dialogContentLabel(title: title, text: text))
                    }
                }
            case .button:
                EmptyView()
            }
        }

        private func textButton(part: String, label: String, identifier: String?) -> some View {
            Button(label) {
                if let button = part == "confirm" ? node.confirm : node.dismiss {
                    model.activate(.modalButton(node, button))
                }
            }
            .buttonStyle(.borderless)
            .frame(minHeight: 44)
            .prototypeIdentifier(identifier)
        }
    }

    /// A snackbar at the bottom of the window; not modal, and it stays until closed unless it sets
    /// `durationMs` (`SnackbarTimeouts`). Its action, identified `<tag>.action`, closes it and runs `onTap`.
    @MainActor
    struct PrototypeSnackbarView: View {
        @Environment(\.prototypePalette) private var palette
        private var colors: ComponentColors { ComponentColors(palette: palette) }
        let node: PrototypeNode
        let model: PrototypeModel
        let text: String

        var body: some View {
            HStack(spacing: 8) {
                Text(text)
                    .foregroundColor(colors.inverseOnSurface)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let action = node.action {
                    Button(action.label) { model.activate(.modalButton(node, action)) }
                        .buttonStyle(.borderless)
                        .frame(minHeight: 44)
                        .prototypeIdentifier(node.partIdentifier("action"))
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 48)
            .background(RoundedRectangle(cornerRadius: 4).fill(colors.inverseSurface))
            .padding(12)
        }
    }

    extension PrototypeTextFieldOptions {
        /// SwiftUI's name for the authored keyboard action key; the system default without one.
        var submitLabel: SubmitLabel {
            switch imeAction {
            case .done: .done
            case .next: .next
            case .search: .search
            case .send: .send
            case .proceed: .go
            case nil: .return
            }
        }
    }
#endif
