#if canImport(UIKit)
    import SwiftUI

    private struct PrototypeZoomNamespaceKey: EnvironmentKey {
        static let defaultValue: Namespace.ID? = nil
    }

    extension EnvironmentValues {
        var prototypeZoomNamespace: Namespace.ID? {
            get { self[PrototypeZoomNamespaceKey.self] }
            set { self[PrototypeZoomNamespaceKey.self] = newValue }
        }
    }

    struct PrototypeZoomSourceModifier: ViewModifier {
        let key: String?
        @Environment(\.prototypeZoomNamespace) private var namespace

        @ViewBuilder
        func body(content: Content) -> some View {
            if #available(iOS 18, *), let key, let namespace {
                content.matchedTransitionSource(id: key, in: namespace)
            } else { content }
        }
    }

    /// Native destinations own interactive zoom/pop; non-zoom segments keep the custom renderer.
    struct PrototypeZoomStackHost: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            if #available(iOS 18, *), PrototypeZoomNavigation.hasZoom(in: node, root: model.spec?.root ?? node),
               PrototypeZoomNavigation.resolve(
                   osMajor: ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
                   profile: PrototypeMotion(specMotion: model.spec?.motion, reduceMotion: reduceMotion).profile,
                   transition: .zoom
               ) == .zoom
            {
                PrototypeNativeZoomStack(node: node, model: model)
            } else {
                PrototypeStackView(node: node, model: model)
            }
        }
    }

    @available(iOS 18, *)
    private struct PrototypeNativeZoomStack: View {
        let node: PrototypeNode
        let model: PrototypeModel
        @Namespace private var namespace
        private var id: String { node.id ?? "" }
        private var entries: [PrototypeStackEntry] { model.stackEntries[id] ?? [] }
        private var root: PrototypeStackEntry? { entries.first }
        private var destinations: [PrototypeStackEntry] {
            PrototypeZoomNavigation.destinations(entries)
        }

        var body: some View {
            NavigationStack(path: Binding(get: { destinations }, set: navigateBack)) {
                if let root {
                    screen(root)
                        .navigationDestination(for: PrototypeStackEntry.self) { entry in
                            screen(entry)
                                .navigationTransition(.zoom(sourceID: entry.zoomSource ?? "", in: namespace))
                        }
                }
            }
            .environment(\.prototypeZoomNamespace, namespace)
            .onChange(of: entries, initial: true) { _, _ in
                if destinations.isEmpty { model.nativeZoomStacks.remove(id) }
                else { model.nativeZoomStacks.insert(id) }
            }
            .onDisappear { model.nativeZoomStacks.remove(id) }
        }

        private func screen(_ entry: PrototypeStackEntry) -> some View {
            PrototypeStackView(
                node: node,
                model: model,
                segment: PrototypeZoomNavigation.segment(entries, startingAt: entry)
            )
            .toolbar(.hidden, for: .navigationBar)
        }

        private func navigateBack(_ next: [PrototypeStackEntry]) {
            let pops = PrototypeZoomNavigation.popCount(entries, keeping: next)
            guard pops > 0 else { return }
            model.run((0 ..< pops).map { _ in PrototypeAction(
                type: "pop",
                name: nil,
                payload: nil,
                context: nil,
                pager: nil,
                page: nil,
                stack: id,
                screen: nil,
                path: nil,
                key: nil,
                value: nil,
                by: nil,
                requireValid: nil
            ) })
        }
    }
#endif
