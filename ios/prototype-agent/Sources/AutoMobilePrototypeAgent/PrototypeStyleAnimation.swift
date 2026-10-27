#if canImport(UIKit)
    import SwiftUI

    /// Scoped modifier animations keep effects critically damped when spatial values overshoot.
    struct PrototypeStyleAnimation {
        let animate: Animate?
        let scheme: String?
        let motion: PrototypeMotion

        func animation(_ property: String) -> Animation? {
            guard let animate, motion.profile != .off else { return nil }
            if motion.profile != .full, PrototypeMotionTokens.role(property) == "spatial" { return nil }
            if animate.tempo != nil || animate.easing == "spring" {
                let token = PrototypeMotionTokens.token(
                    scheme: scheme == "expressive" ? "expressive" : "standard",
                    property: property, tempo: animate.tempo ?? "default"
                )
                return .interpolatingSpring(mass: token.mass, stiffness: token.stiffness, damping: token.damping)
            }
            let duration = Double(animate.durationMs ?? 300) / 1000
            switch animate.easing {
            case "linear": return .linear(duration: duration)
            case "emphasized": return .timingCurve(0.2, 0, 0, 1, duration: duration)
            default: return .timingCurve(0.4, 0, 0.2, 1, duration: duration)
            }
        }
    }

    struct PrototypeAnimatedTransform: ViewModifier {
        let style: Style?
        let animation: PrototypeStyleAnimation

        func body(content: Content) -> some View {
            let alpha = style?.alpha ?? 1.0
            let scale = CGFloat(style?.scale ?? 1.0)
            let rotation = Angle.degrees(style?.rotation ?? 0.0)
            let offset = CGSize(width: style?.offset?.x ?? 0.0, height: style?.offset?.y ?? 0.0)
            let faded = content.animation(animation.animation("alpha")) { view in view.opacity(alpha) }
            return faded.animation(animation.animation("scale")) { view in
                view.scaleEffect(scale).rotationEffect(rotation).offset(offset)
            }
        }
    }

    struct PrototypeAnimatedLayout: ViewModifier {
        let insets: EdgeInsets
        let rules: PrototypeSizeRules
        let alignment: Alignment
        let animation: PrototypeStyleAnimation

        func body(content: Content) -> some View {
            content.animation(animation.animation("padding")) {
                $0.padding(insets).modifier(SizeModifier(rules: rules, alignment: alignment))
            }
        }
    }
#endif
