#if canImport(UIKit)
    import SwiftUI
    import UIKit

    @MainActor
    final class PrototypeOverlayFocusAnchor {
        weak var view: UIView?
        var previous: Any?

        func enter() {
            previous = UIAccessibility.focusedElement(using: .notificationVoiceOver)
            FrameWaiter.nextFrame { [weak self] in
                guard let container = self?.view?.superview else { return }
                UIAccessibility.post(notification: .layoutChanged, argument: container)
            }
        }

        func restore(target: PrototypeOverlayFocusAnchor? = nil) {
            let prior = previous
            FrameWaiter.nextFrame {
                UIAccessibility.post(notification: .layoutChanged, argument: target?.view?.superview ?? prior)
            }
            previous = nil
        }
    }

    @MainActor
    struct PrototypeOverlayFocusMarker: UIViewRepresentable {
        let anchor: PrototypeOverlayFocusAnchor
        func makeUIView(context _: Context) -> UIView {
            let view = UIView()
            view.isAccessibilityElement = false
            view.isUserInteractionEnabled = false
            anchor.view = view
            return view
        }

        func updateUIView(_ view: UIView, context _: Context) { anchor.view = view }
    }
#endif
