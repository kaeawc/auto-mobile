#if DEBUG && !os(watchOS)
    import Foundation

    @MainActor
    protocol MagicTapResponding: AnyObject {
        var magicTapNext: (any MagicTapResponding)? { get }
        func performMagicTap() -> Bool
    }

    enum SdkMagicTap {
        /// Try each responder once, stopping at the first handler. Fallbacks cover
        /// a missing first responder and chains that do not reach the application.
        @MainActor
        static func perform(start: (any MagicTapResponding)?, fallbacks: [any MagicTapResponding]) -> Bool {
            var visited = Set<ObjectIdentifier>()
            for root in [start].compactMap({ $0 }) + fallbacks {
                var current: (any MagicTapResponding)? = root
                while let responder = current, visited.insert(ObjectIdentifier(responder)).inserted {
                    if responder.performMagicTap() { return true }
                    current = responder.magicTapNext
                }
            }
            return false
        }
    }

    #if canImport(UIKit)
        import UIKit

        extension UIResponder: MagicTapResponding {
            var magicTapNext: (any MagicTapResponding)? { next }
            func performMagicTap() -> Bool { accessibilityPerformMagicTap() }

            @objc
            fileprivate func automobileCaptureMagicTapResponder(_ sender: Any?) {
                guard isFirstResponder, let capture = sender as? MagicTapResponderCapture else { return }
                capture.responder = self
            }
        }

        @MainActor
        private final class MagicTapResponderCapture {
            weak var responder: UIResponder?
        }

        extension SdkMagicTap {
            @MainActor
            static func performInApplication() -> Bool {
                let application = UIApplication.shared
                let window = application.connectedScenes
                    .compactMap { $0 as? UIWindowScene }
                    .filter { $0.activationState == .foregroundActive }
                    .flatMap(\.windows).first(where: \.isKeyWindow)
                // UIKit's nil-target action lookup reaches non-view first responders
                // too (for example a view controller), unlike searching subviews.
                let capture = MagicTapResponderCapture()
                application.sendAction(
                    #selector(UIResponder.automobileCaptureMagicTapResponder(_:)),
                    to: nil, from: capture, for: nil
                )
                let fallbacks: [any MagicTapResponding] = window.map { [$0, application] } ?? [application]
                return perform(start: capture.responder, fallbacks: fallbacks)
            }
        }
    #endif
#endif
