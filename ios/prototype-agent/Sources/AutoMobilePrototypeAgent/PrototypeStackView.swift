#if canImport(UIKit)
    import SwiftUI
    import UIKit

    private struct PrototypeStackActiveKey: EnvironmentKey {
        static let defaultValue = true
    }

    private struct PrototypeStackEntryIDKey: EnvironmentKey {
        static let defaultValue: Int? = nil
    }

    extension EnvironmentValues {
        var prototypeStackEntryID: Int? {
            get { self[PrototypeStackEntryIDKey.self] }
            set { self[PrototypeStackEntryIDKey.self] = newValue }
        }

        var prototypeStackActive: Bool {
            get { self[PrototypeStackActiveKey.self] }
            set { self[PrototypeStackActiveKey.self] = newValue }
        }
    }

    private struct PrototypeStackTopKey: LayoutValueKey {
        static let defaultValue = false
    }

    private struct PrototypeStackEntryKey: LayoutValueKey {
        static let defaultValue = 0
    }

    /// Only the active entry measures the stack. Hidden scroll views retain their last viewport,
    /// so a shorter destination cannot clamp an offscreen entry's scroll offset.
    private struct PrototypeStackScreenLayout: Layout {
        struct Cache {
            var proposals: [Int: ProposedViewSize] = [:]
        }

        func makeCache(subviews _: Subviews) -> Cache { Cache() }

        func updateCache(_ cache: inout Cache, subviews: Subviews) {
            let ids = Set(subviews.map { $0[PrototypeStackEntryKey.self] })
            cache.proposals = cache.proposals.filter { ids.contains($0.key) }
        }

        func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout Cache) -> CGSize {
            subviews.first(where: { $0[PrototypeStackTopKey.self] })?.sizeThatFits(proposal) ?? .zero
        }

        func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
            for child in subviews {
                let id = child[PrototypeStackEntryKey.self]
                if child[PrototypeStackTopKey.self] || cache.proposals[id] == nil {
                    let measured = child.sizeThatFits(proposal)
                    cache.proposals[id] = ProposedViewSize(
                        width: bounds.width < measured.width ? bounds.width : proposal.width,
                        height: bounds.height < measured.height ? bounds.height : proposal.height
                    )
                }
                child.place(
                    at: bounds.origin, anchor: .topLeading,
                    proposal: cache.proposals[id] ?? proposal
                )
            }
        }
    }

    @MainActor
    private final class PrototypeStackFocusAnchor {
        weak var view: UIView?
    }

    /// A non-accessible marker supplies the newly active screen's native container for VoiceOver.
    @MainActor
    private struct PrototypeStackFocusMarker: UIViewRepresentable {
        let anchor: PrototypeStackFocusAnchor
        let active: Bool

        func makeUIView(context _: Context) -> UIView {
            let view = UIView()
            view.isAccessibilityElement = false
            view.isUserInteractionEnabled = false
            if active { anchor.view = view }
            return view
        }

        func updateUIView(_ view: UIView, context _: Context) {
            if active { anchor.view = view }
        }
    }

    /// Stable entry identities retain ScrollView state, including repeated pushes of one screen.
    /// Only the current entry participates in accessibility and hit testing.
    @MainActor
    struct PrototypeStackView: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @Environment(\.layoutDirection) private var layoutDirection
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.prototypeStackActive) private var ancestorActive
        @State private var entries: [PrototypeStackEntry] = []
        @State private var previous: PrototypeStackEntry?
        @State private var destination: PrototypeStackEntry?
        @State private var progress = 1.0
        @State private var kind = PrototypeStackAnimation.none
        @State private var direction = PrototypeStackChange.Direction.reset
        @State private var generation = 0
        @State private var focusAnchor = PrototypeStackFocusAnchor()

        private var id: String { node.id ?? "" }
        private var current: [PrototypeStackEntry] { model.stackEntries[id] ?? [] }
        private var rtl: Bool { layoutDirection == .rightToLeft }
        private var drag: PrototypeModel.StackDrag? {
            model.stackDrag.flatMap { $0.target == id ? $0 : nil }
        }

        var body: some View {
            PrototypeStackScreenLayout {
                ForEach(entries) { entry in
                    if let screen = node.screens?[entry.screen] {
                        let active = ancestorActive && entry.id == current.last?.id
                        NodeView(node: screen, model: model)
                            .background(PrototypeStackFocusMarker(anchor: focusAnchor, active: active))
                            .overlay { Color.black.opacity(dim(entry)).allowsHitTesting(false) }
                            .offset(
                                x: offset(entry, width: model.windowSize.width),
                                y: axisOffset(entry, vertical: true)
                            )
                            .scaleEffect(kind == .fadeThrough && entry == destination ? 0.92 + 0.08 * max(
                                0,
                                (progress - 0.5) * 2
                            ) : 1)
                            .opacity(opacity(entry))
                            .zIndex(zIndex(entry))
                            .allowsHitTesting(active && drag?.settling != true)
                            .accessibilityHidden(!active)
                            .environment(\.prototypeStackActive, active)
                            .environment(\.prototypeStackEntryID, entry.id)
                            .layoutValue(key: PrototypeStackTopKey.self, value: entry.id == current.last?.id)
                            .layoutValue(key: PrototypeStackEntryKey.self, value: entry.id)
                    }
                }
            }
            .clipped()
            .onChange(of: current, initial: true) { _, next in navigate(to: next) }
        }

        private func offset(_ entry: PrototypeStackEntry, width: Double) -> Double {
            if kind == .sharedAxisX { return axisOffset(entry, vertical: false) }
            let sign = rtl ? -1.0 : 1.0
            if let drag {
                if entry.id == current.last?.id { return sign * width * drag.progress }
                if entry.id == current.dropLast().last?.id { return -sign * width * 0.3 * (1 - drag.progress) }
                return 0
            }
            guard kind == .slide else { return 0 }
            if direction == .pop {
                if entry == previous { return sign * width * progress }
                if entry == destination { return -sign * width * 0.3 * (1 - progress) }
            } else {
                if entry == destination { return sign * width * (1 - progress) }
                if entry == previous { return -sign * width * 0.3 * progress }
            }
            return 0
        }

        private func axisOffset(_ entry: PrototypeStackEntry, vertical: Bool) -> Double {
            guard kind == (vertical ? .sharedAxisY : .sharedAxisX) else { return 0 }
            let sign = (direction == .pop ? -1.0 : 1.0) * (!vertical && rtl ? -1.0 : 1.0)
            if entry == destination { return sign * 30 * (1 - progress) }
            if entry == previous { return -sign * 30 * progress }
            return 0
        }

        private func opacity(_ entry: PrototypeStackEntry) -> Double {
            if drag != nil {
                return entry.id == current.last?.id || entry.id == current.dropLast().last?.id ? 1 : 0
            }
            if kind == .fadeThrough {
                if entry == destination { return max(0, (progress - 0.5) * 2) }
                if entry == previous { return max(0, 1 - progress * 2) }
            }
            if kind == .fade || kind == .sharedAxisX || kind == .sharedAxisY {
                if entry == destination { return progress }
                if entry == previous { return 1 - progress }
            }
            if kind == .slide, entry == previous || entry == destination { return 1 }
            return entry.id == current.last?.id ? 1 : 0
        }

        private func dim(_ entry: PrototypeStackEntry) -> Double {
            if let drag {
                return entry.id == current.dropLast().last?.id ? 0.15 * (1 - drag.progress) : 0
            }
            guard kind == .slide else { return 0 }
            if direction == .pop { return entry == destination ? 0.15 * (1 - progress) : 0 }
            return entry == previous ? 0.15 * progress : 0
        }

        private func zIndex(_ entry: PrototypeStackEntry) -> Double {
            if drag != nil { return entry.id == current.last?.id ? 2 : 0 }
            if direction == .pop { return entry == previous ? 2 : 0 }
            return entry == destination ? 2 : 0
        }

        private func navigate(to next: [PrototypeStackEntry]) {
            generation += 1
            let token = generation
            let oldTop = destination ?? entries.last
            let change = model.stackChanges[id]
            let animation = PrototypeStackNavigation.animation(
                declared: change?.transition ?? .platform, specMotion: model.spec?.motion,
                reduceMotion: reduceMotion, direction: change?.direction ?? .reset
            )
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                direction = change?.direction ?? .reset
                kind = model.completedStackSwipe == id || oldTop == nil ? .none : animation
                if model.completedStackSwipe == id { model.completedStackSwipe = nil }
                previous = oldTop
                destination = next.last
                // Retain at most one removed screen while it exits, even under rapid navigation.
                entries = next
                if let oldTop, !next.contains(where: { $0.id == oldTop.id }) { entries.append(oldTop) }
                progress = kind == .none ? 1 : 0
            }
            if kind == .none {
                entries = next
                focusScreen()
                return
            }
            FrameWaiter.nextFrame {
                guard token == generation else { return }
                let duration = kind == .fadeThrough ? PrototypeStackTiming.effects * 2 : PrototypeStackTiming.spatial
                withAnimation(
                    kind == .sharedAxisX || kind == .sharedAxisY || kind == .fadeThrough
                        ? .linear(duration: duration)
                        : .easeOut(duration: 0.35),
                    completionCriteria: .removed
                ) {
                    progress = 1
                } completion: {
                    guard token == generation else { return }
                    entries = next
                    kind = .none
                    focusScreen()
                }
            }
        }

        private func focusScreen() {
            guard ancestorActive else { return }
            let token = generation
            FrameWaiter.nextFrame {
                guard token == generation, ancestorActive, let container = focusAnchor.view?.superview else { return }
                UIAccessibility.post(notification: .screenChanged, argument: container)
            }
        }
    }
#endif
