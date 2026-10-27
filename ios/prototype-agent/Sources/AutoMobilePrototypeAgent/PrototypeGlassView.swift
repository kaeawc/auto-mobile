#if canImport(UIKit)
    import SwiftUI

    private struct PrototypeGlassNamespaceKey: EnvironmentKey {
        static let defaultValue: Namespace.ID? = nil
    }

    extension EnvironmentValues {
        var prototypeGlassNamespace: Namespace.ID? {
            get { self[PrototypeGlassNamespaceKey.self] }
            set { self[PrototypeGlassNamespaceKey.self] = newValue }
        }
    }

    /// Each authored group owns an independent namespace; nested groups establish a new scope.
    struct PrototypeGlassGroupView<Content: View>: View {
        let spacing: Double?
        @ViewBuilder let content: () -> Content
        @Namespace private var namespace

        var body: some View {
            if #available(iOS 26, *), let spacing {
                GlassEffectContainer(spacing: spacing) {
                    content().environment(\.prototypeGlassNamespace, namespace)
                }
            } else {
                content()
            }
        }
    }

    struct PrototypeGlassModifier: ViewModifier {
        let node: PrototypeNode
        let style: Style?
        let shape: PrototypeStyleShape
        let palette: PrototypePalette
        @Environment(\.prototypeGlassNamespace) private var namespace
        @Environment(\.prototypeSharedNamespace) private var sharedNamespace

        @ViewBuilder
        func body(content: Content) -> some View {
            if #available(iOS 26, *), style?.surface == "glass" {
                if let namespace = namespace ?? sharedNamespace {
                    painted(content)
                        .glassEffectID(node.shared?.key, in: namespace)
                        .glassEffectUnion(id: node.ios?.glassUnion, namespace: namespace)
                        .glassEffectTransition(transition)
                } else {
                    painted(content).glassEffectTransition(transition)
                }
            } else {
                content
            }
        }

        @available(iOS 26, *) private var glass: SwiftUI.Glass {
            let base: SwiftUI.Glass = style?.glass?.variant == "clear" ? .clear : .regular
            return base.tint(palette.color(style?.glass?.tint)).interactive(style?.glass?.interactive ?? false)
        }

        @available(iOS 26, *) private var transition: GlassEffectTransition {
            switch node.ios?.glassTransition {
            case "materialize": .materialize
            case "identity": .identity
            default: .matchedGeometry
            }
        }

        @available(iOS 26, *)
        @ViewBuilder
        private func painted(_ content: Content) -> some View {
            if style?.cornerRadius == nil {
                content.glassEffect(glass, in: Capsule())
            } else {
                content.glassEffect(glass, in: shape)
            }
        }
    }

    struct PrototypeBackgroundExtensionModifier: ViewModifier {
        let enabled: Bool
        func body(content: Content) -> some View {
            if #available(iOS 26, *), enabled {
                content.backgroundExtensionEffect()
            } else {
                content
            }
        }
    }

    struct PrototypeScrollEdgeEffectModifier: ViewModifier {
        let effect: String?
        let axis: String?
        func body(content: Content) -> some View {
            if #available(iOS 26, *), let effect {
                content.scrollEdgeEffectStyle(effect == "hard" ? .hard : .soft, for: edges)
                    .scrollEdgeEffectHidden(effect == "none", for: edges)
            } else {
                content
            }
        }

        private var edges: Edge.Set { axis == "horizontal" ? [.leading, .trailing] : [.top, .bottom] }
    }
#endif
