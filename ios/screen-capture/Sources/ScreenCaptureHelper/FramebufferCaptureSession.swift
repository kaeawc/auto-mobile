import CoreMedia
import CoreVideo
import Foundation
import IOSurface
import ScreenCaptureCore

/// Streams H.264 from a booted Simulator's main-display IOSurface (#19015).
///
/// Unlike `SimulatorCaptureSession` this needs no Simulator.app or Device Hub
/// window and no Screen Recording permission. A timer polls the surface at the
/// requested fps; `FramebufferFrameGate` encodes only when the surface's seed
/// changes or a keyframe is requested. The surface is wrapped with
/// `CVPixelBufferCreateWithIOSurface` (no copy) and fed to the same
/// `EncodePipeline` the window and device paths use, sized like the device path:
/// the encoder gets the Level 4.2 / `--max-long-side` target and VideoToolbox
/// scales the full-resolution BGRA surface into it.
///
/// `@unchecked Sendable`: every mutable field is confined to `queue` (the timer
/// handler, `start()`'s first tick and `stop()`'s teardown all run there).
final class FramebufferCaptureSession: @unchecked Sendable {
    private let writer: FrameWriter
    private let source: SimulatorFramebufferSource
    private let encodeSettings: CommandLineOptions.EncodeSettings
    private let fps: Int
    private let diagnosticSink: (String) -> Void
    private let uptime: () -> TimeInterval
    private let onFatalError: (Error) -> Void
    private let queue = DispatchQueue(label: "automobile.simulator-framebuffer.frames")
    /// Force-keyframe latch shared with the STDIN control channel.
    let forceKeyFrameLatch = ForceKeyFrameLatch()

    private var gate = FramebufferFrameGate()
    private var pipeline: EncodePipeline?
    private var surface: IOSurfaceRef?
    private var pixelBuffer: CVPixelBuffer?
    private var timer: DispatchSourceTimer?
    private var firstFrameReported = false
    private var stopped = false
    /// Encoded frame count, for tests and the first-frame marker.
    private(set) var encodedFrames = 0

    init(
        writer: FrameWriter,
        source: SimulatorFramebufferSource,
        fps: Int,
        encode: CommandLineOptions.EncodeSettings,
        diagnosticSink: @escaping (String) -> Void = { line in DescriptorWrite.writeDiagnostic(line) },
        uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        onFatalError: @escaping (Error) -> Void
    ) {
        self.writer = writer
        self.source = source
        self.fps = fps
        encodeSettings = encode
        self.diagnosticSink = diagnosticSink
        self.uptime = uptime
        self.onFatalError = onFatalError
    }

    /// Fetch the surface once synchronously, so a missing private API or an
    /// unbooted device fails startup (exit 1) instead of a running stream, then
    /// start the poll timer.
    func start() throws {
        try queue.sync {
            pipeline = EncodePipeline(
                writer: writer,
                fps: fps,
                source: .simulator,
                bitrate: encodeSettings.bitrate,
                forceKeyFrameLatch: forceKeyFrameLatch,
                diagnosticSink: diagnosticSink,
                onFatalError: onFatalError
            )
            try refetchSurface(now: uptime())
        }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let interval = DispatchTimeInterval.nanoseconds(1_000_000_000 / max(fps, 1))
        timer.schedule(deadline: .now(), repeating: interval, leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in self?.tick() }
        queue.sync { self.timer = timer }
        timer.resume()
    }

    func stop() {
        queue.sync {
            timer?.cancel()
            timer = nil
            stopped = true
            pipeline?.stop()
            pipeline = nil
            pixelBuffer = nil
            surface = nil
        }
    }

    /// One poll. `internal` so tests can drive it without the timer; callers
    /// outside tests reach it only through the timer on `queue`.
    func tick() {
        autoreleasepool {
            guard !stopped, let pipeline else { return }
            let now = uptime()
            if gate.shouldRefetchSurface(now: now) {
                do {
                    try refetchSurface(now: now)
                } catch {
                    stopped = true
                    onFatalError(error)
                    return
                }
            }
            guard let surface, let pixelBuffer else { return }
            let surfaceID = IOSurfaceGetID(surface)
            let seed = IOSurfaceGetSeed(surface)
            guard gate.shouldEncode(
                surfaceID: surfaceID,
                seed: seed,
                keyFrameRequested: forceKeyFrameLatch.isPending
            ) else { return }
            let width = CVPixelBufferGetWidth(pixelBuffer)
            let height = CVPixelBufferGetHeight(pixelBuffer)
            let target = H264EncodeMath.resolveEncoderScale(
                H264EncodeMath.EncoderSize(width: width, height: height),
                maxLongSide: encodeSettings.maxLongSide
            ) ?? H264EncodeMath.EncoderSize(width: width, height: height)
            guard pipeline.ensureEncoder(width: target.width, height: target.height) else { return }
            let pts = CMTime(seconds: now, preferredTimescale: 1_000_000)
            guard pipeline.encode(pixelBuffer: pixelBuffer, presentationTime: pts) else { return }
            gate.recordEncoded(surfaceID: surfaceID, seed: seed)
            encodedFrames += 1
            if !firstFrameReported {
                firstFrameReported = true
                diagnosticSink(
                    "framebuffer-capture: first-frame source=\(width)x\(height) "
                        + "encoded=\(target.width)x\(target.height)\n"
                )
            }
        }
    }

    private func refetchSurface(now: TimeInterval) throws {
        let fetched = try source.mainDisplaySurface()
        gate.recordSurfaceFetch(now: now)
        if let surface, IOSurfaceGetID(surface) == IOSurfaceGetID(fetched), pixelBuffer != nil {
            return
        }
        var buffer: Unmanaged<CVPixelBuffer>?
        let status = CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, fetched, nil, &buffer)
        guard status == kCVReturnSuccess, let buffer else {
            throw SimulatorFramebufferError(message: "CVPixelBufferCreateWithIOSurface failed with status \(status).")
        }
        surface = fetched
        pixelBuffer = buffer.takeRetainedValue()
    }
}
