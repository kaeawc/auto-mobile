#if canImport(UIKit)
    import SwiftUI

    /// Material drawing under every design until native platform containers are available.
    @MainActor
    struct PrototypeAdaptiveView: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @Environment(\.horizontalSizeClass) private var sizeClass
        @Environment(\.prototypePalette) private var palette

        private var width: PrototypeAdaptive.Width { sizeClass == .regular ? .regular : .compact }
        private var layout: PrototypeAdaptive.Layout { PrototypeAdaptive.layout(kind: node.kind ?? "", width: width) }
        private var selected: Bool { !(node.selectionKey.flatMap { model.state[$0]?.stringValue } ?? "").isEmpty }
        private var open: Bool { node.openKey.flatMap { model.state[$0]?.boolValue } == true }

        var body: some View {
            Group {
                switch layout {
                case .split:
                    HStack(spacing: 0) {
                        pane(node.list).frame(maxWidth: .infinity)
                        Divider()
                        pane(node.detail).frame(maxWidth: .infinity)
                    }
                case .stack:
                    VStack(spacing: 0) {
                        if selected {
                            Button("Back") { back() }
                                .buttonStyle(.plain)
                                .padding(16)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .foregroundStyle(ComponentColors(palette: palette).primary)
                                .prototypeIdentifier(node.partIdentifier("back"))
                            pane(node.detail)
                        } else { pane(node.list) }
                    }
                case .sidebar:
                    HStack(spacing: 0) {
                        navigation(vertical: true).frame(width: 240)
                        Divider()
                        pane(node.content)
                    }
                case .bottomBar:
                    VStack(spacing: 0) {
                        pane(node.content)
                        Divider()
                        navigation(vertical: false)
                    }
                case .inspector:
                    HStack(spacing: 0) {
                        pane(node.main)
                        if open {
                            Divider()
                            supporting.frame(width: 320)
                        }
                    }
                case .sheet:
                    ZStack(alignment: .bottom) {
                        pane(node.main).allowsHitTesting(!open).accessibilityHidden(open)
                        if open {
                            Color.black.opacity(0.4).ignoresSafeArea()
                                .onTapGesture { close() }
                                .accessibilityLabel("Dismiss supporting pane")
                                .accessibilityAddTraits(.isButton)
                            supporting.frame(maxHeight: 400)
                                .background(ComponentColors(palette: palette).surfaceHigh)
                                .clipShape(RoundedRectangle(cornerRadius: 24))
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }

        private var supporting: some View {
            VStack(spacing: 0) {
                Button("Close") { close() }
                    .buttonStyle(.plain).padding(16)
                    .prototypeIdentifier(node.partIdentifier("close"))
                pane(node.adaptiveSupporting)
            }
        }

        @ViewBuilder
        private func pane(_ child: PrototypeNode?) -> some View {
            if let child {
                NodeView(node: child, model: model)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }

        @ViewBuilder
        private func navigation(vertical: Bool) -> some View {
            let colors = ComponentColors(palette: palette)
            let items = node.adaptiveItems ?? []
            let content = ForEach(items.indices, id: \.self) { index in
                let item = items[index]
                let active = node.stateKey.flatMap { model.state[$0]?.stringValue } == item.value
                Button {
                    if let key = node.stateKey { model.choose(key: key, value: item.value, then: []) }
                } label: {
                    Text(item.label).padding(16).frame(maxWidth: .infinity)
                        .foregroundStyle(active ? colors.primary : colors.content)
                        .background(active ? colors.primary.opacity(0.12) : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 24))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(active ? [.isSelected] : [])
                .prototypeIdentifier(node.partIdentifier("item-\(index)"))
            }
            if vertical {
                VStack(spacing: 4) { content; Spacer(minLength: 0) }.padding(8).background(colors.surfaceHigh)
            } else { HStack(spacing: 0) { content }.background(colors.surfaceHigh) }
        }

        private func back() {
            if let (key, value) = PrototypeAdaptive.compactBack(
                kind: node.kind ?? "",
                width: width,
                selectionKey: node.selectionKey,
                state: model.state
            ), let text = value.stringValue {
                model.choose(key: key, value: text, then: [])
            }
        }

        private func close() { if open, let key = node.openKey { model.toggle(key, then: []) } }
    }
#endif
