#if DEBUG && !os(watchOS)
    import AutoMobileHighlightCore
    import Foundation
    #if canImport(UIKit)
        import UIKit
    #endif

    typealias SdkHighlightShape = CircleHighlight
    typealias SdkHighlightBounds = CircleBounds
    struct SdkAddHighlightBody: Codable {
        let id: String
        let shape: SdkHighlightShape
    }

    #if canImport(UIKit)
        @MainActor
        final class SdkHighlightOverlayManager {
            static let shared = SdkHighlightOverlayManager()
            private var window: UIWindow?
            private struct Entry {
                let layer: HandDrawnCircleLayer
                let bounds: CGRect
                let started: TimeInterval
            }

            private var layers: [String: Entry] = [:]
            private var timer: Timer?
            private let now: () -> TimeInterval
            init(now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
                self.now = now
            }

            isolated deinit { timer?.invalidate() }

            @discardableResult
            func show(id: String, shape: SdkHighlightShape) -> Bool {
                guard !id.isEmpty else { return false }
                let window = ensureWindow()
                guard let bounds = shape.bounds.scaled(to: window.bounds.size) else { return false }
                layers[id]?.layer.removeFromSuperlayer()
                let layer = HandDrawnCircleLayer()
                layer.frame = window.bounds
                layer.configure(rect: bounds, strokeScale: bounds.width / CGFloat(shape.bounds.width))
                layer.update(elapsed: 0)
                window.layer.addSublayer(layer)
                layers[id] = Entry(layer: layer, bounds: bounds, started: now())
                if timer == nil {
                    let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
                        // This timer is registered only on RunLoop.main below.
                        MainActor.assumeIsolated { self?.tick() }
                    }
                    RunLoop.main.add(timer, forMode: .common)
                    self.timer = timer
                }
                return true
            }

            private func tick() {
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                for (id, entry) in layers {
                    let elapsed = now() - entry.started
                    if elapsed >= HandDrawnCircle.duration {
                        remove(id: id)
                    } else {
                        entry.layer.update(elapsed: elapsed)
                    }
                }
                CATransaction.commit()
            }

            func renderedPathBounds(id: String) -> CGRect? {
                layers[id]?.bounds
            }

            func renderTargetSize() -> CGSize? {
                window?.bounds.size
            }

            func remove(id: String) {
                layers.removeValue(forKey: id)?.layer.removeFromSuperlayer()
                if layers.isEmpty {
                    timer?.invalidate()
                    timer = nil
                    window?.isHidden = true
                    window = nil
                }
            }

            private func ensureWindow() -> UIWindow {
                if let window {
                    return window
                }
                let newWindow: UIWindow
                if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
                    newWindow = UIWindow(windowScene: scene)
                } else {
                    newWindow = UIWindow(frame: UIScreen.main.bounds)
                }
                newWindow.windowLevel = .alert + 1
                newWindow.isUserInteractionEnabled = false
                newWindow.backgroundColor = .clear
                let rootViewController = UIViewController()
                rootViewController.view.backgroundColor = .clear
                newWindow.rootViewController = rootViewController
                newWindow.isHidden = false
                window = newWindow
                return newWindow
            }
        }
    #endif
#endif
