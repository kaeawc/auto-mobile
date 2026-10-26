#if canImport(UIKit)
    import SwiftUI

    /// Capture only menu parents and select fields, in the same window coordinate space as the top layer.
    @MainActor
    struct PrototypeMenuBoundsReporter: ViewModifier {
        let node: PrototypeNode
        let model: PrototypeModel
        @State private var frame: CGRect?

        private var needsBounds: Bool {
            node.type == "select" || ((node.children ?? []) + [node.child].compactMap { $0 })
                .contains { $0.type == "menu" }
        }

        func body(content: Content) -> some View {
            content
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { rect in
                    frame = rect
                    if needsBounds { model.menuBounds[ObjectIdentifier(node)] = rect }
                }
                .onChange(of: ObjectIdentifier(node)) { before, _ in
                    model.menuBounds[before] = nil
                    if needsBounds, let frame { model.menuBounds[ObjectIdentifier(node)] = frame }
                }
                .onDisappear { model.menuBounds[ObjectIdentifier(node)] = nil }
        }
    }

    /// A small in-window surface; a bounded scrolling list handles even the largest authored menu.
    @MainActor
    private struct PrototypeMenuSurface<Content: View>: View {
        let model: PrototypeModel
        let anchor: CGRect?
        var identifier: String?
        @ViewBuilder let content: () -> Content
        @Environment(\.prototypePalette) private var palette
        @Environment(\.layoutDirection) private var direction

        var body: some View {
            GeometryReader { proxy in
                let frame = proxy.frame(in: .global)
                let local = anchor.map { $0.offsetBy(dx: -frame.minX, dy: -frame.minY) }
                    ?? CGRect(origin: .zero, size: proxy.size)
                PrototypeMenuPlacement(anchor: local, rightToLeft: direction == .rightToLeft) {
                    ViewThatFits(in: .vertical) {
                        VStack(alignment: .leading, spacing: 0, content: content)
                            .padding(.vertical, 8)
                        ScrollView {
                            VStack(alignment: .leading, spacing: 0, content: content)
                                .padding(.vertical, 8)
                        }
                        .scrollIndicators(.hidden)
                    }
                    .environment(\.layoutDirection, direction)
                    .frame(width: min(280, proxy.size.width))
                    .background(ComponentColors(palette: palette).surfaceHigh)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .shadow(color: .black.opacity(0.2), radius: 3)
                    .accessibilityElement(children: .contain)
                    .prototypeIdentifier(identifier)
                    .contentShape(Rectangle())
                    .onTapGesture { model.consumeDeadTap() } // Surface padding consumes without dismissing.
                }
                .environment(\.layoutDirection, .leftToRight)
            }
        }
    }

    private struct PrototypeMenuPlacement: Layout {
        let anchor: CGRect
        let rightToLeft: Bool

        func sizeThatFits(proposal: ProposedViewSize, subviews _: Subviews, cache _: inout ()) -> CGSize {
            proposal.replacingUnspecifiedDimensions()
        }

        func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
            for subview in subviews {
                let proposal = ProposedViewSize(width: min(280, bounds.width), height: bounds.height)
                let size = subview.sizeThatFits(proposal)
                let origin = PrototypeMenus.origin(
                    anchor: anchor,
                    surface: size,
                    window: bounds.size,
                    rightToLeft: rightToLeft
                )
                subview.place(
                    at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                    anchor: .topLeading,
                    proposal: proposal
                )
            }
        }
    }

    @MainActor
    struct PrototypeMenuOverlay: View {
        let node: PrototypeNode
        let model: PrototypeModel

        var body: some View {
            let parent = model.spec?.root.menuParent(of: node)
            ZStack {
                Color.clear.contentShape(Rectangle())
                    .onTapGesture { model.closeModal(node) }
                    .accessibilityHidden(true)
                PrototypeMenuSurface(
                    model: model,
                    anchor: parent.flatMap { model.menuBounds[ObjectIdentifier($0)] },
                    identifier: node.identifier
                ) {
                    PrototypeMenuView(node: node, model: model)
                }
            }
        }
    }

    @MainActor
    struct PrototypeMenuView: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @Environment(\.prototypePalette) private var palette

        var body: some View {
            ForEach(Array((node.menuItems ?? []).enumerated()), id: \.offset) { index, item in
                switch item {
                case .divider:
                    Divider().accessibilityHidden(true)
                case let .item(entry):
                    Button { model.activate(.menuItem(node, entry)) } label: {
                        HStack(spacing: 12) {
                            if let symbol = prototypeSymbol(entry.icon) {
                                PrototypeGlyph(symbol: symbol).accessibilityHidden(true)
                            }
                            Text(entry.label)
                            Spacer(minLength: 8)
                            if let trailing = entry.trailingText { Text(trailing).foregroundColor(.secondary) }
                        }
                        .padding(.horizontal, 16)
                        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundColor(ComponentColors(palette: palette).content)
                    .disabled(entry.enabled == false)
                    .opacity(entry.enabled == false ? 0.38 : 1)
                    .accessibilityLabel(entry.label)
                    .prototypeIdentifier(node.partIdentifier(String(index)))
                }
            }
        }
    }

    @MainActor
    struct PrototypeSelectView: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @Environment(\.prototypePalette) private var palette

        var body: some View {
            let value = node.stateKey.flatMap { model.state[$0]?.stringValue }
            let selected = node.options?.first { $0.value == value }?.label ?? ""
            Button {
                model.consumeDeadTap()
                model.expandedSelect = model.expandedSelect === node ? nil : node
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        if let label = node.label { Text(label).font(.caption).foregroundColor(.secondary) }
                        Text(selected.isEmpty ? " " : selected)
                    }
                    Spacer(minLength: 12)
                    if let symbol = prototypeSymbol("expand_more") {
                        PrototypeGlyph(symbol: symbol).accessibilityHidden(true)
                    }
                }
                .padding(12)
                .frame(minHeight: 48)
                .background(ComponentColors(palette: palette).surfaceHigh)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(ComponentColors(palette: palette).outline))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(node.contentDescription ?? node.label ?? selected)
            .accessibilityValue(selected)
        }
    }

    @MainActor
    struct PrototypeSelectOverlay: View {
        let node: PrototypeNode
        let model: PrototypeModel

        var body: some View {
            ZStack {
                Color.clear.contentShape(Rectangle())
                    .onTapGesture {
                        model.consumeDeadTap()
                        model.expandedSelect = nil
                    }
                    .accessibilityHidden(true)
                PrototypeMenuSurface(model: model, anchor: model.menuBounds[ObjectIdentifier(node)]) {
                    ForEach(Array((node.options ?? []).enumerated()), id: \.offset) { _, option in
                        Button {
                            model.expandedSelect = nil
                            model.activate(.option(node, option))
                        } label: {
                            Text(option.label)
                                .padding(.horizontal, 16)
                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(
                            node.stateKey.flatMap { model.state[$0]?.stringValue } == option
                                .value ? .isSelected : []
                        )
                        .prototypeIdentifier(node.partIdentifier(option.value))
                    }
                }
            }
        }
    }
#endif
