import SwiftUI
import UIKit

// Sizes are points on iOS where the Android renderer uses dp (owner decision 5).

struct PagerContext {
    let page: Int
    let count: Int
}

private struct PagerContextKey: EnvironmentKey {
    static let defaultValue: PagerContext? = nil
}

extension EnvironmentValues {
    var pagerContext: PagerContext? {
        get { self[PagerContextKey.self] }
        set { self[PagerContextKey.self] = newValue }
    }
}

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = PrototypePalette.make(theme: nil, systemDark: false)
}

extension EnvironmentValues {
    /// The active spec theme's resolved palette; the baseline when the spec has no `theme`.
    var prototypePalette: PrototypePalette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

private struct TypographyKey: EnvironmentKey {
    static let defaultValue = PrototypeTypography.standard
}

private struct ShapesKey: EnvironmentKey {
    static let defaultValue = PrototypeShapes.standard
}

extension EnvironmentValues {
    /// The active spec theme's type scale and corner scale; Material 3 stock when it has none.
    var prototypeTypography: PrototypeTypography {
        get { self[TypographyKey.self] }
        set { self[TypographyKey.self] = newValue }
    }

    var prototypeShapes: PrototypeShapes {
        get { self[ShapesKey.self] }
        set { self[ShapesKey.self] = newValue }
    }
}

extension Color {
    init(_ rgba: PrototypeRGBA) {
        self.init(.sRGB, red: rgba.red, green: rgba.green, blue: rgba.blue, opacity: rgba.alpha)
    }

    /// `#RRGGBB` or `#AARRGGBB`, matching the spec's Android-style hex.
    init?(hex: String?) {
        guard let rgba = PrototypeRGBA(hex: hex) else { return nil }
        self.init(rgba)
    }
}

extension PrototypePalette {
    /// A colour field as a hex literal or a Material role name from the theme; nil if neither.
    func color(_ spec: String?) -> Color? {
        resolve(spec).map { Color($0) }
    }
}

func swiftUIAlignment(_ name: String?) -> Alignment {
    switch name {
    case "topCenter": return .top
    case "topEnd": return .topTrailing
    case "centerStart": return .leading
    case "center": return .center
    case "centerEnd": return .trailing
    case "bottomStart": return .bottomLeading
    case "bottomCenter": return .bottom
    case "bottomEnd": return .bottomTrailing
    default: return .topLeading
    }
}

/// SF Symbol for a built-in (Material) icon name; unknown names draw a placeholder.
func prototypeSymbol(_ name: String?, fallback: String = "questionmark.square") -> String {
    name.flatMap { sfSymbols[$0] } ?? fallback
}

private let sfSymbols: [String: String] = [
    "home": "house", "search": "magnifyingglass", "settings": "gearshape", "person": "person",
    "favorite": "heart", "add": "plus", "close": "xmark", "check": "checkmark",
    "arrow_back": "arrow.left", "arrow_forward": "arrow.right", "chevron_left": "chevron.left",
    "chevron_right": "chevron.right", "menu": "line.3.horizontal", "more_vert": "ellipsis",
    "share": "square.and.arrow.up", "edit": "pencil", "delete": "trash", "info": "info.circle",
    "warning": "exclamationmark.triangle", "notifications": "bell", "star": "star",
    "shopping_cart": "cart", "help": "questionmark.circle", "refresh": "arrow.clockwise",
    "done": "checkmark.circle", "cancel": "xmark.circle", "play_arrow": "play.fill",
    "pause": "pause.fill", "stop": "stop.fill", "mail": "envelope", "phone": "phone",
    "location_on": "mappin.and.ellipse", "calendar_today": "calendar", "visibility": "eye",
    "lock": "lock", "logout": "rectangle.portrait.and.arrow.right",
    "alarm": "alarm", "schedule": "clock", "event": "calendar", "today": "calendar",
    "remove": "minus", "expand_more": "chevron.down", "expand_less": "chevron.up",
    "more_horiz": "ellipsis", "account_circle": "person.crop.circle", "send": "paperplane",
    "bookmark": "bookmark", "thumb_up": "hand.thumbsup", "photo_camera": "camera",
    "image": "photo", "music_note": "music.note", "wifi": "wifi", "sort": "arrow.up.arrow.down",
    "filter_list": "line.3.horizontal.decrease", "content_copy": "doc.on.doc",
]

struct NodeView: View {
    let node: PrototypeNode
    @ObservedObject var model: PrototypeModel
    /// Dialogs and snackbars draw nothing in place; `PrototypeModalLayer` draws them with this set.
    var presentedAsModal = false
    /// Anchored nodes draw nothing in place; `PrototypeAnchorLayer` draws them with this set (#10803).
    var anchorPlaced = false
    /// A `cover` anchor's size, which replaces the authored width and height.
    var coverSize: CGSize?
    /// Set by a parent that lays its children out through `PrototypeNode.drawnChildren`.
    var inStackSlot = false
    @Environment(\.pagerContext) private var pager
    @Environment(\.prototypePalette) private var palette
    @Environment(\.prototypeTypography) private var typography
    @Environment(\.prototypeShapes) private var shapes
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // A node that draws nothing here (hidden, anchored elsewhere, a modal not yet in its layer)
        // returns no view at all: a stack puts its spacing around an empty ZStack too, which left
        // a gap Android does not (#10912). Container parents also leave such children out.
        if !drawsNow {
            EmptyView()
        } else if inStackSlot || node.visibleWhen == nil {
            // A parent that lays children out through `drawnChildren` inserts and removes this node
            // itself, inside its own `.animation(value: layoutSignature)`, so the transition rides
            // on the node and the parent drives the animation. No wrapping ZStack: a ZStack places
            // its child at the size it measured, and a row re-laid out at exactly its ideal width
            // shares that width out evenly, cutting "Edit"/"Save" short (#10899).
            styled(content).transition(transition.swiftUITransition)
        } else {
            // Parents without that filter (a root, a scroll child, a pager page): the conditional
            // lives in a stable container so the insertion/removal has one whose animation is
            // driven by `isVisible`; a bare `Group` is flattened into the parent's children, which
            // left a trailing conditional child undrawn and its transition un-animated (#10898).
            // The container passes its parent's proposal through, unlike a ZStack (see above).
            PrototypeLayeredLayout(alignment: .topLeading) {
                if isVisible {
                    styled(content).transition(transition.swiftUITransition)
                }
            }
            .animation(transition == .instant ? nil : .easeInOut(duration: 0.25), value: isVisible)
        }
    }

    /// `visibleWhen` appears and disappears with the node's `transition`; instant when motion is
    /// off (spec `motion: "none"` or the system's Reduce Motion), as on Android (#10442).
    private var transition: PrototypeVisibilityTransition {
        let motion = PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
        return node.visibleWhen == nil ? .instant : motion.visibility(transition: node.transition)
    }

    /// Whether anything is drawn for the node in the slot this view occupies. Unfiltered parents
    /// still hold a hidden `visibleWhen` node's stable (empty) container for its animation.
    private var drawsNow: Bool {
        guard presentedAsModal || !prototypeModalTypes.contains(node.type), drawnHere else { return false }
        return isVisible || !inStackSlot && node.visibleWhen != nil
    }

    /// Siblings slide into freed space when a child appears, disappears or resizes (Android's
    /// `animateContentSize`, #10442); nil keeps it instant under `motion: "none"` or Reduce Motion.
    private var sizeAnimation: Animation? {
        PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
            .containerSizeDuration.map { .easeInOut(duration: $0) }
    }

    private var layoutSignature: [String] {
        node.containerLayoutSignature(state: model.state) { model.holds($0) }
    }

    /// An anchored node is drawn by its window's anchor layer, never in its parent's slot.
    private var drawnHere: Bool {
        node.anchor == nil || anchorPlaced || presentedAsModal
    }

    private var isVisible: Bool {
        guard let condition = node.visibleWhen else { return true }
        return model.holds(condition)
    }

    /// Controls that run `onTap` from their own action, so the generic tap gesture stays off them.
    private var handlesOwnTap: Bool {
        [
            "switch", "checkbox", "button", "slider", "chip", "radioGroup", "listItem", "iconButton",
            "fab", "segmentedButton", "topAppBar", "timePicker", "datePicker", "dialog", "snackbar",
        ].contains(node.type)
    }

    /// Unstyled text and icons follow the theme's onSurface once the spec has a theme (Android's
    /// LocalContentColor); a themeless spec keeps the system primary colour.
    private var contentColor: Color {
        palette.themed ? palette.color(role: "onSurface").map { Color($0) } ?? .primary : .primary
    }

    /// `style` with every matching `styleWhen` entry merged over it.
    private var style: Style? { node.resolvedStyle(state: model.state) }

    @ViewBuilder private var content: some View {
        switch node.type {
        case "box":
            // Layered like a ZStack, but a row inside keeps the width it measured (#10899).
            PrototypeLayeredLayout(alignment: swiftUIAlignment(style?.alignment)) { children }
                .animation(sizeAnimation, value: layoutSignature)
        case "row":
            HStack(alignment: .center, spacing: style?.spacing ?? 0) { arranged(horizontal: true) }
                .animation(sizeAnimation, value: layoutSignature)
        case "column":
            VStack(alignment: .leading, spacing: style?.spacing ?? 0) { arranged(horizontal: false) }
                .animation(sizeAnimation, value: layoutSignature)
        case "text":
            textView
        case "image":
            imageView
        case "icon":
            // Decorative unless it has an authored description or is tappable; the decorative
            // case is a text glyph (see `PrototypeGlyph`) so no image element is exposed.
            iconView
        case "spacer":
            Color.clear.frame(width: 0, height: 0)
        case "textField":
            TextField(node.placeholder ?? "", text: model.binding(forStateKey: node.stateKey ?? ""))
                .textFieldStyle(.roundedBorder)
        case "switch":
            switchView
        case "checkbox":
            checkboxView
        case "button":
            buttonView
        case "scroll":
            ScrollView(node.axis == "horizontal" ? .horizontal : .vertical) {
                if let child = node.child { NodeView(node: child, model: model) }
            }
        case "pager":
            PagerView(node: node, model: model)
        case "tabBar", "bottomNav":
            navBar
        case "bottomSheet":
            sheet
        case "slider":
            PrototypeSliderView(node: node, model: model, style: style)
        case "chip":
            PrototypeChipView(node: node, model: model, style: style)
        case "card":
            PrototypeCardView(node: node, model: model, style: style)
        case "radioGroup":
            PrototypeRadioGroupView(node: node, model: model, style: style)
        case "listItem":
            PrototypeListItemView(node: node, model: model, style: style)
        case "iconButton":
            PrototypeIconButtonView(node: node, model: model, style: style)
        case "fab":
            PrototypeFabView(node: node, model: model, style: style)
        case "segmentedButton":
            PrototypeSegmentedButtonView(node: node, model: model)
        case "topAppBar":
            PrototypeTopAppBarView(node: node, model: model, style: style, title: interpolated(node.title))
        case "divider":
            PrototypeDividerView(node: node, style: style)
        case "badge":
            PrototypeBadgeView(text: interpolated(node.text), style: style, tagged: node.identifier != nil)
        case "progress":
            PrototypeProgressView(node: node, model: model)
        case "timePicker":
            PrototypeTimePickerView(node: node, model: model)
        case "datePicker":
            PrototypeDatePickerView(node: node, model: model)
        case "dialog":
            PrototypeDialogView(
                node: node,
                model: model,
                title: interpolated(node.title),
                text: node.text.map(interpolated)
            )
        case "snackbar":
            PrototypeSnackbarView(node: node, model: model, text: interpolated(node.text))
        default:
            EmptyView()
        }
    }

    @ViewBuilder private var children: some View {
        ForEach(node.drawnChildren(holds: model.holds), id: \.offset) { entry in
            NodeView(node: entry.node, model: model, inStackSlot: true)
        }
    }

    /// Start/center/end come from the frame alignment; only the space* modes need spacers, so a
    /// wrap-sized row or column does not grow to fill its parent.
    @ViewBuilder
    private func arranged(horizontal _: Bool) -> some View {
        let nodes = node.drawnChildren(holds: model.holds)
        let mode = style?.arrangement ?? "start"
        let outer = mode == "spaceAround" || mode == "spaceEvenly"
        if outer { Spacer(minLength: 0) }
        ForEach(Array(nodes.enumerated()), id: \.element.offset) { index, entry in
            if index > 0, mode.hasPrefix("space") { Spacer(minLength: 0) }
            NodeView(node: entry.node, model: model, inStackSlot: true)
        }
        if outer { Spacer(minLength: 0) }
    }

    private var pagerPosition: PagerPosition? {
        pager.map { PagerPosition(page: $0.page, count: $0.count) }
    }

    private var interpolatedText: String {
        interpolated(node.text)
    }

    private func interpolated(_ text: String?) -> String {
        interpolatePrototypeText(text ?? "", state: model.state, pager: pagerPosition)
    }

    @ViewBuilder private var iconView: some View {
        let symbol = sfSymbols[node.name ?? ""] ?? "questionmark.square"
        if accessibilityLabelOverride == nil {
            PrototypeGlyph(symbol: symbol)
                .font(.system(size: style?.textSize ?? 24))
                .foregroundColor(palette.color(style?.color) ?? contentColor)
        } else {
            Image(systemName: symbol)
                .font(.system(size: style?.textSize ?? 24))
                .foregroundColor(palette.color(style?.color) ?? contentColor)
        }
    }

    /// Text nodes already read their text, so only an authored description or a tappable icon's
    /// name needs to be applied explicitly.
    private var accessibilityLabelOverride: String? {
        guard node.contentDescription != nil || ["icon", "iconButton", "fab"].contains(node.type) else { return nil }
        return node.accessibilityLabel(
            state: model.state,
            pager: pagerPosition,
            tappable: node.onTap != nil
        )
    }

    private var textView: some View {
        let resolved = typography.resolve(style)
        let design: Font.Design = switch resolved.design {
        case .serif: .serif
        case .monospaced: .monospaced
        case .standard: .default
        }
        let weight: Font.Weight = switch resolved.weight {
        case ..<200: .ultraLight
        case ..<300: .thin
        case ..<400: .light
        case ..<500: .regular
        case ..<600: .medium
        case ..<700: .semibold
        case ..<800: .bold
        case ..<900: .heavy
        default: .black
        }
        let alignment: TextAlignment = switch style?.textAlign {
        case "center": .center
        case "end": .trailing
        default: .leading
        }
        // Scaled with Dynamic Type, unlike the Android bug #10436.
        let scaled = UIFontMetrics.default.scaledValue(for: resolved.size)
        var text = Text(interpolatedText)
            .font(.system(size: scaled, weight: weight, design: design))
        if style?.fontStyle == "italic" { text = text.italic() }
        let decoration = style?.textDecoration
        if decoration == "underline" || decoration == "underlineLineThrough" { text = text.underline() }
        if decoration == "lineThrough" || decoration == "underlineLineThrough" { text = text.strikethrough() }
        return text
            .tracking(resolved.letterSpacing)
            .lineSpacing(max(0, (resolved.lineHeight.map { $0 * scaled / resolved.size } ?? scaled) - scaled))
            .foregroundColor(palette.color(style?.color) ?? contentColor)
            .multilineTextAlignment(alignment)
            .lineLimit(style?.maxLines)
            .truncationMode(.tail)
    }

    @ViewBuilder private var imageView: some View {
        if let id = node.asset, let image = model.assets[id] {
            let resizable = Image(uiImage: image).resizable()
            switch node.contentScale {
            case "crop": resizable.aspectRatio(contentMode: .fill).clipped()
            case "fill": resizable
            default: resizable.aspectRatio(contentMode: .fit)
            }
        } else {
            Rectangle().fill(palette.placeholderFill.map { Color($0) } ?? Color.gray.opacity(0.3))
                .overlay(
                    Image(systemName: "photo")
                        .foregroundColor(palette.placeholderGlyph.map { Color($0) } ?? .secondary)
                )
        }
    }

    // MARK: Controls

    private var isOn: Bool {
        model.state[node.stateKey ?? ""]?.boolValue ?? false
    }

    private func toggleBound() {
        guard let key = node.stateKey else { return }
        model.toggle(key, then: node.onTap ?? [])
    }

    /// One element per switch, shaped exactly like a list row with a trailing switch: the button
    /// is the element, named by its label text, with the toggle trait and an on/off value. The
    /// track is drawn in SwiftUI; a `Toggle` hosts a `UISwitch` whose own elements XCUITest listed
    /// beside the combined one. `accessibilityElement(children: .ignore)` on the button wrapped it
    /// in a second element: XCUITest listed the button (tappable, untagged) and the wrapper (the
    /// testTag, label and value, not tappable) at the same bounds (#10899).
    private var switchView: some View {
        Button(action: toggleBound) {
            HStack(spacing: 8) {
                if let label = node.label {
                    Text(label).frame(maxWidth: .infinity, alignment: .leading)
                }
                PrototypeSwitchTrack(isOn: isOn)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isOn ? "1" : "0")
        .accessibilityAddTraits(.isToggle)
    }

    /// iOS has no checkbox control: a button whose checked square reads as selected.
    private var checkboxView: some View {
        Button(action: toggleBound) {
            HStack(spacing: 8) {
                PrototypeGlyph(symbol: isOn ? "checkmark.square.fill" : "square")
                if let label = node.label { Text(label) }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isOn ? "checked" : "unchecked")
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    /// Filled (default), tonal, elevated, outlined or text, with an optional leading icon.
    @ViewBuilder private var buttonView: some View {
        let button = Button { model.run(node.onTap ?? []) } label: {
            if let icon = node.icon {
                // The icon is decoration: a hidden glyph, so the button is one element named by
                // its label rather than also exposing the icon's name (#10899).
                HStack(spacing: 6) {
                    PrototypeGlyph(symbol: prototypeSymbol(icon))
                    buttonLabel
                }
            } else {
                buttonLabel
            }
        }
        .accessibilityLabel(node.label ?? "")
        // A button claims its label's width before its siblings shrink, so a tight row never cuts
        // "Save" to "Sa..." (#10899); a label wider than the row wraps rather than overflowing,
        // as on Android (#10912).
        .layoutPriority(1)
        switch node.variant {
        case "outlined", "tonal": button.buttonStyle(.bordered)
        case "elevated": button.buttonStyle(.bordered).shadow(color: .black.opacity(0.2), radius: 2, y: 1)
        case "text": button.buttonStyle(.borderless)
        default: button.buttonStyle(.borderedProminent)
        }
    }

    /// Wraps onto more lines when the row is narrower than the label, never truncating.
    private var buttonLabel: some View {
        Text(node.label ?? "")
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var navSelection: Int {
        if let pagerId = node.pager { return model.pages[pagerId] ?? 0 }
        if let key = node.stateKey { return model.state[key]?.intValue ?? 0 }
        return 0
    }

    private var navBar: some View {
        let items = node.items ?? []
        return HStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                Button {
                    model.select(index: index, pager: node.pager, key: node.stateKey, then: node.onTap ?? [])
                } label: {
                    VStack(spacing: 2) {
                        if let icon = item.icon {
                            PrototypeGlyph(symbol: sfSymbols[icon] ?? "circle")
                        }
                        Text(item.label).font(.caption)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundColor(navForeground(selected: index == navSelection))
                    .background(
                        Capsule().fill(
                            index == navSelection ? palette.navIndicator.map { Color($0) } ?? .clear : .clear
                        )
                    )
                }
                .accessibilityAddTraits(index == navSelection ? .isSelected : [])
            }
        }
    }

    /// A nav item's colour: the palette's role pair when themed, else the system accent and secondary.
    private func navForeground(selected: Bool) -> Color {
        if selected { return palette.navSelected.map { Color($0) } ?? .accentColor }
        return palette.navUnselected.map { Color($0) } ?? .secondary
    }

    /// Opens at its first detent. Dragging between detents and swipe-to-dismiss are not
    /// prototyped on iOS yet.
    @ViewBuilder private var sheet: some View {
        let open = node.openWhen.map(model.holds) ?? false
        if open, let child = node.child {
            GeometryReader { proxy in
                VStack(spacing: 8) {
                    if node.dragHandle ?? true {
                        Capsule().fill(palette.sheetHandle.map { Color($0) } ?? Color.secondary.opacity(0.5)).frame(
                            width: 36,
                            height: 5
                        ).padding(.top, 6)
                    }
                    NodeView(node: child, model: model)
                }
                .frame(maxWidth: .infinity)
                .frame(height: node.detents?.first.map { detent in
                    CGFloat(detent.height(in: Double(proxy.size.height)))
                })
                .background(palette.sheetSurface.map { Color($0) } ?? Color(UIColor.systemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .frame(maxHeight: .infinity, alignment: .bottom)
            }
        }
    }

    // MARK: Style

    private var cornerShape: UnevenRoundedRectangle {
        switch style?.cornerRadius.map(shapes.resolve) {
        case let .uniform(radius)?:
            UnevenRoundedRectangle(cornerRadii: RectangleCornerRadii(
                topLeading: radius, bottomLeading: radius, bottomTrailing: radius, topTrailing: radius
            ))
        case .token?:
            UnevenRoundedRectangle(cornerRadii: RectangleCornerRadii())
        case let .corners(topStart, topEnd, bottomEnd, bottomStart)?:
            UnevenRoundedRectangle(cornerRadii: RectangleCornerRadii(
                topLeading: topStart, bottomLeading: bottomStart, bottomTrailing: bottomEnd, topTrailing: topEnd
            ))
        case nil:
            UnevenRoundedRectangle(cornerRadii: RectangleCornerRadii())
        }
    }

    private func styled(_ view: some View) -> some View {
        let padding = style?.padding
        let insets = safeAreaEdges
        let shape = cornerShape
        return view
            .padding(EdgeInsets(
                top: (padding?.top ?? 0) + insets.top,
                leading: (padding?.start ?? 0) + insets.left,
                bottom: (padding?.bottom ?? 0) + insets.bottom,
                trailing: (padding?.end ?? 0) + insets.right
            ))
            .modifier(SizeModifier(
                width: coverSize.map { .points($0.width) } ?? style?.width,
                height: coverSize.map { .points($0.height) } ?? style?.height,
                alignment: contentAlignment,
                fillsByDefault: node.type == "spacer"
            ))
            .background(palette.color(style?.background) ?? .clear)
            .clipShape(shape)
            .overlay(
                shape.stroke(palette.color(style?.border?.color) ?? .clear, lineWidth: style?.border?.width ?? 0)
            )
            .shadow(
                color: (style?.elevation ?? 0) > 0 ? palette.color(style?.shadowColor) ?? .black.opacity(0.25) : .clear,
                radius: style?.elevation ?? 0
            )
            .offset(x: style?.offset?.x ?? 0, y: style?.offset?.y ?? 0)
            .opacity(style?.alpha ?? 1)
            .modifier(TapModifier(actions: handlesOwnTap ? nil : node.onTap, model: model, style: style))
            .modifier(IdentifierModifier(
                identifier: node.testTag ?? node.id,
                label: accessibilityLabelOverride,
                grouping: grouping
            ))
    }

    /// Containers get their own accessibility element so a testTag names the container instead of
    /// being copied onto every descendant. A tappable container reads as one button.
    private var grouping: AccessibilityGrouping {
        // Composite controls always contain their parts, so each part keeps its own
        // `<tag>.<part>` identifier, label and selected state.
        if ["radioGroup", "segmentedButton", "topAppBar", "dialog", "snackbar"].contains(node.type) {
            return .contain
        }
        guard ["box", "row", "column", "scroll", "pager", "card"].contains(node.type) else { return .leaf }
        return node.onTap == nil ? .contain : .combine
    }

    private var contentAlignment: Alignment {
        switch node.type {
        case "row":
            switch style?.arrangement {
            case "center": return .center
            case "end": return .trailing
            default: return .leading
            }
        case "column":
            switch style?.arrangement {
            case "center": return .leading
            case "end": return .bottomLeading
            default: return .topLeading
            }
        case "box": return swiftUIAlignment(style?.alignment)
        default: return .center
        }
    }

    private var safeAreaEdges: UIEdgeInsets {
        guard let edges = node.safeAreaPadding?.edges else { return .zero }
        let all = model.contentSafeInsets
        return UIEdgeInsets(
            top: edges.contains("top") ? all.top : 0,
            left: edges.contains("start") ? all.left : 0,
            bottom: edges.contains("bottom") ? all.bottom : 0,
            right: edges.contains("end") ? all.right : 0
        )
    }
}

private struct SizeModifier: ViewModifier {
    let width: Dimension?
    let height: Dimension?
    let alignment: Alignment
    let fillsByDefault: Bool

    func body(content: Content) -> some View {
        // Not `frame(maxWidth: nil, maxHeight: nil)`: see `PrototypeLayeredLayout` (#10899).
        PrototypeLayeredLayout(fillsWidth: fills(width), fillsHeight: fills(height), alignment: alignment) {
            content.frame(width: fixed(width), height: fixed(height), alignment: alignment)
        }
    }

    private func fixed(_ dimension: Dimension?) -> CGFloat? {
        if case let .points(value) = dimension { return value }
        return nil
    }

    private func fills(_ dimension: Dimension?) -> Bool {
        if case .fill = dimension { return true }
        return dimension == nil && fillsByDefault
    }
}

private struct TapModifier: ViewModifier {
    let actions: [PrototypeAction]?
    let model: PrototypeModel
    let style: Style?

    @GestureState private var pressed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if let actions {
            let scale = style?.scale(pressed: pressed) ?? 1
            // Spec `motion: "none"` snaps like Reduce Motion (#10885).
            let spring = PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
                .pressScaleDuration.map { Animation.spring(duration: $0) }
            // Whole padded frame is tappable, with a 44 pt minimum target (Android bug #10435).
            content
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                // Scales the drawn node only; motion off snaps instead of springing.
                .scaleEffect(scale)
                .animation(spring, value: scale)
                .onTapGesture { model.run(actions) }
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0, maximumDistance: 10)
                        .updating($pressed) { _, state, _ in state = true }
                )
                .accessibilityAddTraits(.isButton)
        } else {
            content
        }
    }
}

enum AccessibilityGrouping {
    case leaf
    case contain
    case combine
}

private struct IdentifierModifier: ViewModifier {
    let identifier: String?
    let label: String?
    let grouping: AccessibilityGrouping

    func body(content: Content) -> some View {
        labelled(identified(content))
    }

    /// A label needs its own accessibility element: on a bare container SwiftUI would spread it
    /// over the children.
    @ViewBuilder
    private func identified(_ content: Content) -> some View {
        if identifier == nil, label == nil || grouping == .leaf {
            content
        } else if let identifier {
            grouped(content).accessibilityIdentifier(identifier)
        } else {
            grouped(content)
        }
    }

    @ViewBuilder
    private func grouped(_ content: Content) -> some View {
        switch grouping {
        case .leaf: content
        case .contain: content.accessibilityElement(children: .contain)
        case .combine: content.accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func labelled(_ content: some View) -> some View {
        if let label {
            content.accessibilityLabel(label)
        } else {
            content
        }
    }
}

/// Fill-sized pagers swipe with a paged TabView; wrap-sized ones show the current page and
/// change pages with a horizontal drag, since a TabView has no intrinsic size.
struct PagerView: View {
    let node: PrototypeNode
    @ObservedObject var model: PrototypeModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var pagerId: String { node.id ?? "" }
    private var pages: [PrototypeNode] { node.children ?? [] }

    private var selection: Binding<Int> {
        Binding(
            get: { model.pages[pagerId] ?? 0 },
            set: { model.setPage(pagerId, $0) }
        )
    }

    /// Page changes animate unless spec `motion: "none"` or Reduce Motion is on (#10442).
    private var pageAnimation: Animation? {
        PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).enabled
            ? .easeInOut(duration: 0.25) : nil
    }

    private var fills: Bool {
        if case .fill = node.resolvedStyle(state: model.state)?.height { return true }
        return false
    }

    var body: some View {
        if fills {
            TabView(selection: selection) {
                ForEach(Array(pages.enumerated()), id: \.offset) { index, page in
                    NodeView(node: page, model: model)
                        .environment(\.pagerContext, PagerContext(page: index, count: pages.count))
                        // Each page is hosted in its own cell that re-applies the safe area.
                        .ignoresSafeArea()
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .animation(pageAnimation, value: selection.wrappedValue)
            // Pages own the safe area themselves (safeAreaPadding), as on Android.
            .ignoresSafeArea()
        } else {
            let index = min(selection.wrappedValue, max(pages.count - 1, 0))
            if pages.indices.contains(index) {
                NodeView(node: pages[index], model: model)
                    .environment(\.pagerContext, PagerContext(page: index, count: pages.count))
                    .id(index)
                    .transition(.opacity)
                    .gesture(DragGesture(minimumDistance: 24).onEnded { value in
                        if value.translation.width < -40 { model.setPage(pagerId, index + 1) }
                        if value.translation.width > 40 { model.setPage(pagerId, index - 1) }
                    })
                    .animation(pageAnimation, value: index)
            }
        }
    }
}

extension PrototypeVisibilityTransition {
    /// The SwiftUI insertion/removal for a `visibleWhen` node; `expand` grows from the top edge.
    var swiftUITransition: AnyTransition {
        switch self {
        case .instant: .identity
        case .fade: .opacity
        case .expand: .scale(scale: 0.01, anchor: .top).combined(with: .opacity)
        case .slide: .move(edge: .top).combined(with: .opacity)
        case .standard: .scale(scale: 0.01, anchor: .top).combined(with: .opacity)
        }
    }
}
