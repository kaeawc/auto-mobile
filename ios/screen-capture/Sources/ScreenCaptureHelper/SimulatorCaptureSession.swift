import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import ScreenCaptureCore

/// The subset of `SCStream` operations `SimulatorCaptureSession` drives. Wrapping
/// them in a protocol is the seam that lets unit tests inject a fake stream and
/// exercise the session's lifecycle paths (start/stop/reconfigure/fatal-error)
/// without a real Simulator window or Screen Recording permission (issue #4771).
/// The signatures match `SCStream`'s exactly so it conforms without adapters.
protocol CaptureStream: AnyObject {
    func addStreamOutput(
        _ output: SCStreamOutput,
        type: SCStreamOutputType,
        sampleHandlerQueue: DispatchQueue?
    ) throws
    func removeStreamOutput(_ output: SCStreamOutput, type: SCStreamOutputType) throws
    func startCapture() async throws
    func stopCapture() async throws
    func updateConfiguration(_ configuration: SCStreamConfiguration) async throws
}

extension SCStream: CaptureStream {}

/// Streams BGRA frames from a single iOS Simulator window via ScreenCaptureKit.
/// The frame rate is configurable (5–60); 5 is the default for typical MCP
/// automation workloads. Size changes (e.g. device rotation) trigger a stream
/// reconfiguration so frames don't get cropped.
final class SimulatorCaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    /// Builds the concrete stream for a resolved window. Injected so tests can
    /// substitute a fake `CaptureStream`; the default wires the real `SCStream`.
    typealias StreamFactory = (SCContentFilter, SCStreamConfiguration, SCStreamDelegate) -> CaptureStream

    private let writer: FrameWriter
    private let onFatalError: (Error) -> Void
    private let makeStream: StreamFactory
    /// In-helper H.264 encode settings (issue #4788). `nil` keeps the default
    /// raw-BGRA path byte-for-byte unchanged.
    private let encodeSettings: CommandLineOptions.EncodeSettings?
    /// Force-keyframe latch shared with the STDIN control channel; consumed by
    /// the encoder on the next frame. Present even in raw mode (harmless there).
    let forceKeyFrameLatch = ForceKeyFrameLatch()
    /// Guards the mutable frame-path state shared across the ScreenCaptureKit frame
    /// queue (`didOutputSampleBuffer`), the MainActor `start()`/`stop()`, and the
    /// reconfigure `Task`: the encode `pipeline`, the `stream`, the configured
    /// dimensions, and the reconfigure-in-flight flag. Snapshot-under-lock-then-act;
    /// the lock is never held across an `await` or a blocking call.
    private let stateLock = NSLock()
    /// Shared in-helper encode wiring in `--encode h264` mode (issues #4788 /
    /// #4790). `nil` in the raw-BGRA path. The same `EncodePipeline` type backs the
    /// physical-device capture session, so the VideoToolbox glue lives in exactly
    /// one place. Guarded by `stateLock`.
    private var _pipeline: EncodePipeline?
    private var _stream: CaptureStream?
    private var _configuredPixelWidth = 0
    private var _configuredPixelHeight = 0
    /// True while an async `updateConfiguration` dispatched by `reconfigure` is in
    /// flight, so a burst of same-size frames does not spawn overlapping updates.
    private var _reconfiguring = false

    /// Pixel format requested from ScreenCaptureKit — 32BGRA for the raw path,
    /// 420v (NV12) for the lowest-CPU encode path. Set once in `start()` before
    /// frames flow, then read-only.
    var configuredPixelFormat: OSType = kCVPixelFormatType_32BGRA
    /// Diagnostic lines (first-frame marker, reconfigure warnings) go here so
    /// tests can observe them; the default preserves the stderr behavior.
    private let diagnosticSink: (String) -> Void
    private let queue = DispatchQueue(label: "automobile.simulator-capture.frames")
    let firstFrameSignal = FirstFrameSignal()

    // The `stream`/`configuredPixel*` accessors are `internal` (not `private`) and
    // `stateLock`-guarded so `@testable` tests can seed and inspect lifecycle state
    // that `start()` would otherwise set only behind a real `SCWindow`. They are not
    // part of the production API surface.
    var stream: CaptureStream? {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _stream }
        set { stateLock.lock(); _stream = newValue; stateLock.unlock() }
    }

    var configuredPixelWidth: Int {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _configuredPixelWidth }
        set { stateLock.lock(); _configuredPixelWidth = newValue; stateLock.unlock() }
    }

    var configuredPixelHeight: Int {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _configuredPixelHeight }
        set { stateLock.lock(); _configuredPixelHeight = newValue; stateLock.unlock() }
    }

    // Set once in `start()` before frames flow, then read-only, so no lock needed.
    var fps: Int = CommandLineOptions.defaultSimulatorFPS
    var audioEnabled = false
    var windowID: UInt32 = 0

    /// Upper bound on `stream.startCapture()`. ScreenCaptureKit cold-start on
    /// hosted `macos26` runners is slow-but-finite (measured 2.6–13s); this
    /// deadline sits above that healthy window yet below the parent supervisor's
    /// 15s first-frame SIGTERM (`IOS_FIRST_FRAME_TIMEOUT_MS`), so a genuinely
    /// hung start is surfaced as a specific `error:` line rather than silent
    /// frame starvation. See issues #4350 / #4764.
    static let startCaptureDeadlineSeconds: TimeInterval = 14.0

    /// Effective deadline the `startCapture()` race uses, defaulting to the
    /// production `startCaptureDeadlineSeconds`. `internal` (not a constant) only
    /// so `@testable` tests can shrink it to exercise the hung-start path without
    /// a real 14s wait; production never mutates it. See issue #4350.
    var startCaptureDeadlineSeconds: TimeInterval = SimulatorCaptureSession.startCaptureDeadlineSeconds

    init(
        writer: FrameWriter,
        makeStream: @escaping StreamFactory = { filter, config, delegate in
            SCStream(filter: filter, configuration: config, delegate: delegate)
        },
        diagnosticSink: @escaping (String) -> Void = { line in
            FileHandle.standardError.write(Data(line.utf8))
        },
        encode: CommandLineOptions.EncodeSettings? = nil,
        onFatalError: @escaping (Error) -> Void
    ) {
        self.writer = writer
        self.makeStream = makeStream
        self.diagnosticSink = diagnosticSink
        self.encodeSettings = encode
        self.onFatalError = onFatalError
    }

    /// Whether this session encodes H.264 in-process instead of streaming raw
    /// BGRA.
    var isEncoding: Bool { encodeSettings != nil }

    func start(window: SCWindow, fps: Int, audio: Bool) async throws {
        self.fps = fps
        audioEnabled = audio
        windowID = window.windowID
        // 420v (NV12) is the lowest-CPU encode input: the delivered
        // IOSurface-backed CVPixelBuffer feeds VTCompressionSession directly with
        // no color conversion. The raw path keeps 32BGRA untouched.
        if let encodeSettings = encodeSettings {
            configuredPixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            // Set before frames flow (before `beginCapture` starts the stream), so a
            // direct field write is safe here.
            _pipeline = EncodePipeline(
                writer: writer,
                fps: fps,
                source: .simulator,
                bitrate: encodeSettings.bitrate,
                forceKeyFrameLatch: forceKeyFrameLatch,
                diagnosticSink: diagnosticSink,
                onFatalError: onFatalError
            )
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SimulatorCaptureSession.makeConfiguration(
            window: window, fps: fps, audio: audio, pixelFormat: configuredPixelFormat
        )
        configuredPixelWidth = config.width
        configuredPixelHeight = config.height

        let stream = makeStream(filter, config, self)
        try await beginCapture(with: stream, audio: audio)
    }

    /// Wires outputs onto an already-built stream and starts it. Split out from
    /// `start()` so tests can drive it with a fake `CaptureStream` — the window
    /// resolution and filter/config construction above need real SCK objects.
    func beginCapture(with stream: CaptureStream, audio: Bool) async throws {
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if audio {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        }
        try await startCapture(stream)
        self.stream = stream
    }

    /// Races `stream.startCapture()` against `startCaptureDeadlineSeconds`.
    ///
    /// A hung `startCapture()` does not honor Swift task cancellation, so a
    /// structured `withThrowingTaskGroup` would block on teardown awaiting the
    /// very task we are trying to abandon. Instead the two arms run as
    /// unstructured tasks and the first to finish wins; on timeout the stalled
    /// capture task is left to be reaped by process exit, which the parent
    /// triggers immediately after seeing the `error:` diagnostic.
    private func startCapture(_ stream: CaptureStream) async throws {
        let race = StartRaceState()
        // Snapshot the deadline into a Sendable local so the unstructured tasks
        // below capture a value rather than the non-Sendable session.
        let deadlineSeconds = startCaptureDeadlineSeconds
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let capture = Task {
                do {
                    try await stream.startCapture()
                    if race.finish() { continuation.resume() }
                } catch {
                    if race.finish() { continuation.resume(throwing: error) }
                }
            }
            Task {
                let deadlineNanos = UInt64(deadlineSeconds * 1_000_000_000)
                try? await Task.sleep(nanoseconds: deadlineNanos)
                if race.finish() {
                    capture.cancel()
                    continuation.resume(
                        throwing: StartCaptureTimeoutError(deadlineSeconds: deadlineSeconds)
                    )
                }
            }
        }
    }

    func stop() async {
        stateLock.lock()
        let pipeline = _pipeline
        let stream = _stream
        _pipeline = nil
        _stream = nil
        stateLock.unlock()

        // Tear the encoder down ON the frame queue so it cannot overlap an in-flight
        // `encode`/`ensureEncoder` call (both run on `queue`). `queue.sync` waits for
        // any executing frame callback to finish first, so the VideoToolbox session is
        // never invalidated underneath a frame being encoded (the teardown
        // use-after-free the raw MainActor nil-out risked). Safe from MainActor — this
        // is never called on `queue`.
        if let pipeline = pipeline {
            queue.sync { pipeline.stop() }
        }
        guard let stream = stream else { return }
        // removeStreamOutput breaks the SCStream → self retain cycle so the
        // session is collectable even before SCStream itself goes away.
        try? stream.removeStreamOutput(self, type: .screen)
        try? await stream.stopCapture()
    }

    // MARK: - SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard sampleBuffer.isValid else { return }
        if type == .audio {
            if let pcm16le = pcm16leAudio(sampleBuffer: sampleBuffer) {
                writer.writeAudio(pcm16le: pcm16le)
            }
            return
        }
        guard type == .screen else { return }

        // Drop non-complete statuses (idle, blank, suspended, stopped) so we
        // don't re-emit identical pixels or partial buffers.
        if let status = SimulatorCaptureSession.frameStatus(of: sampleBuffer),
           status != .complete {
            return
        }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let actualWidth = CVPixelBufferGetWidth(pixelBuffer)
        let actualHeight = CVPixelBufferGetHeight(pixelBuffer)

        if isEncoding {
            encodeScreenFrame(
                pixelBuffer: pixelBuffer, sampleBuffer: sampleBuffer,
                width: actualWidth, height: actualHeight
            )
            return
        }

        let (configuredWidth, configuredHeight) = currentConfiguredSize()
        if actualWidth != configuredWidth || actualHeight != configuredHeight {
            reconfigure(width: actualWidth, height: actualHeight)
        }

        if writer.write(sampleBuffer: sampleBuffer) {
            noteFrameWritten(width: actualWidth, height: actualHeight)
        }
    }

    /// Encode-mode screen path (issue #4788). Converges the ScreenCaptureKit
    /// output size to the Level 4.2 macroblock-budgeted encode resolution — so
    /// SCK does the downscale, not a separate stage — then feeds the delivered
    /// 420v buffer straight to VideoToolbox. On a size change the encoder is torn
    /// down and recreated (seamless reconfig); the new session's first frame is a
    /// fresh SPS/PPS + IDR.
    private func encodeScreenFrame(
        pixelBuffer: CVPixelBuffer,
        sampleBuffer: CMSampleBuffer,
        width: Int,
        height: Int
    ) {
        guard let pipeline = currentPipeline() else { return }
        let target = H264EncodeMath.resolveEncoderScale(
            H264EncodeMath.EncoderSize(width: width, height: height)
        ) ?? H264EncodeMath.EncoderSize(width: width, height: height)

        // Ask SCK to deliver the encode resolution. Until it does, skip encoding
        // rather than feed VideoToolbox a mismatched buffer size. (The device path
        // cannot reshape its delivery size, so it instead sizes the encoder to the
        // target and lets VideoToolbox scale the native buffer — the divergence the
        // shared pipeline is designed around.)
        if width != target.width || height != target.height {
            reconfigure(width: target.width, height: target.height)
            return
        }

        // Delivered size now equals the encode target. (Re)create the encoder if
        // absent or sized for a previous resolution.
        guard pipeline.ensureEncoder(width: target.width, height: target.height) else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if pipeline.encode(pixelBuffer: pixelBuffer, presentationTime: pts) {
            noteFrameWritten(width: target.width, height: target.height)
        }
    }

    /// Emits the first-frame marker exactly once and records that frames are
    /// flowing. Split out from the frame callback so tests can assert the
    /// once-only marker emission without synthesizing a `CMSampleBuffer`.
    func noteFrameWritten(width: Int, height: Int) {
        if !firstFrameSignal.hasReceivedFrame {
            // Emitted from the frame queue to confirm the source actually
            // started delivering frames — the "captureStarted but no
            // firstFrame" distinction issue #4350 needs.
            let marker = CaptureStartupMarker.line(
                .firstFrame(windowID: windowID, width: width, height: height)
            )
            diagnosticSink("\(marker)\n")
        }
        firstFrameSignal.markReceivedFrame()
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        handleFatalStop(error: error)
    }

    /// Routes a stream stop to the fatal-error handler. Split out from the
    /// delegate callback so tests can drive it without a real `SCStream`.
    func handleFatalStop(error: Error) {
        onFatalError(error)
    }

    // MARK: - Internals

    /// Snapshot of the encode pipeline under `stateLock`, for use on the frame queue.
    private func currentPipeline() -> EncodePipeline? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _pipeline
    }

    /// Atomic snapshot of the configured dimensions under `stateLock`, so the frame
    /// callback's mismatch check never reads a torn (width, height) pair.
    private func currentConfiguredSize() -> (width: Int, height: Int) {
        stateLock.lock()
        defer { stateLock.unlock() }
        return (_configuredPixelWidth, _configuredPixelHeight)
    }

    /// Kicks off a size change from the frame queue. `beginReconfigure` commits the
    /// new size synchronously and dedups, so a burst of same-size frames neither
    /// races the dimension writes nor spawns overlapping `updateConfiguration` calls
    /// (the reconfigure storm). The retry inside `applyStreamConfiguration` bounds
    /// recovery so a single transient failure does not strand the stream at a stale
    /// size (issue #4768); `endReconfigure` then releases the in-flight slot.
    private func reconfigure(width: Int, height: Int) {
        guard let stream = beginReconfigure(width: width, height: height) else { return }
        Task { [weak self] in
            await self?.applyStreamConfiguration(stream: stream, width: width, height: height)
            self?.endReconfigure()
        }
    }

    /// Commits the new size under `stateLock` and claims the reconfigure slot,
    /// returning the stream to update — or `nil` when there is no stream, or an
    /// update is already in flight (dedup). Synchronous, so once a frame commits a
    /// size, a same-size burst no longer re-triggers. Internal so tests can drive the
    /// dedup deterministically.
    func beginReconfigure(width: Int, height: Int) -> CaptureStream? {
        stateLock.lock()
        defer { stateLock.unlock() }
        // No stream: nothing to reconfigure, and committing a size here would be wrong
        // if a frame slipped in before `beginCapture` stored the stream. Leave it.
        guard let stream = _stream else { return nil }
        _configuredPixelWidth = width
        _configuredPixelHeight = height
        if _reconfiguring { return nil }
        _reconfiguring = true
        return stream
    }

    /// Releases the reconfigure slot claimed by `beginReconfigure`. Internal for tests.
    func endReconfigure() {
        stateLock.lock()
        _reconfiguring = false
        stateLock.unlock()
    }

    /// Applies a new capture size to the given stream. Split out so tests can `await`
    /// it deterministically and assert both the success path and the swallowed-failure
    /// warning. Reads only the set-once `configuredPixelFormat`/`fps`/`audioEnabled`.
    private func applyStreamConfiguration(stream: CaptureStream, width: Int, height: Int) async {
        let updated = SCStreamConfiguration()
        updated.width = width
        updated.height = height
        updated.pixelFormat = configuredPixelFormat
        updated.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        updated.showsCursor = false
        updated.scalesToFit = false
        updated.capturesAudio = audioEnabled
        updated.sampleRate = 8_000
        updated.channelCount = 1

        // Retry once on failure before giving up: `updateConfiguration` can fail
        // transiently while ScreenCaptureKit is mid-frame, and silently keeping
        // the stale config would drift delivered pixels away from the size the
        // supervisor expects — which the TS side then kills on as a mismatch.
        // The new dimensions are already recorded, so on ultimate failure the next
        // size change still attempts a correcting update.
        do {
            try await stream.updateConfiguration(updated)
            return
        } catch {
            diagnosticSink("warn: stream configuration update failed; retrying once: \(error)\n")
        }

        do {
            try await stream.updateConfiguration(updated)
        } catch {
            diagnosticSink("warn: failed to update stream configuration after retry: \(error)\n")
        }
    }

    /// Applies a new capture size to the live stream. Retained as the directly-`await`able
    /// test seam for the `updateConfiguration` success/retry/failure paths; production goes
    /// through `reconfigure` → `beginReconfigure`. Commits the size under the lock (only when a
    /// stream is present) then applies it.
    func performReconfiguration(width: Int, height: Int) async {
        stateLock.lock()
        guard let stream = _stream else {
            stateLock.unlock()
            return
        }
        _configuredPixelWidth = width
        _configuredPixelHeight = height
        stateLock.unlock()
        await applyStreamConfiguration(stream: stream, width: width, height: height)
    }

    private static func makeConfiguration(
        window: SCWindow,
        fps: Int,
        audio: Bool,
        pixelFormat: OSType = kCVPixelFormatType_32BGRA
    ) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        // Logical (points) size; the delivered CVPixelBuffer is in native
        // pixels (2x/3x for Retina), and downstream consumers must use
        // CVPixelBufferGetWidth/Height — not these values — to allocate sinks.
        config.width = Int(window.frame.width)
        config.height = Int(window.frame.height)
        config.pixelFormat = pixelFormat
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.showsCursor = false
        config.scalesToFit = false
        config.capturesAudio = audio
        config.sampleRate = 8_000
        config.channelCount = 1
        return config
    }

    private static func frameStatus(of sampleBuffer: CMSampleBuffer) -> SCFrameStatus? {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let info = attachments.first,
            let rawStatus = info[.status] as? Int,
            let status = SCFrameStatus(rawValue: rawStatus)
        else {
            return nil
        }
        return status
    }
}

/// Thrown when `SimulatorCaptureSession` gives up waiting on `startCapture()`.
/// Conforms to `CustomStringConvertible` so `main.swift`'s `error:` line names
/// the stalled startup stage (`starting-capture` seen, `capture-started`
/// absent), letting the parent supervisor fail fast with a specific cause
/// instead of frame starvation. See issues #4350 / #4764.
/// Raised when the encoder's bounded output queue overflows (issue #4788). The
/// encoded path never drops an emitted record, so overflow is fatal: `main.swift`
/// exits and the supervisor relaunches the helper with a fresh IDR.
struct EncoderOutputOverflowError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

struct StartCaptureTimeoutError: Error, CustomStringConvertible {
    let deadlineSeconds: TimeInterval

    var description: String {
        "startCapture() exceeded \(deadlineSeconds)s deadline "
            + "(stage: starting-capture seen, capture-started absent)"
    }
}

/// Single-winner guard for the `startCapture()` deadline race. `finish()`
/// returns `true` exactly once, so the checked continuation is resumed by
/// whichever arm — capture or timeout — completes first.
final class StartRaceState: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false

    func finish() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if finished { return false }
        finished = true
        return true
    }
}

/// Cross-queue state shared by the ScreenCaptureKit frame callback and the
/// main-run-loop permission hint. Every access is protected by `lock`.
final class FirstFrameSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var receivedFrame = false

    var hasReceivedFrame: Bool {
        lock.lock()
        defer { lock.unlock() }
        return receivedFrame
    }

    func markReceivedFrame() {
        lock.lock()
        receivedFrame = true
        lock.unlock()
    }
}
