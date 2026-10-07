#if canImport(UIKit) && !os(watchOS)
    import UIKit

    /// CADisplayLink runs in the app process, on the main run loop.
    @MainActor
    final class DisplayLinkFrameTickSource: NSObject, FrameTickSource {
        private var displayLink: CADisplayLink?
        private var onTick: (@MainActor (TimeInterval, TimeInterval) -> Void)?

        func start(_ onTick: @escaping @MainActor (TimeInterval, TimeInterval) -> Void) {
            stop()
            self.onTick = onTick
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            displayLink = link
            link.add(to: .main, forMode: .common)
        }

        func stop() {
            displayLink?.invalidate()
            displayLink = nil
            onTick = nil
        }

        @objc private func tick(_ link: CADisplayLink) {
            onTick?(link.timestamp, link.targetTimestamp - link.timestamp)
        }
    }
#endif
