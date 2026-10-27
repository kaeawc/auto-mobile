#if canImport(UIKit)
    import Accessibility
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

        /// A spec colour slot, resolved for this palette's light or dark mode.
        func color(_ spec: PrototypeModeValue?) -> Color? {
            resolve(spec).map { Color($0) }
        }
    }

    /// `style.gradient`, sized to the node: the line and radius depend on the measured box, as on
    /// Android (`PrototypeGradient.linearLine`, `radialRadius`).
    @MainActor
    struct PrototypeGradientFill: View {
        let gradient: PrototypeGradient
        let palette: PrototypePalette

        func paint(in size: CGSize) -> AnyShapeStyle {
            let width = Double(size.width)
            let height = Double(size.height)
            let stops = gradient.colorStops(palette: palette).map {
                Gradient.Stop(color: Color($0.color), location: CGFloat($0.location))
            }
            switch gradient {
            case let .linear(angle, _):
                let line = PrototypeGradient.linearLine(angle: angle, width: width, height: height)
                return AnyShapeStyle(LinearGradient(
                    stops: stops,
                    startPoint: UnitPoint(x: line.start.x, y: line.start.y),
                    endPoint: UnitPoint(x: line.end.x, y: line.end.y)
                ))
            case .radial:
                return AnyShapeStyle(RadialGradient(
                    stops: stops, center: .center, startRadius: 0,
                    endRadius: CGFloat(PrototypeGradient.radialRadius(width: width, height: height))
                ))
            }
        }

        var body: some View {
            GeometryReader { proxy in
                Rectangle().fill(paint(in: proxy.size))
            }
            .accessibilityHidden(true)
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

    /// A contract name without an SF equivalent uses the shared placeholder; unknown names draw no glyph.
    @MainActor
    func prototypeSymbol(_ name: String?, variant: String? = nil) -> String? {
        PrototypeIconSymbolTable.shared.symbolName(for: name, variant: variant) {
            PrototypeSymbolAvailability.isAvailable($0)
        }
    }

    /// UIKit lookups are cached on the renderer's main actor, including failed lookups.
    @MainActor
    private enum PrototypeSymbolAvailability {
        private static var symbols: [String: Bool] = [:]

        static func isAvailable(_ symbol: String) -> Bool {
            if let cached = symbols[symbol] { return cached }
            let available = UIImage(systemName: symbol) != nil
            symbols[symbol] = available
            return available
        }
    }

    private struct PrototypeSharedNamespaceKey: EnvironmentKey {
        static let defaultValue: Namespace.ID? = nil
    }

    extension EnvironmentValues {
        var prototypeSharedNamespace: Namespace.ID? {
            get { self[PrototypeSharedNamespaceKey.self] }
            set { self[PrototypeSharedNamespaceKey.self] = newValue }
        }
    }

    @MainActor
    struct NodeView: View {
        let node: PrototypeNode
        let model: PrototypeModel
        /// Dialogs and snackbars draw nothing in place; `PrototypeModalLayer` draws them with this set.
        var presentedAsModal = false
        /// Anchored nodes draw nothing in place; `PrototypeAnchorLayer` draws them with this set (#10803).
        var anchorPlaced = false
        /// A `cover` anchor's size, which replaces the authored width and height.
        var coverSize: CGSize?
        /// Set by a parent that lays its children out through `PrototypeNode.drawnChildren`.
        var inStackSlot = false
        /// The main axis of the row or column laying this node out, so a `weight` knows what it fills.
        var stackAxis: PrototypeAxis?
        @Environment(\.prototypeSharedNamespace) private var sharedNamespace
        @FocusState private var controlFocused: Bool
        @Environment(\.pagerContext) private var pager
        @Environment(\.locale) private var deviceLocale
        @Environment(\.prototypePalette) private var palette
        @Environment(\.prototypeTypography) private var typography
        @Environment(\.prototypeShapes) private var shapes
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            if let key = node.repeatKey {
                contentBody.id(PrototypeScrollTarget.key(key))
            } else {
                contentBody
            }
        }

        @ViewBuilder private var contentBody: some View {
            // A node that draws nothing here (hidden, anchored elsewhere, a modal not yet in its layer)
            // returns no view at all: a stack puts its spacing around an empty ZStack too, which left
            // a gap Android does not (#10912). Container parents also leave such children out.
            if !drawsNow || barHidden {
                EmptyView()
            } else if inStackSlot || node.visibleWhen == nil {
                // A parent that lays children out through `drawnChildren` inserts and removes this node
                // itself, inside its own `.animation(value: layoutSignature)`, so the transition rides
                // on the node and the parent drives the animation. No wrapping ZStack: a ZStack places
                // its child at the size it measured, and a row re-laid out at exactly its ideal width
                // shares that width out evenly, cutting "Edit"/"Save" short (#10899).
                sharedContent.modifier(PrototypeScrollMotionModifier(node: node, model: model))
                    .transition(visibilityTransition)
            } else {
                // Parents without that filter (a root, a scroll child, a pager page): the conditional
                // lives in a stable container so the insertion/removal has one whose animation is
                // driven by `isVisible`; a bare `Group` is flattened into the parent's children, which
                // left a trailing conditional child undrawn and its transition un-animated (#10898).
                // The container passes its parent's proposal through, unlike a ZStack (see above).
                PrototypeLayeredLayout(alignment: .topLeading) {
                    if isVisible {
                        sharedContent.modifier(PrototypeScrollMotionModifier(node: node, model: model))
                            .transition(visibilityTransition)
                    }
                }
                .animation(transition == .instant ? nil : .easeInOut(duration: 0.25), value: isVisible)
            }
        }

        @ViewBuilder private var barContent: some View {
            if ["bottomNav", "tabBar"].contains(node.type), node.onScroll == "hide" {
                validatedContent.modifier(PrototypeBarSlide(fraction: barFraction))
            } else {
                validatedContent
            }
        }

        private var barFraction: Double {
            model.barScroll(node).collapse(
                node.onScroll,
                extent: PrototypeBarScrollState.extent(variant: node.variant, behavior: node.onScroll),
                reduced: !PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).spatial
            )
        }

        private var barHidden: Bool {
            (
                (["bottomNav", "tabBar"].contains(node.type) && node.onScroll == "hide") ||
                    (node.type == "topAppBar" && node.onScroll == "enterAlways")
            ) && barFraction >= 1
        }

        @ViewBuilder private var sharedContent: some View {
            let plan = sharedPlan
            if plan.apply, let key = plan.key, let sharedNamespace {
                barContent.matchedGeometryEffect(
                    id: key,
                    in: sharedNamespace,
                    properties: .frame,
                    isSource: isVisible
                )
            } else {
                barContent.modifier(PrototypeZoomSourceModifier(key: node.resolvedSharedKey))
            }
        }

        private var sharedPlan: PrototypeSharedElementPlan {
            let motion = PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
            return PrototypeSharedElementPlan(
                node: node, profile: motion.profile,
                conflictingKeys: node.resolvedSharedKey == nil || !motion.spatial ? [] : sharedConflicts
            )
        }

        private var sharedConflicts: Set<String> {
            guard let root = model.spec?.root else { return [] }
            return PrototypeSharedElementPlan.conflictingKeys(in: root, holds: model.holds)
        }

        private var visibilityTransition: AnyTransition {
            let motion = PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
            // Explicit transition animation fades filtered children even when parent layout snaps.
            let plan = sharedPlan
            if node.shared != nil, plan.apply { return plan.crossfade ? .opacity : .identity }
            return motion.fadeOnly && transition != .instant
                ? transition.swiftUITransition.animation(.easeInOut(duration: 0.25))
                : transition.swiftUITransition
        }

        @ViewBuilder private var validatedContent: some View {
            if node.checks?.isEmpty == false || node.errorWhen != nil {
                VStack(alignment: .leading, spacing: 4) {
                    checkedControl
                    if let message = model.shownError(node) {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier(node.partIdentifier("error") ?? "")
                    }
                }
            } else if let swipe = node.swipeActions {
                PrototypeSwipeRowView(node: node, swipe: swipe, model: model) {
                    styled(content).disabled(!model.isEnabled(node))
                }
            } else {
                styled(content).disabled(!model.isEnabled(node))
            }
        }

        @ViewBuilder private var checkedControl: some View {
            if node.type == "textField" {
                // Text fields own focus while preserving drafts; their view reports the blur.
                styled(content).disabled(!model.isEnabled(node))
            } else {
                styled(content)
                    .disabled(!model.isEnabled(node))
                    .focused($controlFocused)
                    .onChange(of: controlFocused) { oldValue, value in
                        if oldValue, !value { model.blur(node) }
                    }
            }
        }

        /// `visibleWhen` uses the node's `transition` (the default for stacks); instant when motion is
        /// off for spec `motion: "none"`; reduced motion preserves fades (#10442).
        private var transition: PrototypeVisibilityTransition {
            let motion = PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
            return node.visibleWhen == nil ? .instant : motion.visibility(
                transition: node.transition,
                nodeType: node.type,
                shared: node.resolvedSharedKey != nil
            )
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
            node.containerLayoutSignature(state: model.state, stacks: model.stacks) { model.holds($0) }
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
                "fab", "segmentedButton", "topAppBar", "timePicker", "datePicker", "dialog", "snackbar", "searchBar",
                "menu", "tooltip",
                "select",
            ].contains(node.type)
        }

        /// Unstyled text and icons follow the theme's onSurface once the spec has a theme (Android's
        /// LocalContentColor); a themeless spec keeps the system primary colour.
        private var contentColor: Color {
            palette.themed ? palette.color(role: "onSurface").map { Color($0) } ?? .primary : .primary
        }

        /// `style` with every matching `styleWhen` entry merged over it.
        private var style: Style? { node.resolvedStyle(state: model.state) }

        private var keyframeTrigger: JSONValue? {
            let trigger = node.keyframes?.objectFields?["trigger"]?.objectFields
            if let key = trigger?["key"]?.stringValue { return model.state[key] }
            if let pointer = trigger?["data"]?.stringValue {
                return PrototypeDataPointer.resolve(model.spec?.data, pointer: pointer)
            }
            return nil
        }

        @ViewBuilder private var content: some View {
            switch node.type {
            case "box":
                // Layered like a ZStack, but a row inside keeps the width it measured (#10899).
                PrototypeLayeredLayout(alignment: swiftUIAlignment(style?.alignment)) { children }
                    .animation(sizeAnimation, value: layoutSignature)
            case "row":
                if hasWeightedChild {
                    weightedStack(axis: .horizontal)
                } else {
                    HStack(alignment: .center, spacing: style?.spacing ?? 0) { arranged(horizontal: true) }
                        .animation(sizeAnimation, value: layoutSignature)
                }
            case "column":
                if hasWeightedChild {
                    weightedStack(axis: .vertical)
                } else {
                    VStack(alignment: .leading, spacing: style?.spacing ?? 0) { arranged(horizontal: false) }
                        .animation(sizeAnimation, value: layoutSignature)
                }
            case "flow":
                PrototypeFlowLayout(
                    spacing: style?.spacing ?? 0, runSpacing: style?.runSpacing ?? 0, maxLines: node.maxLines
                ) { children }
                    .clipped()
                    .animation(sizeAnimation, value: layoutSignature)
            case "carousel":
                PrototypeCarouselView(node: node, model: model)
            case "grid":
                PrototypeGridLayout(
                    columns: node.columns ?? .fixed(1), spacing: style?.spacing ?? 0, runSpacing: style?.runSpacing
                ) {
                    ForEach(node.drawnChildren(holds: model.holds), id: \.offset) { entry in
                        NodeView(node: entry.node, model: model, inStackSlot: true)
                            .layoutValue(key: PrototypeGridSpanKey.self, value: entry.node.span ?? 1)
                    }
                }
                .animation(sizeAnimation, value: layoutSignature)
            case "text":
                textView
            case "image":
                imageView.modifier(PrototypeImageFilterModifier(
                    parameters: PrototypeImageFilter(node.filter, palette: palette)
                ))
            case "icon":
                // Decorative unless it has an authored description or is tappable; the decorative
                // case is a text glyph (see `PrototypeGlyph`) so no image element is exposed.
                iconView
            case "spacer":
                Color.clear.frame(width: 0, height: 0)
            case "searchBar":
                PrototypeSearchBarView(node: node, model: model, style: style)
            case "textField":
                PrototypeTextFieldView(node: node, model: model)
            case "switch":
                switchView
            case "checkbox":
                checkboxView
            case "pasteButton":
                PasteButton(payloadType: String.self) { values in
                    if let into = node.into { model.paste(values.first ?? "", into: into) }
                }
            case "button":
                buttonView
            case "list":
                // A replacing show resets list state; stack pushes/pops keep this identity.
                PrototypeLazyListView(node: node, model: model).id(model.showRevision)
            case "scroll":
                if node.axis != "horizontal", let refresh = node.refresh {
                    PrototypeRefreshableScroll(node: node, refresh: refresh, model: model)
                } else {
                    PrototypeChatScrollView(node: node, model: model)
                }
            case "stack":
                PrototypeZoomStackHost(node: node, model: model)
            case "pager":
                PagerView(node: node, model: model)
            case "tabBar", "bottomNav":
                navBar
                    .modifier(PrototypeBarClip(fraction: node.onScroll == "hide" ? barFraction : 0))
            case "bottomSheet":
                sheet
            case "slider":
                PrototypeSliderView(node: node, model: model, style: style)
            case "chip":
                PrototypeChipView(node: node, model: model, style: style)
            case "card":
                PrototypeCardView(node: node, model: model, style: style, cornerRadius: cardCornerRadius)
            case "radioGroup":
                PrototypeRadioGroupView(node: node, model: model, style: style)
            case "listItem":
                PrototypeListItemView(node: node, model: model, style: style)
            case "iconButton":
                PrototypeIconButtonView(node: node, model: model, style: style)
            case "fab":
                PrototypeFabView(
                    node: node,
                    model: model,
                    style: style,
                    label: node.plainText(state: model.state, pager: pagerPosition, derived: derivedContext)
                )
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
            case "chart":
                PrototypeChartView(node: node, model: model)
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
            // These bodies are reached only from the hoisted modal layer.
            case "tooltip":
                PrototypeTooltipBubble(node: node, model: model)
            case "drawer":
                if let child = node.child { NodeView(node: child, model: model) }
            case "menu":
                PrototypeMenuView(node: node, model: model)
            case "select":
                PrototypeSelectView(node: node, model: model)
            case "snackbar":
                PrototypeSnackbarView(node: node, model: model, text: interpolated(node.text))
            default:
                EmptyView()
            }
        }

        @ViewBuilder private var children: some View {
            ForEach(node.drawnChildren(holds: model.holds, stacks: model.stacks), id: \.offset) { entry in
                NodeView(node: entry.node, model: model, inStackSlot: true)
            }
        }

        /// A child's `weight` under the current state.
        private func weight(of child: PrototypeNode) -> Double? {
            child.resolvedStyle(state: model.state)?.weight
        }

        private var hasWeightedChild: Bool {
            node.drawnChildren(holds: model.holds, stacks: model.stacks).contains { weight(of: $0.node) != nil }
        }

        /// A row or column whose children share the main axis by `weight` (Android's `Modifier.weight`):
        /// see `PrototypeWeightedStack`. It adds no arrangement spacers: a weight takes the free space.
        private func weightedStack(axis: PrototypeAxis) -> some View {
            PrototypeWeightedStackLayout(axis: axis, spacing: style?.spacing ?? 0) {
                ForEach(node.drawnChildren(holds: model.holds, stacks: model.stacks), id: \.offset) { entry in
                    NodeView(node: entry.node, model: model, inStackSlot: true, stackAxis: axis)
                        .layoutValue(key: PrototypeWeightKey.self, value: weight(of: entry.node))
                }
            }
            .animation(sizeAnimation, value: layoutSignature)
        }

        /// Start/center/end come from the frame alignment; only the space* modes need spacers, so a
        /// wrap-sized row or column does not grow to fill its parent.
        @ViewBuilder
        private func arranged(horizontal _: Bool) -> some View {
            let nodes = node.drawnChildren(holds: model.holds, stacks: model.stacks)
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

        private var derivedContext: PrototypeDerivedContext {
            // Reading SwiftUI's locale invalidates this view on a device language change.
            _ = deviceLocale
            return PrototypeDerivedContext(entries: model.spec?.derive ?? [:], data: model.spec?.data)
        }

        private func interpolated(_ text: String?) -> String {
            interpolatePrototypeText(text ?? "", state: model.state, pager: pagerPosition, derived: derivedContext)
        }

        @ViewBuilder private var iconView: some View {
            if let effect = node.effect {
                let value = effect.trigger?.key.flatMap { model.state[$0] }
                    ?? effect.trigger?.data.flatMap { PrototypeDataPointer.resolve(model.spec?.data, pointer: $0) }
                PrototypeIconEffectView(
                    activity: model.iconMotionActivity,
                    effect: effect,
                    value: value,
                    name: node.name ?? "",
                    profile: PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).profile
                ) {
                    plainIconView
                }
            } else { plainIconView }
        }

        @ViewBuilder private var plainIconView: some View {
            if let symbol = prototypeSymbol(node.name, variant: node.variant) {
                if accessibilityLabelOverride == nil {
                    PrototypeGlyph(symbol: symbol)
                        .font(.system(size: style?.textSize ?? 24))
                        .foregroundColor(palette.color(style?.color) ?? contentColor)
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: style?.textSize ?? 24))
                        .foregroundColor(palette.color(style?.color) ?? contentColor)
                }
            } else {
                Rectangle()
                    .fill(
                        style?.background == nil
                            ? palette.placeholderFill.map { Color($0) } ?? Color.gray.opacity(0.3)
                            : .clear
                    )
                    .frame(idealWidth: 24, idealHeight: 24)
                    .fixedSize(horizontal: style?.width == nil, vertical: style?.height == nil)
                    .accessibilityHidden(accessibilityLabelOverride == nil && node.semantics == nil)
                    .accessibilityAddTraits(accessibilityLabelOverride == nil ? [] : .isImage)
            }
        }

        /// Text nodes already read their text, so only an authored description or a tappable icon's
        /// name needs to be applied explicitly.
        private var accessibilityLabelOverride: String? {
            // A chart reads its summary, unless an authored description wins (#14679).
            if node.type == "chart",
               node.semantics?.label == nil { return node.chartLabel(data: model.spec?.data, state: model.state) }
            guard node.semantics?.label != nil || node.contentDescription != nil || ["icon", "iconButton", "fab"]
                .contains(node.type)
            else { return nil }
            return node.accessibilityLabel(
                state: model.state,
                pager: pagerPosition,
                tappable: node.isInteractive,
                derived: derivedContext
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
            let font: Font
            if let id = resolved.fontAsset, let face = model.fontFaces[id] {
                font = .custom(face, fixedSize: scaled).weight(weight)
            } else {
                font = .system(size: scaled, weight: weight, design: design)
            }
            let runs = PrototypeRichText.runs(
                node: node, state: model.state, pager: pagerPosition, nodeKey: node.id ?? "text",
                derived: derivedContext
            )
            var text = (runs.map { Text(attributedText($0)) } ?? Text(interpolatedText)).font(font)
            if runs == nil, style?.fontStyle == "italic" { text = text.italic() }
            let decoration = style?.textDecoration
            if runs == nil,
               decoration == "underline" || decoration == "underlineLineThrough" { text = text.underline() }
            if runs == nil,
               decoration == "lineThrough" || decoration == "underlineLineThrough" { text = text.strikethrough() }
            if runs == nil { text = text.tracking(resolved.letterSpacing) }
            return text
                .lineSpacing(max(0, (resolved.lineHeight.map { $0 * scaled / resolved.size } ?? scaled) - scaled))
                .foregroundColor(palette.color(style?.color) ?? contentColor)
                .multilineTextAlignment(alignment)
                .lineLimit(style?.maxLines)
                .truncationMode(.tail)
                .modifier(PrototypeContentTransitionModifier(
                    text: node.plainText(state: model.state, pager: pagerPosition),
                    mode: node.contentTransition, rich: node.spans != nil,
                    motion: PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
                ))
                .modifier(SpanLinksModifier(runs: runs, model: model))
        }

        private func spanWeight(_ value: Int) -> Font.Weight {
            switch value {
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
        }

        /// The core supplies plain values; only this layer knows SwiftUI attribute types.
        private func attributedText(_ runs: [PrototypeTextRun]) -> AttributedString {
            let resolved = typography.resolve(style)
            var result = AttributedString()
            for run in runs {
                let authored = run.style
                var part = AttributedString(run.text)
                // Explicit even for an unstyled link, so SwiftUI's link tint cannot replace the text colour.
                part.foregroundColor = palette.color(authored?.color) ?? palette.color(style?.color) ?? contentColor
                part.backgroundColor = palette.color(authored?.background)
                let design: Font.Design = switch authored?.fontFamily {
                case .keyword("serif")?: .serif
                case .keyword("monospace")?: .monospaced
                case .some: .default // Uploaded fonts fall back exactly like node text.
                case nil:
                    switch resolved.design {
                    case .serif: .serif
                    case .monospaced: .monospaced
                    case .standard: .default
                    }
                }
                let weight = spanWeight(authored?.fontWeight ?? resolved.weight)
                let size = UIFontMetrics.default.scaledValue(for: authored?.textSize ?? resolved.size)
                var font = Font.system(size: size, weight: weight, design: design)
                if (authored?.fontStyle ?? style?.fontStyle) == "italic" { font = font.italic() }
                part.font = font
                part.tracking = CGFloat(authored?.letterSpacing ?? resolved.letterSpacing)
                let decoration = authored?.textDecoration ?? style?.textDecoration
                part.underlineStyle = (decoration == "underline" || decoration == "underlineLineThrough") ? Text
                    .LineStyle(pattern: .solid) : nil
                part.strikethroughStyle = (decoration == "lineThrough" || decoration == "underlineLineThrough") ? Text
                    .LineStyle(pattern: .solid) : nil
                part.link = run.link
                result.append(part)
            }
            return result
        }

        @ViewBuilder private var imageView: some View {
            if let id = palette.asset(node.asset), let image = model.assets[id] {
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
            let button = Button { model.activate(.node(node)) } label: {
                if let symbol = prototypeSymbol(node.icon) {
                    // The icon is decoration: a hidden glyph, so the button is one element named by
                    // its label rather than also exposing the icon's name (#10899).
                    HStack(spacing: 6) {
                        PrototypeGlyph(symbol: symbol)
                        buttonLabel
                    }
                } else {
                    buttonLabel
                }
            }
            .accessibilityLabel(node.plainText(state: model.state, pager: pagerPosition, derived: derivedContext))
            // A button claims its label's width before its siblings shrink, so a tight row never cuts
            // "Save" to "Sa..." (#10899); a label wider than the row wraps rather than overflowing,
            // as on Android (#10912).
            .layoutPriority(1)
            switch node.variant {
            case "outlined", "tonal": button.buttonStyle(.bordered).tint(themePrimary)
            case "elevated": button.buttonStyle(.bordered).tint(themePrimary)
                .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
            case "text": button.buttonStyle(.borderless).tint(themePrimary)
            default: button.buttonStyle(.borderedProminent).tint(themePrimary)
            }
        }

        /// The theme's `primary`, so buttons follow the spec theme rather than the system accent (#15445).
        private var themePrimary: Color { ComponentColors(palette: palette).primary }

        /// Wraps onto more lines when the row is narrower than the label, never truncating.
        private var buttonLabel: some View {
            Text(node.plainText(state: model.state, pager: pagerPosition, derived: derivedContext))
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
                            navVisual(item)
                            if node.onScroll != "minimize" || barFraction == 0 { Text(item.label).font(.caption) }
                        }
                        .frame(
                            maxWidth: .infinity,
                            minHeight: node.onScroll == "minimize" && barFraction == 0 ? 64 : 44
                        )
                        .foregroundColor(navForeground(selected: index == navSelection))
                        .background(
                            Capsule().fill(
                                index == navSelection ? palette.navIndicator.map { Color($0) } ?? .clear : .clear
                            )
                        )
                    }
                    .accessibilityLabel(item.label)
                    .accessibilityAddTraits(index == navSelection ? .isSelected : [])
                }
            }
        }

        /// The item's image for the resolved mode when it is uploaded, then its icon, then a
        /// placeholder square (24 pt, as Android's nav icons).
        @ViewBuilder
        private func navVisual(_ item: NavItem) -> some View {
            switch item.visual(dark: palette.dark, available: Set(model.assets.keys)) {
            case let .image(id):
                if let image = model.assets[id] {
                    Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
                        .frame(width: 24, height: 24)
                        .accessibilityHidden(true)
                }
            case let .icon(name):
                if let symbol = prototypeSymbol(name) {
                    PrototypeGlyph(symbol: symbol)
                }
            case .placeholder:
                Rectangle().fill(palette.placeholderFill.map { Color($0) } ?? Color.gray.opacity(0.3))
                    .frame(width: 24, height: 24)
                    .accessibilityHidden(true)
            case .absent:
                EmptyView()
            }
        }

        /// A nav item's colour: the palette's role pair when themed, else the system accent and secondary.
        private func navForeground(selected: Bool) -> Color {
            if selected { return palette.navSelected.map { Color($0) } ?? .accentColor }
            return palette.navUnselected.map { Color($0) } ?? .secondary
        }

        /// Open sheets own their detent state, resetting to the first detent when reopened.
        @ViewBuilder private var sheet: some View {
            if node.openWhen.map(model.holds) ?? false, let child = node.child {
                PrototypeBottomSheetView(node: node, child: child, model: model)
            }
        }

        // MARK: Style

        /// A card draws the authored uniform radius (a theme token resolves to one); without it,
        /// Material's 12 pt (#15445).
        private var cardCornerRadius: Double {
            if case let .uniform(radius)? = style?.cornerRadius.map(shapes.resolve) { return radius }
            return 12
        }

        private var cornerShape: PrototypeStyleShape {
            PrototypeStyleShape(
                radius: node.type == "card" ? .uniform(cardCornerRadius) : style?.cornerRadius.map(shapes.resolve),
                continuous: style?.cornerStyle == "continuous"
            )
        }

        private var styleAnimation: PrototypeStyleAnimation {
            PrototypeStyleAnimation(
                animate: node.animate, scheme: model.spec?.motion,
                motion: PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
            )
        }

        private func styled(_ view: some View) -> some View {
            let padding = style?.padding
            let insets = safeAreaEdges
            let shape = cornerShape
            return view
                .animation(styleAnimation.animation("color"), value: palette.color(style?.color))
                .modifier(PrototypeAnimatedLayout(
                    insets: EdgeInsets(
                        top: (padding?.top ?? 0) + insets.top,
                        leading: (padding?.start ?? 0) + insets.left,
                        bottom: (padding?.bottom ?? 0) + insets.bottom,
                        trailing: (padding?.end ?? 0) + insets.right
                    ),
                    rules: PrototypeSizeRules(
                        style: style,
                        coverSize: coverSize.map { (Double($0.width), Double($0.height)) },
                        weightedAxis: stackAxis,
                        fillsByDefault: node.type == "spacer"
                    ),
                    alignment: contentAlignment,
                    animation: styleAnimation
                ))
                .modifier(PrototypeStylePaintModifier(
                    style: style, shape: shape, palette: palette,
                    styleAnimation: styleAnimation,
                    shimmerAnimated: PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
                        .spatial,
                    effects: PrototypeEffects.plan(
                        style?.effects, platformBackedSubtree: PrototypeEffects.hasPlatformBackedSubtree(node)
                    ),
                    motion: PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion),
                    authorsEffects: PrototypeEffects.authorsEffects(node)
                ))
                .modifier(PrototypeAnimatedTransform(style: style, animation: styleAnimation))
                .modifier(PrototypeKeyframesModifier(
                    frames: node.keyframes,
                    trigger: keyframeTrigger,
                    profile: PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).profile,
                    activity: model.keyframeActivity
                ))
                .modifier(PrototypeMenuBoundsReporter(node: node, model: model))
                .modifier(PrototypeHandledTapModifier(node: node, model: model))
                .modifier(TapModifier(
                    actions: handlesOwnTap ? nil : node.onTap,
                    longPress: handlesOwnTap ? nil : node.onLongPress,
                    doubleTap: handlesOwnTap ? nil : node.onDoubleTap,
                    node: node,
                    model: model,
                    style: style
                ))
                .modifier(IdentifierModifier(
                    // The search bar's editable field owns the node identifier.
                    identifier: node.type == "searchBar" ? nil : node.testTag,
                    label: accessibilityLabelOverride,
                    grouping: grouping,
                    semantics: node.semantics,
                    accessibleText: node.semantics?.liveRegion == nil
                        ? "" : node.announcementText(state: model.state, pager: pagerPosition),
                    hint: node.semantics?.hint.map { interpolatePrototypeText(
                        $0,
                        state: model.state,
                        pager: pagerPosition
                    ) }
                ))
        }

        /// Containers get their own accessibility element so a testTag names the container instead of
        /// being copied onto every descendant. A tappable container reads as one button.
        private var grouping: AccessibilityGrouping {
            prototypeAccessibilityGrouping(type: node.type, tappable: node.isInteractive)
        }

        private var contentAlignment: Alignment {
            prototypeContentAlignment(
                nodeType: node.type,
                arrangement: style?.arrangement,
                boxAlignment: swiftUIAlignment(style?.alignment),
                textAlign: style?.textAlign
            )
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

    private struct PrototypeGridSpanKey: LayoutValueKey {
        static let defaultValue = 1
    }

    /// Thin SwiftUI adapters over Core's eager, device-free placement maths. Custom Layout placements
    /// mirror automatically in RTL, just like PrototypeWeightedStackLayout.
    private struct PrototypeFlowLayout: Layout {
        let spacing: Double
        let runSpacing: Double
        let maxLines: Int?

        private func frames(proposal: ProposedViewSize, subviews: Subviews) -> PrototypeFlowGridFrames {
            let width = proposal.width.flatMap { $0.isFinite ? Double($0) : nil }
            let sizes = subviews.map { child in
                let size = child.sizeThatFits(ProposedViewSize(width: width.map { CGFloat($0) }, height: nil))
                return (width: Double(size.width), height: Double(size.height))
            }
            return PrototypeFlowPlacement.frames(
                sizes: sizes, available: width, spacing: spacing, runSpacing: runSpacing, maxLines: maxLines
            )
        }

        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
            let result = frames(proposal: proposal, subviews: subviews)
            return CGSize(width: result.width, height: result.height)
        }

        func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
            let result = frames(proposal: ProposedViewSize(width: bounds.width, height: nil), subviews: subviews)
            for (index, child) in subviews.enumerated() {
                let frame = result.children[index]
                // Overflow remains placed below the clipped container, with its view and semantics
                // intact. Never hide, omit or lazily instantiate a child to enforce maxLines.
                child.place(
                    at: CGPoint(x: bounds.minX + frame.x, y: bounds.minY + frame.y), anchor: .topLeading,
                    proposal: ProposedViewSize(width: frame.width, height: frame.height)
                )
            }
        }
    }

    private struct PrototypeGridLayout: Layout {
        let columns: PrototypeGridColumns
        let spacing: Double
        let runSpacing: Double?

        private func frames(proposal: ProposedViewSize, subviews: Subviews) -> PrototypeFlowGridFrames {
            PrototypeGridPlacement.frames(
                columns: columns,
                available: proposal.width.flatMap { $0.isFinite ? Double($0) : nil },
                spacing: spacing, runSpacing: runSpacing,
                spans: subviews.map { $0[PrototypeGridSpanKey.self] }
            ) { index, width in
                let size = subviews[index].sizeThatFits(ProposedViewSize(width: width.map { CGFloat($0) }, height: nil))
                return (Double(size.width), Double(size.height))
            }
        }

        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
            let result = frames(proposal: proposal, subviews: subviews)
            return CGSize(width: result.width, height: result.height)
        }

        func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
            let result = frames(proposal: ProposedViewSize(width: bounds.width, height: nil), subviews: subviews)
            for (index, child) in subviews.enumerated() {
                let frame = result.children[index]
                child.place(
                    at: CGPoint(x: bounds.minX + frame.x, y: bounds.minY + frame.y), anchor: .topLeading,
                    proposal: ProposedViewSize(width: frame.width, height: frame.height)
                )
            }
        }
    }

    @MainActor
    struct SizeModifier: ViewModifier {
        let rules: PrototypeSizeRules
        let alignment: Alignment

        private var width: Dimension? { rules.width }
        private var height: Dimension? { rules.height }
        private var fillsByDefault: Bool { rules.fillsByDefault }

        @ViewBuilder
        func body(content: Content) -> some View {
            if rules.needsResolvedLayout {
                // Bounds, aspect ratio and weights need Compose's constraint order (#11543).
                PrototypeSizedLayout(rules: rules, alignment: alignment) { content }
            } else {
                // Not `frame(maxWidth: nil, maxHeight: nil)`: see `PrototypeLayeredLayout` (#10899).
                PrototypeLayeredLayout(fillsWidth: fills(width), fillsHeight: fills(height), alignment: alignment) {
                    content.frame(width: fixed(width), height: fixed(height), alignment: alignment)
                }
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

    @MainActor
    private struct SpanLinksModifier: ViewModifier {
        let runs: [PrototypeTextRun]?
        let model: PrototypeModel

        func body(content: Content) -> some View {
            if let runs {
                content.environment(\.openURL, OpenURLAction { url in
                    guard url.scheme == PrototypeRichText.linkScheme,
                          let run = runs.first(where: { $0.link == url }), let actions = run.actions
                    else { return .discarded }
                    model.run(actions)
                    return .handled
                })
            } else {
                content
            }
        }
    }

    @MainActor
    private final class TapResolverState: ObservableObject {
        var disambiguator = PrototypeTapDisambiguator()
        var pendingTask: Task<Void, Never>?

        func cancel() {
            pendingTask?.cancel()
            pendingTask = nil
            disambiguator = PrototypeTapDisambiguator()
        }
    }

    /// Controls consume taps even when their value stays unchanged. Plain content gets no gesture.
    @MainActor
    private struct PrototypeHandledTapModifier: ViewModifier {
        let node: PrototypeNode
        let model: PrototypeModel

        private var handlesTap: Bool {
            node.onTap != nil || node.onDoubleTap != nil || [
                "textField", "searchBar", "switch", "checkbox", "button", "slider", "chip",
                "radioGroup", "listItem", "iconButton", "fab", "segmentedButton", "timePicker",
                "datePicker", "tabBar", "bottomNav", "select",
            ].contains(node.type)
        }

        @ViewBuilder
        func body(content: Content) -> some View {
            if handlesTap {
                content.simultaneousGesture(TapGesture().onEnded {
                    if model.isEnabled(node) { model.consumeDeadTap() }
                })
            } else {
                content
            }
        }
    }

    @MainActor
    private struct TapModifier: ViewModifier {
        let actions: [PrototypeAction]?
        let longPress: [PrototypeAction]?
        let doubleTap: [PrototypeAction]?
        let node: PrototypeNode
        let model: PrototypeModel
        let style: Style?

        @GestureState private var pressed = false
        @StateObject private var tapResolver = TapResolverState()
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        func body(content: Content) -> some View {
            if !plan.layers.isEmpty {
                let scale = style?.scale(pressed: pressed) ?? 1
                // Spec `motion: "none"` snaps like Reduce Motion (#10885).
                let spring = PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
                    .pressScaleDuration.map { Animation.spring(duration: $0) }
                // Whole padded frame is tappable, with a 44 pt minimum target (Android bug #10435).
                tapped(
                    content
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                        // Scales the drawn node only; motion off snaps instead of springing.
                        .scaleEffect(scale)
                        .animation(spring, value: scale)
                )
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0, maximumDistance: 10)
                        .updating($pressed) { _, state, _ in state = true }
                )
                .accessibilityAddTraits(.isButton)
                .disabled(!model.isEnabled(node))
                .onDisappear { tapResolver.cancel() }
            } else {
                content
            }
        }

        private var plan: PrototypeGesturePlan {
            PrototypeGesturePlan(onTap: actions, onLongPress: longPress, onDoubleTap: doubleTap)
        }

        private func tapped(_ content: some View) -> some View {
            // SwiftUI resolves inner-first. A long press that fails to complete lets the ancestor's
            // tap through. Gesture-only nodes must never install a single-tap handler.
            let gestures = plan.layers.reduce(AnyView(content)) { view, layer in
                switch layer {
                case .longPress:
                    AnyView(view.onLongPressGesture {
                        guard model.isEnabled(node) else { return }
                        model.run(longPress ?? [])
                    })
                case .doubleTap:
                    AnyView(view.onTapGesture(count: 2) {
                        guard model.isEnabled(node) else { return }
                        model.run(doubleTap ?? [])
                    })
                case .singleTap:
                    AnyView(view.onTapGesture { model.activate(.node(node)) })
                case .tapResolver:
                    AnyView(view.onTapGesture { resolveTap() })
                }
            }
            // `onLongPressGesture` and `onTapGesture(count: 2)` add no VoiceOver action, so name them.
            return plan.accessibilityActions.reduce(gestures) { view, action in
                AnyView(view.accessibilityAction(named: Text(action.name)) {
                    guard model.isEnabled(node) else { return }
                    model.run((action == .longPress ? longPress : doubleTap) ?? [])
                })
            }
        }

        private func resolveTap() {
            guard model.isEnabled(node) else { return }
            model.consumeDeadTap()
            let now = ProcessInfo.processInfo.systemUptime
            // A busy main actor can deliver the next tap before the expiry task resumes.
            if tapResolver.disambiguator.expire(at: now) {
                model.activate(.node(node))
            }
            switch tapResolver.disambiguator.tap(at: now) {
            case .fireDouble:
                tapResolver.pendingTask?.cancel()
                tapResolver.pendingTask = nil
                model.run(doubleTap ?? [])
            case .deferSingle:
                tapResolver.pendingTask?.cancel()
                tapResolver.pendingTask = Task { @MainActor in
                    do {
                        try await Task
                            .sleep(nanoseconds: UInt64(PrototypeTapDisambiguator.doubleTapWindow * 1_000_000_000))
                    } catch {
                        return
                    }
                    guard !Task.isCancelled else { return }
                    if tapResolver.disambiguator.flush() {
                        tapResolver.pendingTask = nil
                        model.activate(.node(node))
                    }
                }
            }
        }
    }

    @MainActor
    private struct IdentifierModifier: ViewModifier {
        let identifier: String?
        let label: String?
        let grouping: AccessibilityGrouping
        let semantics: PrototypeSemantics?
        let accessibleText: String
        let hint: String?

        func body(content: Content) -> some View {
            labelled(identified(content))
                .accessibilityAddTraits(traits)
                .onChange(of: accessibleText) { old, new in
                    guard let announcement = PrototypeAnnouncement.change(
                        previous: old,
                        current: new,
                        liveRegion: semantics?.liveRegion
                    ) else { return }
                    var text = AttributedString(announcement.text)
                    if announcement.assertive { text.accessibilitySpeechAnnouncementPriority = .high }
                    AccessibilityNotification.Announcement(text).post()
                }
        }

        /// A label needs its own accessibility element: on a bare container SwiftUI would spread it
        /// over the children.
        @ViewBuilder
        private func identified(_ content: Content) -> some View {
            if identifier == nil, semantics == nil, label == nil || grouping == .leaf {
                content
            } else if let identifier {
                grouped(content).accessibilityIdentifier(identifier)
            } else {
                grouped(content)
            }
        }

        @ViewBuilder
        private func grouped(_ content: Content) -> some View {
            switch semantics?.group == true ? .contain : grouping {
            case .leaf: content
            case .contain: content.accessibilityElement(children: .contain)
            case .combine: content.accessibilityElement(children: .combine)
            }
        }

        private var traits: AccessibilityTraits {
            var result: AccessibilityTraits = []
            if semantics?.heading == true { _ = result.insert(.isHeader) }
            for trait in semantics?.traits ?? [] {
                switch trait {
                case "button": _ = result.insert(.isButton)
                case "image": _ = result.insert(.isImage)
                case "selected": _ = result.insert(.isSelected)
                default: break
                }
            }
            return result
        }

        @ViewBuilder
        private func labelled(_ content: some View) -> some View {
            if let hint { named(content).accessibilityHint(hint) } else { named(content) }
        }

        @ViewBuilder
        private func named(_ content: some View) -> some View {
            if let label { content.accessibilityLabel(label) } else { content }
        }
    }

    /// Fill-sized pagers swipe with a paged TabView; wrap-sized ones show the current page and
    /// change pages with a horizontal drag, since a TabView has no intrinsic size.
    @MainActor
    struct PagerView: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        private var pagerId: String { node.id ?? "" }
        private var pages: [PrototypeNode] { node.children ?? [] }

        private var selection: Binding<Int> {
            Binding(
                get: {
                    _ = model.refusedChanges
                    return model.pages[pagerId] ?? 0
                },
                set: { model.setPage(pagerId, $0) }
            )
        }

        /// Page changes animate unless spec `motion: "none"` or Reduce Motion is on (#10442).
        private var pageAnimation: Animation? {
            PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).spatial
                ? .easeInOut(duration: 0.25) : nil
        }

        private var fills: Bool {
            if case .fill = node.resolvedStyle(state: model.state)?.height { return true }
            return false
        }

        private var layout: PrototypePagerLayout { PrototypePagerLayout(node: node) }

        /// A nil scroll position is a transient layout state, not a page change.
        private var pageBinding: Binding<Int?> {
            Binding(
                get: { selection.wrappedValue },
                set: { if let page = $0 { selection.wrappedValue = page } }
            )
        }

        @ViewBuilder
        private func optionPage(_ index: Int, _ page: PrototypeNode, visiblePages: [Int]) -> some View {
            let axes: Axis.Set = layout.vertical ? .vertical : .horizontal
            let content = NodeView(node: page, model: model)
                .environment(\.pagerContext, PagerContext(page: index, count: pages.count))
                .accessibilityHidden(!visiblePages.contains(index))
                .accessibilityAddTraits(index == selection.wrappedValue ? .isSelected : [])
            switch layout.pageSize {
            case .fill:
                content.containerRelativeFrame(axes)
            case let .fixed(points):
                content.frame(
                    width: layout.vertical ? nil : CGFloat(points),
                    height: layout.vertical ? CGFloat(points) : nil
                )
            }
        }

        private var optionsPager: some View {
            let axes: Axis.Set = layout.vertical ? .vertical : .horizontal
            return GeometryReader { proxy in
                // Visibility follows settled selection; the incoming page during a drag is exposed once selection
                // updates.
                let visiblePages = layout.visiblePages(
                    selected: selection.wrappedValue, count: pages.count,
                    viewportExtent: Double(layout.vertical ? proxy.size.height : proxy.size.width)
                )
                ScrollView(axes) {
                    if layout.vertical {
                        LazyVStack(spacing: CGFloat(layout.spacing)) {
                            ForEach(Array(pages.enumerated()), id: \.offset) { index, page in
                                optionPage(index, page, visiblePages: visiblePages).id(index)
                            }
                        }
                        .scrollTargetLayout()
                    } else {
                        LazyHStack(spacing: CGFloat(layout.spacing)) {
                            ForEach(Array(pages.enumerated()), id: \.offset) { index, page in
                                optionPage(index, page, visiblePages: visiblePages).id(index)
                            }
                        }
                        .scrollTargetLayout()
                    }
                }
                .scrollTargetBehavior(.viewAligned)
                .scrollPosition(id: pageBinding, anchor: layout.vertical ? .top : .leading)
                .contentMargins(layout.vertical ? .top : .leading, CGFloat(layout.start), for: .scrollContent)
                .contentMargins(layout.vertical ? .bottom : .trailing, CGFloat(layout.end), for: .scrollContent)
                .scrollIndicators(.hidden)
                .animation(pageAnimation, value: selection.wrappedValue)
            }
        }

        var body: some View {
            content.overlay(alignment: layout.vertical ? .trailing : .bottom) {
                if PrototypeCarousel.showsIndicator(node) { indicator }
            }
        }

        /// Page dots are decoration: they draw over the pages and stay out of the accessibility tree.
        @ViewBuilder private var indicator: some View {
            let dots = PrototypeCarousel.indicatorDots(count: pages.count, selected: selection.wrappedValue)
            let layoutDots = layout.vertical
                ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
            layoutDots {
                ForEach(Array(dots.enumerated()), id: \.offset) { _, filled in
                    Circle().fill(Color.primary.opacity(filled ? 1 : 0.38)).frame(width: 6, height: 6)
                }
            }
            .padding(8)
            .accessibilityHidden(true)
            .allowsHitTesting(false)
        }

        @ViewBuilder private var content: some View {
            if !layout.legacy {
                optionsPager
            } else if fills {
                let _: Int = model.refusedChanges
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
                let index = min(model.pages[pagerId] ?? 0, max(pages.count - 1, 0))
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

    /// Dragging changes physical height; scrim taps and swipe dismissal share the same state action.
    private struct PrototypeBottomSheetView: View {
        let node: PrototypeNode
        let child: PrototypeNode
        let model: PrototypeModel
        @Environment(\.prototypePalette) private var palette
        @State private var settledHeight: Double?
        @GestureState private var drag = 0.0

        var body: some View {
            GeometryReader { proxy in
                let containerHeight = Double(proxy.size.height)
                let heights = prototypeSheetHeights(detents: node.detents ?? [], containerHeight: containerHeight)
                let current = settledHeight ?? heights.first
                ZStack(alignment: .bottom) {
                    if let scrim = palette.sheetScrim(node.scrim).map({ Color($0) }) {
                        scrim
                            .ignoresSafeArea()
                            .contentShape(Rectangle())
                            .onTapGesture { model.closeModal(node) }
                            .accessibilityHidden(true)
                    }
                    VStack(spacing: 8) {
                        if node.dragHandle ?? true {
                            Capsule().fill(palette.sheetHandle.map { Color($0) } ?? Color.secondary.opacity(0.5))
                                .frame(width: 36, height: 5).padding(.top, 6)
                        }
                        NodeView(node: child, model: model)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: current.map { CGFloat(min(max($0 - drag, 0), containerHeight)) })
                    .background(palette.sheetSurface.map { Color($0) } ?? Color(UIColor.systemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(coordinateSpace: .named("prototypeBottomSheet"))
                            .updating($drag) { value, drag, _ in drag = Double(value.translation.height) }
                            .onEnded { value in
                                guard let current else { return }
                                if let height = settlePrototypeSheet(
                                    heights: heights, current: current, drag: Double(value.translation.height),
                                    dismissOnSwipe: node.dismissOnSwipe ?? true
                                ) {
                                    settledHeight = height
                                } else {
                                    model.closeModal(node)
                                }
                            },
                        including: heights.isEmpty ? .subviews : .all
                    )
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .coordinateSpace(name: "prototypeBottomSheet")
                .onChange(of: heights) { _, _ in settledHeight = nil }
            }
        }
    }

    /// `carousel` on iOS: fixed-width items in a snapping horizontal scroll. Every variant draws the same
    /// way (no multiBrowse or hero size changes), and every item stays in the accessibility tree.
    private struct PrototypeCarouselView: View {
        let node: PrototypeNode
        let model: PrototypeModel

        var body: some View {
            ScrollView(.horizontal) {
                HStack(spacing: CGFloat(PrototypeCarousel.spacing(node))) {
                    ForEach(node.drawnChildren(holds: model.holds), id: \.offset) { entry in
                        NodeView(node: entry.node, model: model)
                            .frame(width: CGFloat(PrototypeCarousel.itemWidth(node)))
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
        }
    }

    /// Row identity belongs to the data key; lazy stacks alone decide which row views exist.
    private struct PrototypeLazyListCell: View {
        let node: PrototypeNode
        let model: PrototypeModel
        let index: Int
        let key: String
        let visibility: (String, Bool) -> Void
        @State private var decoder = PrototypeLazyList.RowDecoder()

        var body: some View {
            if let row = decoder.decode(node: node, data: model.spec?.data, index: index) {
                NodeView(node: row.node, model: model)
                    .onAppear { visibility(key, true) }
                    .onDisappear { visibility(key, false) }
            }
        }
    }

    private struct PrototypeLazyListView: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @Environment(\.prototypeStackEntryID) private var entryID
        @Environment(\.prototypeStackActive) private var active
        @State private var pulling = false
        @State private var anchorKey: String?
        @State private var visibleKeys: Set<String> = []
        @State private var restoreTop = false

        private func visibility(_ key: String, appeared: Bool) {
            if appeared { visibleKeys.insert(key) } else { visibleKeys.remove(key) }
            if anchorKey == nil, active {
                let keys = PrototypeLazyList.keys(node: node, data: model.spec?.data)
                anchorKey = keys.first { visibleKeys.contains($0) }
            }
            model.listVisible(node, appearedKey: appeared ? key : nil, disappearedKey: appeared ? nil : key)
        }

        private func restore(keys: [String]) {
            if restoreTop {
                anchorKey = keys.first
                restoreTop = false
            } else if let saved = model.savedListAnchor(entryID: entryID, node: node, keys: keys) {
                anchorKey = saved
            } else if anchorKey != nil, PrototypeListAnchor.resolve(anchorKey: anchorKey, newKeys: keys) == nil {
                anchorKey = keys.first
            }
        }

        @ViewBuilder
        private func content(keys: [String]) -> some View {
            if let header = node.header { NodeView(node: header, model: model) }
            ForEach(Array(keys.enumerated()), id: \.element) { index, key in
                PrototypeLazyListCell(node: node, model: model, index: index, key: key, visibility: visibility)
            }
            .scrollTargetLayout()
            if let footer = node.footer { NodeView(node: footer, model: model) }
        }

        private func scroll(keys: [String]) -> some View {
            ScrollView(node.axis == "horizontal" ? .horizontal : .vertical, showsIndicators: true) {
                Group {
                    if node.axis == "horizontal" {
                        LazyHStack(spacing: node.spacing.map { CGFloat($0) }) { content(keys: keys) }
                    } else {
                        LazyVStack(spacing: node.spacing.map { CGFloat($0) }) { content(keys: keys) }
                    }
                }
                .padding(CGFloat(node.contentPadding ?? 0))
            }
            // A nil anchor lets SwiftUI preserve a partially visible row's relative position,
            // rather than aligning its leading edge on every data update. Both axes share it.
            .scrollPosition(id: $anchorKey, anchor: nil)
            .onAppear { restore(keys: keys) }
            .onChange(of: active) { _, active in
                if active { restore(keys: keys) }
            }
            .onChange(of: anchorKey) { _, key in
                if active { model.saveListAnchor(entryID: entryID, node: node, key: key) }
            }
            .onChange(of: keys) { _, next in
                let previous = anchorKey ?? model.savedListAnchor(entryID: entryID, node: node, keys: next)
                let pinned = PrototypeListAnchor.resolve(anchorKey: previous, newKeys: next)
                if !active, previous != nil, pinned == nil { restoreTop = true }
                anchorKey = pinned
                model.saveListAnchor(entryID: entryID, node: node, key: pinned)
                model.listVisible(node)
            }
        }

        var body: some View {
            let keys = PrototypeLazyList.keys(node: node, data: model.spec?.data)
            if node.axis != "horizontal", let refresh = node.refresh {
                scroll(keys: keys).refreshable {
                    guard model.state[refresh.stateKey]?.boolValue != true else { return }
                    pulling = true
                    model.run(PrototypeRefresh.actions(for: refresh))
                    await PrototypeRefresh.awaitCompletion(
                        isRefreshing: { model.state[refresh.stateKey]?.boolValue == true },
                        isCancelled: { Task.isCancelled },
                        sleep: { try? await Task.sleep(for: .milliseconds(100)) }
                    )
                    pulling = false
                }
                .overlay(alignment: .top) {
                    if model.state[refresh.stateKey]?.boolValue == true, !pulling {
                        ProgressView().padding(.top, 8)
                    }
                }
            } else { scroll(keys: keys) }
        }
    }

    /// A vertical scroll with `refresh`: the system refresh control runs the pull actions and stays up
    /// until the prototype writes false to the bound key. A key written true without a pull (an agent
    /// patch) shows a plain spinner instead, since SwiftUI cannot start `refreshable` programmatically.
    private struct PrototypeRefreshableScroll: View {
        let node: PrototypeNode
        let refresh: PrototypeScrollRefresh
        let model: PrototypeModel
        @State private var pulling = false

        private var refreshing: Bool { model.state[refresh.stateKey]?.boolValue == true }

        var body: some View {
            PrototypeChatScrollView(node: node, model: model)
                .refreshable {
                    guard !refreshing else { return }
                    pulling = true
                    model.run(PrototypeRefresh.actions(for: refresh))
                    await PrototypeRefresh.awaitCompletion(
                        isRefreshing: { model.state[refresh.stateKey]?.boolValue == true },
                        isCancelled: { Task.isCancelled },
                        sleep: { try? await Task.sleep(for: .milliseconds(100)) }
                    )
                    pulling = false
                }
                .overlay(alignment: .top) {
                    if refreshing, !pulling {
                        ProgressView().padding(.top, 8)
                    }
                }
        }
    }
#endif
