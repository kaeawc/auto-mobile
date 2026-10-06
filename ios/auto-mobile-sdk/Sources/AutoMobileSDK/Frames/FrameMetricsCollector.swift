import Foundation

/// Display timestamps and nominal intervals are monotonic seconds, independent of wall time.
@MainActor
protocol FrameTickSource: AnyObject {
    func start(_ onTick: @escaping @MainActor (TimeInterval, TimeInterval) -> Void)
    func stop()
}

/// Main-actor confinement keeps UIKit callbacks and lifecycle changes serialized.
@MainActor
final class FrameMetricsCollector {
    private let source: any FrameTickSource
    private let dateProvider: any DateProvider
    private let buffer: any EventBuffering
    private var enabled = false
    private var previousTimestamp: TimeInterval?
    private var windowStart: TimeInterval?
    private var frameCount = 0
    private var totalFrameTime: TimeInterval = 0
    private var jankFrames = 0

    init(source: any FrameTickSource, dateProvider: any DateProvider, buffer: any EventBuffering) {
        self.source = source
        self.dateProvider = dateProvider
        self.buffer = buffer
    }

    func setEnabled(_ enabled: Bool) {
        guard self.enabled != enabled else { return }
        self.enabled = enabled
        resetWindow()
        if enabled {
            source.start { [weak self] timestamp, nominalInterval in
                self?.tick(timestamp: timestamp, nominalInterval: nominalInterval)
            }
        } else {
            source.stop()
        }
    }

    private func resetWindow() {
        previousTimestamp = nil
        windowStart = nil
        frameCount = 0
        totalFrameTime = 0
        jankFrames = 0
    }

    private func tick(timestamp: TimeInterval, nominalInterval: TimeInterval) {
        guard enabled, timestamp.isFinite, nominalInterval.isFinite, nominalInterval > 0 else { return }
        guard let previousTimestamp, let windowStart else {
            self.previousTimestamp = timestamp
            self.windowStart = timestamp
            return
        }
        let delta = timestamp - previousTimestamp
        guard delta > 0 else { return }
        self.previousTimestamp = timestamp
        frameCount += 1
        totalFrameTime += delta
        // A frame is janky when its actual delta exceeds 1.5 times the nominal
        // interval advertised for this tick (supports variable display refresh rates).
        if delta > 1.5 * nominalInterval { jankFrames += 1 }
        let elapsed = timestamp - windowStart
        guard elapsed >= 1, frameCount > 0 else { return }
        buffer.add(SdkFrameMetricsEvent(
            timestamp: Int64(dateProvider.now().timeIntervalSince1970 * 1000),
            fps: Double(frameCount) / elapsed,
            frameTimeMs: totalFrameTime * 1000 / Double(frameCount),
            jankFrames: jankFrames
        ))
        // Keep the boundary tick as the next window's baseline. No frames means
        // no ticks and no event; disabling discards the partial window.
        self.windowStart = timestamp
        frameCount = 0
        totalFrameTime = 0
        jankFrames = 0
    }
}
