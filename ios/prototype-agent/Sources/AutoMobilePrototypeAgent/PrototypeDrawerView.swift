#if canImport(UIKit)
    import SwiftUI

    /// The modal layer retains this view until its close completion, including interrupted closes.
    @MainActor
    struct PrototypeDrawerOverlay: View {
        let node: PrototypeNode
        let model: PrototypeModel
        let isOpen: Bool
        let hitKey: String
        let didClose: () -> Void
        @Environment(\.prototypePalette) private var palette
        @Environment(\.layoutDirection) private var direction
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var progress = 0.0
        @State private var generation = 0
        @State private var focus = PrototypeOverlayFocusAnchor()
        @GestureState private var drag = 0.0

        private var motion: PrototypeStackAnimation {
            PrototypeDrawers.animation(specMotion: model.spec?.motion, reduceMotion: reduceMotion)
        }

        var body: some View {
            GeometryReader { proxy in
                let rtl = direction == .rightToLeft
                let left = PrototypeDrawers.isLeft(edge: node.edge, rightToLeft: rtl)
                let safe = CGRect(
                    x: 0,
                    y: model.contentSafeInsets.top,
                    width: proxy.size.width,
                    height: max(0, proxy.size.height - model.contentSafeInsets.top - model.contentSafeInsets.bottom)
                )
                let frame = PrototypeDrawers.frame(window: safe, edge: node.edge, rightToLeft: rtl)
                ZStack(alignment: .topLeading) {
                    (palette.sheetScrim(node.scrim).map { Color($0) } ?? .black.opacity(0.4))
                        .opacity(progress)
                        .contentShape(Rectangle())
                        .onTapGesture { model.closeModal(node) }
                        .accessibilityLabel("Dismiss drawer")
                        .accessibilityAddTraits(.isButton)
                        .prototypeIdentifier(node.partIdentifier("close"))
                    panel
                        .frame(width: frame.width, height: frame.height, alignment: .topLeading)
                        .background(ComponentColors(palette: palette).surfaceHigh)
                        .shadow(color: .black.opacity(0.2), radius: 8)
                        .opacity(motion == .fade ? progress : 1)
                        .offset(
                            x: frame
                                .minX + (motion == .slide ? (left ? -1 : 1) * frame.width * (1 - progress) : 0) + drag,
                            y: frame.minY
                        )
                        .gesture(DragGesture().updating($drag) { value, state, _ in
                            if node.dismissOnSwipe != false {
                                state = left ? min(0, value.translation.width) : max(0, value.translation.width)
                            }
                        }.onEnded { value in
                            if PrototypeDrawers.dismisses(
                                width: frame.width,
                                translation: value.translation.width,
                                edge: node.edge,
                                rightToLeft: rtl,
                                dismissOnSwipe: node.dismissOnSwipe != false
                            ) {
                                model.closeModal(node)
                            }
                        })
                }
                .environment(\.layoutDirection, .leftToRight)
                .reportFrame(key: hitKey, model: model)
                .allowsHitTesting(isOpen)
                .accessibilityHidden(!isOpen)
                .onChange(of: isOpen, initial: true) { _, open in animate(open: open) }
            }
        }

        private var panel: some View {
            NodeView(node: node, model: model, presentedAsModal: true)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .environment(\.layoutDirection, direction)
                .accessibilityElement(children: .contain)
                .prototypeIdentifier(node.identifier)
                .background(PrototypeOverlayFocusMarker(anchor: focus))
        }

        private func animate(open: Bool) {
            generation += 1
            let token = generation
            let finish = {
                guard token == generation else { return }
                if open { focus.enter() } else {
                    focus.restore()
                    didClose()
                }
            }
            guard motion != .none else {
                progress = open ? 1 : 0
                finish()
                return
            }
            FrameWaiter.nextFrame {
                guard token == generation else { return }
                withAnimation(.timingCurve(0, 0, 0.2, 1, duration: 0.3), completionCriteria: .removed) {
                    progress = open ? 1 : 0
                } completion: {
                    finish()
                }
            }
        }
    }
#endif
