#if canImport(UIKit)
    import SwiftUI

    // Replace with motion tokens when available (#15243).
    private enum PrototypeContentTiming {
        static let roll = Animation.spring(duration: 0.35, bounce: 0.15)
        static let fade = Animation.easeInOut(duration: 0.2)
    }

    struct PrototypeContentTransitionModifier: ViewModifier {
        let text: String
        let mode: String?
        let rich: Bool
        let motion: PrototypeMotion

        func body(content: Content) -> some View {
            if let mode, mode != "none", motion.spatial {
                let number = rich || mode != "numeric" ? nil : parseContentTransitionNumber(text)
                ZStack {
                    content
                        .contentTransition(number.map { .numericText(value: $0) } ?? .opacity)
                        .animation(
                            number == nil ? PrototypeContentTiming.fade : PrototypeContentTiming.roll,
                            value: text
                        )
                        .accessibilityHidden(true)
                    // The current label is independent of SwiftUI's outgoing animation layer.
                    Text(text).opacity(0).allowsHitTesting(false).accessibilityHidden(false)
                }
            } else {
                content
            }
        }
    }
#endif
