#if canImport(SwiftUI) && canImport(UIKit)
    import SwiftUI

    struct PrototypeNamespaceButtonStyle: ViewModifier {
        let style: String?
        let variant: String?
        let tint: Color

        @ViewBuilder
        func body(content: Content) -> some View {
            if let style = PrototypeNamespacePolicy.buttonStyle(
                style,
                osMajor: ProcessInfo.processInfo.operatingSystemVersion.majorVersion
            ) {
                if #available(iOS 26.0, *) {
                    if style == "glassProminent" {
                        content.buttonStyle(.glassProminent).tint(tint)
                    } else {
                        content.buttonStyle(.glass).tint(tint)
                    }
                } else {
                    content.buttonStyle(.bordered).tint(tint)
                }
            } else {
                switch variant {
                case "outlined", "tonal": content.buttonStyle(.bordered).tint(tint)
                case "elevated": content.buttonStyle(.bordered).tint(tint)
                    .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
                case "text": content.buttonStyle(.borderless).tint(tint)
                default: content.buttonStyle(.borderedProminent).tint(tint)
                }
            }
        }
    }

    struct PrototypeNamespaceHover: ViewModifier {
        let effect: String?

        @ViewBuilder
        func body(content: Content) -> some View {
            if #available(iOS 17.0, *), let effect = PrototypeNamespacePolicy.hover(
                effect,
                osMajor: ProcessInfo.processInfo.operatingSystemVersion.majorVersion
            ) {
                content.hoverEffect(effect == "lift" ? .lift : .highlight)
            } else {
                content
            }
        }
    }
#endif
