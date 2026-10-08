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

extension Color {
    /// `#RRGGBB` or `#AARRGGBB`, matching the spec's Android-style hex.
    init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), let value = UInt64(hex.dropFirst(), radix: 16) else { return nil }
        let digits = hex.count - 1
        let alpha = digits == 8 ? Double((value >> 24) & 0xFF) / 255 : 1
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: alpha
        )
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
]

struct NodeView: View {
    let node: OverlayNode
    @ObservedObject var model: OverlayModel
    @Environment(\.pagerContext) private var pager

    var body: some View {
        if isVisible {
            styled(content)
        }
    }

    private var isVisible: Bool {
        guard let condition = node.visibleWhen else { return true }
        return model.holds(condition)
    }

    /// Controls that run `onTap` from their own action, so the generic tap gesture stays off them.
    private var handlesOwnTap: Bool {
        ["switch", "checkbox", "button"].contains(node.type)
    }

    /// `style` with every matching `styleWhen` entry merged over it.
    private var style: Style? { node.resolvedStyle(state: model.state) }

    @ViewBuilder private var content: some View {
        switch node.type {
        case "box":
            ZStack(alignment: swiftUIAlignment(style?.alignment)) { children }
        case "row":
            HStack(alignment: .center, spacing: style?.spacing ?? 0) { arranged(horizontal: true) }
        case "column":
            VStack(alignment: .leading, spacing: style?.spacing ?? 0) { arranged(horizontal: false) }
        case "text":
            textView
        case "image":
            imageView
        case "icon":
            Image(systemName: sfSymbols[node.name ?? ""] ?? "questionmark.square")
                .font(.system(size: style?.textSize ?? 24))
                .foregroundColor(Color(hex: style?.color) ?? .primary)
                // Decorative unless it has an authored description or is tappable.
                .accessibilityHidden(accessibilityLabelOverride == nil)
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
        default:
            EmptyView()
        }
    }

    @ViewBuilder private var children: some View {
        ForEach(Array((node.children ?? []).enumerated()), id: \.offset) { _, child in
            NodeView(node: child, model: model)
        }
    }

    /// Start/center/end come from the frame alignment; only the space* modes need spacers, so a
    /// wrap-sized row or column does not grow to fill its parent.
    @ViewBuilder
    private func arranged(horizontal _: Bool) -> some View {
        let nodes = node.children ?? []
        let mode = style?.arrangement ?? "start"
        let outer = mode == "spaceAround" || mode == "spaceEvenly"
        if outer { Spacer(minLength: 0) }
        ForEach(Array(nodes.enumerated()), id: \.offset) { index, child in
            if index > 0, mode.hasPrefix("space") { Spacer(minLength: 0) }
            NodeView(node: child, model: model)
        }
        if outer { Spacer(minLength: 0) }
    }

    private var pagerPosition: PagerPosition? {
        pager.map { PagerPosition(page: $0.page, count: $0.count) }
    }

    private var interpolatedText: String {
        interpolateOverlayText(node.text ?? "", state: model.state, pager: pagerPosition)
    }

    /// Text nodes already read their text, so only an authored description or a tappable icon's
    /// name needs to be applied explicitly.
    private var accessibilityLabelOverride: String? {
        guard node.contentDescription != nil || node.type == "icon" else { return nil }
        return node.accessibilityLabel(
            state: model.state,
            pager: pagerPosition,
            tappable: node.onTap != nil
        )
    }

    private var textView: some View {
        let size = style?.textSize ?? 14
        let design: Font.Design = switch style?.fontFamily {
        case .keyword("serif"): .serif
        case .keyword("monospace"): .monospaced
        // An uploaded font asset is not delivered to the agent, so it uses the system font.
        default: .default
        }
        let weight: Font.Weight = switch style?.fontWeight ?? 400 {
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
        let scaled = UIFontMetrics.default.scaledValue(for: size)
        var text = Text(interpolatedText)
            .font(.system(size: scaled, weight: weight, design: design))
        if style?.fontStyle == "italic" { text = text.italic() }
        let decoration = style?.textDecoration
        if decoration == "underline" || decoration == "underlineLineThrough" { text = text.underline() }
        if decoration == "lineThrough" || decoration == "underlineLineThrough" { text = text.strikethrough() }
        return text
            .tracking(style?.letterSpacing ?? 0)
            .lineSpacing(max(0, (style?.lineHeight ?? scaled) - scaled))
            .foregroundColor(Color(hex: style?.color) ?? .primary)
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
            Rectangle().fill(Color.gray.opacity(0.3))
                .overlay(Image(systemName: "photo").foregroundColor(.secondary))
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

    @ViewBuilder private var switchView: some View {
        let binding = Binding(get: { isOn }, set: { _ in toggleBound() })
        if let label = node.label {
            Toggle(label, isOn: binding)
        } else {
            Toggle("", isOn: binding).labelsHidden()
        }
    }

    /// iOS has no checkbox control: a button whose checked square reads as selected.
    private var checkboxView: some View {
        Button(action: toggleBound) {
            HStack(spacing: 8) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .accessibilityHidden(true)
                if let label = node.label { Text(label) }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isOn ? "checked" : "unchecked")
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    @ViewBuilder private var buttonView: some View {
        let button = Button(node.label ?? "") { model.run(node.onTap ?? []) }
        switch node.variant {
        case "outlined": button.buttonStyle(.bordered)
        case "text": button.buttonStyle(.borderless)
        default: button.buttonStyle(.borderedProminent)
        }
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
                            Image(systemName: sfSymbols[icon] ?? "circle")
                        }
                        Text(item.label).font(.caption)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundColor(index == navSelection ? .accentColor : .secondary)
                }
                .accessibilityAddTraits(index == navSelection ? .isSelected : [])
            }
        }
    }

    /// Opens at its first detent. Dragging between detents and swipe-to-dismiss are not
    /// prototyped on iOS yet.
    @ViewBuilder private var sheet: some View {
        let open = node.openWhen.map(model.holds) ?? false
        if open, let child = node.child {
            GeometryReader { proxy in
                VStack(spacing: 8) {
                    if node.dragHandle ?? true {
                        Capsule().fill(Color.secondary.opacity(0.5)).frame(width: 36, height: 5).padding(.top, 6)
                    }
                    NodeView(node: child, model: model)
                }
                .frame(maxWidth: .infinity)
                .frame(height: node.detents?.first.map { detent in
                    CGFloat(detent.height(in: Double(proxy.size.height)))
                })
                .background(Color(UIColor.systemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .frame(maxHeight: .infinity, alignment: .bottom)
            }
        }
    }

    // MARK: Style

    private var cornerShape: UnevenRoundedRectangle {
        switch style?.cornerRadius {
        case let .uniform(radius)?:
            UnevenRoundedRectangle(cornerRadii: RectangleCornerRadii(
                topLeading: radius, bottomLeading: radius, bottomTrailing: radius, topTrailing: radius
            ))
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
                width: style?.width,
                height: style?.height,
                alignment: contentAlignment,
                fillsByDefault: node.type == "spacer"
            ))
            .background(Color(hex: style?.background) ?? .clear)
            .clipShape(shape)
            .overlay(
                shape.stroke(Color(hex: style?.border?.color) ?? .clear, lineWidth: style?.border?.width ?? 0)
            )
            .shadow(
                color: (style?.elevation ?? 0) > 0 ? Color(hex: style?.shadowColor) ?? .black.opacity(0.25) : .clear,
                radius: style?.elevation ?? 0
            )
            .offset(x: style?.offset?.x ?? 0, y: style?.offset?.y ?? 0)
            .opacity(style?.alpha ?? 1)
            .modifier(TapModifier(actions: handlesOwnTap ? nil : node.onTap, model: model))
            .modifier(IdentifierModifier(
                identifier: node.testTag ?? node.id,
                label: accessibilityLabelOverride,
                grouping: grouping
            ))
    }

    /// Containers get their own accessibility element so a testTag names the container instead of
    /// being copied onto every descendant. A tappable container reads as one button.
    private var grouping: AccessibilityGrouping {
        guard ["box", "row", "column", "scroll", "pager"].contains(node.type) else { return .leaf }
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
        let all = model.safeInsets
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
        content
            .frame(
                width: fixed(width),
                height: fixed(height),
                alignment: alignment
            )
            .frame(
                maxWidth: fills(width) ? .infinity : nil,
                maxHeight: fills(height) ? .infinity : nil,
                alignment: alignment
            )
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
    let actions: [OverlayAction]?
    let model: OverlayModel

    func body(content: Content) -> some View {
        if let actions {
            // Whole padded frame is tappable, with a 44 pt minimum target (Android bug #10435).
            content
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .onTapGesture { model.run(actions) }
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
    let node: OverlayNode
    @ObservedObject var model: OverlayModel

    private var pagerId: String { node.id ?? "" }
    private var pages: [OverlayNode] { node.children ?? [] }

    private var selection: Binding<Int> {
        Binding(
            get: { model.pages[pagerId] ?? 0 },
            set: { model.setPage(pagerId, $0) }
        )
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
                    .animation(.easeInOut(duration: 0.2), value: index)
            }
        }
    }
}
