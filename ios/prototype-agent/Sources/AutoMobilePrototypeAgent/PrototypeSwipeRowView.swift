#if canImport(UIKit)
    import SwiftUI

    /// A row whose foreground drags over action buttons inside the surrounding `ScrollView` (not a
    /// `List`). Closed, no button is drawn; open or dragging, the revealed buttons carry the identifier
    /// `<rowTag>.swipe.<index>` and every entry is also an accessibility action on the row, so VoiceOver
    /// can run it without swiping. Reduced motion or spec `motion: "none"` snaps instead of animating.
    /// The thresholds live in `PrototypeSwipe`.
    @MainActor
    struct PrototypeSwipeRowView<Content: View>: View {
        let node: PrototypeNode
        let swipe: PrototypeSwipeActions
        let model: PrototypeModel
        @ViewBuilder let content: Content
        @Environment(\.prototypePalette) private var palette
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var rowWidth = 0.0
        @State private var offset = 0.0
        @State private var dragStart: Double?
        @State private var horizontalDrag: Bool?
        @State private var samples: [(time: Double, x: Double)] = []

        private var identity: ObjectIdentifier { ObjectIdentifier(node) }
        private var geometry: PrototypeSwipe.Geometry { PrototypeSwipe.Geometry(actions: swipe, rowWidth: rowWidth) }
        private var motion: Bool { PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).spatial }
        private var colors: ComponentColors { ComponentColors(palette: palette) }

        var body: some View {
            ZStack {
                if offset != 0 { buttons }
                foreground
            }
            .clipped()
            .background(
                GeometryReader { proxy in
                    Color.clear.onAppear { rowWidth = proxy.size.width }
                        .onChange(of: proxy.size.width) { _, width in rowWidth = width }
                }
            )
            .onAppear {
                if model.swipe
                    .isOpen(identity) { offset = PrototypeSwipe.restOffset(.open(model.swipe.openSide), geometry) }
            }
            .onChange(of: model.swipe.openRow) { _, open in
                if open != identity, offset != 0 { move(to: 0) }
            }
        }

        private var foreground: some View {
            content
                .overlay {
                    if offset != 0 {
                        // An open row swallows taps: the first tap closes it instead of running its action.
                        Color.clear.contentShape(Rectangle())
                            .onTapGesture { close() }
                            .accessibilityHidden(true)
                    }
                }
                .offset(x: offset)
                .simultaneousGesture(drag)
                .modifier(SwipeAccessibilityActions(swipe: swipe, run: { model.run($0) }))
        }

        private var drag: some Gesture {
            DragGesture(minimumDistance: 12)
                .onChanged { value in
                    if horizontalDrag == nil {
                        horizontalDrag = PrototypeSwipe.isHorizontal(
                            translation: (x: Double(value.translation.width), y: Double(value.translation.height))
                        )
                        dragStart = offset
                        samples = []
                    }
                    guard horizontalDrag == true, let start = dragStart else { return }
                    let raw = start + Double(value.translation.width)
                    samples.append((time: value.time.timeIntervalSinceReferenceDate, x: raw))
                    if samples.count > 8 { samples.removeFirst() }
                    offset = PrototypeSwipe.rubberBanded(raw, geometry)
                }
                .onEnded { _ in
                    defer { horizontalDrag = nil; dragStart = nil; samples = [] }
                    guard horizontalDrag == true else { return }
                    finish(PrototypeSwipe.settle(
                        offset: offset, velocity: PrototypeSwipe.velocity(samples), geometry
                    ))
                }
        }

        private func finish(_ settle: PrototypeSwipe.Settle) {
            switch settle {
            case .closed:
                model.swipeClosed(node)
            case let .open(side):
                model.swipeOpened(node, side: side)
            case let .full(side):
                model.swipeClosed(node)
                let entries = side == .start ? swipe.start : swipe.end
                if let first = entries?.first { model.run(first.onTap) }
            }
            if case .full = settle { move(to: 0) } else { move(to: PrototypeSwipe.restOffset(settle, geometry)) }
        }

        private func close() {
            model.swipeClosed(node)
            move(to: 0)
        }

        private func move(to target: Double) {
            if motion {
                withAnimation(.easeOut(duration: 0.2)) { offset = target }
            } else {
                offset = target
            }
        }

        // MARK: Buttons

        private var buttons: some View {
            let side: PrototypeSwipe.Side = offset > 0 ? .start : .end
            let actions = (side == .start ? swipe.start : swipe.end) ?? []
            let base = side == .start ? 0 : (swipe.start?.count ?? 0)
            let widths = PrototypeSwipe.buttonWidths(count: actions.count, reveal: abs(offset))
            // The first entry sits at the screen edge; the end side lays out from the right.
            let order = side == .end ? Array(actions.indices.reversed()) : Array(actions.indices)
            return HStack(spacing: 0) {
                ForEach(order, id: \.self) { index in
                    button(actions[index], width: widths[index], tagIndex: base + index)
                }
            }
            .frame(width: widths.reduce(0, +), alignment: side == .start ? .leading : .trailing)
            .frame(width: abs(offset), alignment: side == .start ? .leading : .trailing)
            .clipped()
            .frame(maxWidth: .infinity, alignment: side == .start ? .leading : .trailing)
        }

        private func button(_ action: PrototypeSwipeAction, width: Double, tagIndex: Int) -> some View {
            let destructive = action.role == "destructive"
            let authored = palette.color(action.color)
            let background = authored ?? (destructive ? colors.error : colors.primary)
            let foregroundColor = authored == nil ? (destructive ? colors.onError : colors.onPrimary) : Color.white
            return Button {
                model.run(action.onTap)
                close()
            } label: {
                VStack(spacing: 4) {
                    if let symbol = prototypeSymbol(action.icon) { PrototypeGlyph(symbol: symbol) }
                    Text(action.label).lineLimit(1)
                }
                .foregroundColor(foregroundColor)
                .frame(width: width)
                .frame(maxHeight: .infinity)
                .background(background)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(action.label)
            .prototypeIdentifier(node.partIdentifier("swipe.\(tagIndex)"))
        }
    }

    /// One accessibility action per entry, `start` first, so assistive technology never needs the drag.
    private struct SwipeAccessibilityActions: ViewModifier {
        let swipe: PrototypeSwipeActions
        let run: ([PrototypeAction]) -> Void

        func body(content: Content) -> some View {
            swipe.entries.reduce(AnyView(content)) { view, entry in
                AnyView(view.accessibilityAction(named: Text(entry.action.label)) { run(entry.action.onTap) })
            }
        }
    }
#endif
