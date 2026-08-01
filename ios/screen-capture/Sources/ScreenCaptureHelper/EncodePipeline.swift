import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureCore

/// Shared in-helper H.264 encode wiring (issues #4788 / #4790).
///
/// Both the Simulator (`SimulatorCaptureSession`, ScreenCaptureKit) and the
/// physical-device (`DeviceCaptureSession`, AVFoundation) capture sessions feed
/// this ONE stage instead of each duplicating the VideoToolbox glue. It owns:
///   - the `H264VideoEncoder` lifecycle (create / resize-recreate / stop),
///   - the source-aware `AverageBitRate` resolution (via the pure
///     `H264EncodeMath.resolveAverageBitRateBps`), and
///   - the force-keyframe latch handoff to the encoder.
///
/// The pipeline is deliberately capture-source-agnostic about *sizing*: each
/// caller resolves the encode-target size itself — the Simulator reconfigures
/// ScreenCaptureKit to deliver exactly that size, while the device leaves the
/// native buffer as-is and lets VideoToolbox scale it — then hands the pipeline a
/// ready target and pixel buffer. The only source-dependent decision the pipeline
/// makes is the bitrate policy, which it delegates to the pure math layer so the
/// Simulator-only bits-per-pixel gating stays unit-tested.
final class EncodePipeline {
    private let writer: FrameWriter
    private let fps: Int
    private let source: H264EncodeMath.CaptureSource
    private let bitrate: CommandLineOptions.EncodeSettings.Bitrate
    private let forceKeyFrameLatch: ForceKeyFrameLatch
    private let diagnosticSink: (String) -> Void
    private let onFatalError: (Error) -> Void
    private var encoder: H264VideoEncoder?

    init(
        writer: FrameWriter,
        fps: Int,
        source: H264EncodeMath.CaptureSource,
        bitrate: CommandLineOptions.EncodeSettings.Bitrate,
        forceKeyFrameLatch: ForceKeyFrameLatch,
        diagnosticSink: @escaping (String) -> Void,
        onFatalError: @escaping (Error) -> Void
    ) {
        self.writer = writer
        self.fps = fps
        self.source = source
        self.bitrate = bitrate
        self.forceKeyFrameLatch = forceKeyFrameLatch
        self.diagnosticSink = diagnosticSink
        self.onFatalError = onFatalError
    }

    /// The size the active encoder was created for, or `nil` when no encoder is
    /// running. Callers compare it against their resolved target to decide whether
    /// a resize-recreate is needed.
    var encoderSize: H264EncodeMath.EncoderSize? {
        guard let encoder = encoder else { return nil }
        return H264EncodeMath.EncoderSize(width: encoder.width, height: encoder.height)
    }

    /// Ensure an encoder sized exactly `width`x`height` exists, (re)creating it on
    /// a size change (a seamless reconfig: the new session's first frame is a fresh
    /// SPS/PPS + IDR). Returns `false` — after surfacing the fatal error — when the
    /// VideoToolbox session cannot be created or prepared.
    func ensureEncoder(width: Int, height: Int) -> Bool {
        if let encoder = encoder, encoder.width == width, encoder.height == height {
            return true
        }
        return startEncoder(width: width, height: height)
    }

    /// Encode one delivered pixel buffer through the active encoder. Fire and
    /// forget: encoded output arrives on the VideoToolbox callback and is written
    /// via `FrameWriter.writeEncoded`. Returns `false` when there is no encoder or
    /// the frame was dropped before encode (encoder behind), so the caller can
    /// skip its bookkeeping.
    @discardableResult
    func encode(pixelBuffer: CVPixelBuffer, presentationTime: CMTime) -> Bool {
        encoder?.encode(pixelBuffer: pixelBuffer, presentationTime: presentationTime) == true
    }

    /// Tear the encoder down (orderly shutdown / reconfiguration teardown).
    func stop() {
        encoder?.stop()
        encoder = nil
    }

    private func startEncoder(width: Int, height: Int) -> Bool {
        encoder?.stop()
        let resolvedBitrate = H264EncodeMath.resolveAverageBitRateBps(
            source: source,
            bitrate: bitrate,
            width: width,
            height: height,
            fps: fps
        )
        let newEncoder = H264VideoEncoder(
            width: width,
            height: height,
            fps: fps,
            averageBitRateBps: resolvedBitrate,
            writer: writer,
            forceKeyFrameLatch: forceKeyFrameLatch,
            diagnosticSink: diagnosticSink,
            onFatalError: { [weak self] message in
                self?.onFatalError(EncoderOutputOverflowError(message: message))
            }
        )
        do {
            try newEncoder.start()
        } catch {
            onFatalError(error)
            return false
        }
        encoder = newEncoder
        return true
    }
}
