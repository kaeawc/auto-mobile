import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureCore
import VideoToolbox

/// Fatal encoder-startup failures surfaced to `main.swift`'s `error:` boundary,
/// where the supervisor's bounded reconnect relaunches the helper (issue #4788).
enum H264EncoderError: Error, CustomStringConvertible {
    case sessionCreationFailed(status: OSStatus)
    case sessionPrepareFailed(status: OSStatus)

    var description: String {
        switch self {
        case .sessionCreationFailed(let status):
            return "VTCompressionSessionCreate failed (status \(status))"
        case .sessionPrepareFailed(let status):
            return "VTCompressionSessionPrepareToEncodeFrames failed (status \(status))"
        }
    }
}

/// In-process H.264 encoder over `VTCompressionSession` (issue #4788).
///
/// DEVICE-ONLY: VideoToolbox cannot be exercised headlessly, so this glue is not
/// unit-tested. Every decision it makes that CAN be pinned without a live
/// session is factored into pure `ScreenCaptureCore` functions and tested there:
///   - resolution/macroblock budget  -> `H264EncodeMath.resolveEncoderScale`
///   - bits-per-pixel -> bitrate      -> `H264EncodeMath.bitrateBps`
///   - avcC -> Annex-B + SPS/PPS/IDR  -> `AnnexBConverter`
///   - force-keyframe latch decision  -> `ForceKeyFrameLatch`
///   - drop-when-behind / overflow    -> `EncoderDropPolicy`
///
/// Encoder config: `kVTProfileLevel_H264_Baseline_4_2`, `AllowFrameReordering =
/// false` (no B-frames), `RealTime = true`, `MaxKeyFrameInterval ~= 2s x fps`,
/// and `EnableHardwareAcceleratedVideoEncoder` WITHOUT the `Require...` key so a
/// hosted runner with no free HW encoder falls back to software (the `-allow_sw
/// 1` semantic) rather than failing to start.
final class H264VideoEncoder {
    /// Target seconds between IDRs; matches the TS ffmpeg GOP
    /// (`IOS_KEYFRAME_INTERVAL_SECONDS`).
    static let keyFrameIntervalSeconds = 2
    /// Frames allowed in-flight (submitted, not yet emitted) before late frames
    /// are dropped at the encoder input. One GOP-ish of slack absorbs transient
    /// encoder stalls without unbounding latency.
    static let maxInFlightFrames = 3

    private let writer: FrameWriter
    private let forceKeyFrameLatch: ForceKeyFrameLatch
    private let onFatalError: (String) -> Void
    private let diagnosticSink: (String) -> Void
    private let onDroppedFrame: () -> Void
    private let lock = NSLock()

    private var session: VTCompressionSession?
    private var inFlightFrames = 0
    private var formatParameterSets: [Data] = []
    private var nalUnitHeaderLength = 4

    let width: Int
    let height: Int
    let fps: Int
    let averageBitRateBps: Int?

    /// - Parameters:
    ///   - width/height: encode resolution (already run through the macroblock
    ///     budget); the delivered `CVPixelBuffer` is fed directly, so this must
    ///     match the SCK-delivered size.
    ///   - averageBitRateBps: resolved `AverageBitRate`, or `nil` to leave the
    ///     VideoToolbox default (physical-device path, #4375).
    init(
        width: Int,
        height: Int,
        fps: Int,
        averageBitRateBps: Int?,
        writer: FrameWriter,
        forceKeyFrameLatch: ForceKeyFrameLatch,
        diagnosticSink: @escaping (String) -> Void,
        onFatalError: @escaping (String) -> Void,
        onDroppedFrame: @escaping () -> Void = {}
    ) {
        self.width = width
        self.height = height
        self.fps = fps
        self.averageBitRateBps = averageBitRateBps
        self.writer = writer
        self.forceKeyFrameLatch = forceKeyFrameLatch
        self.diagnosticSink = diagnosticSink
        self.onFatalError = onFatalError
        self.onDroppedFrame = onDroppedFrame
    }

    /// Create the compression session and apply the encoder config. Throws an
    /// `ActionableError` when VideoToolbox refuses to create/prepare the session.
    func start() throws {
        // Prefer the hardware encoder but do NOT require it — a hosted runner
        // whose HW encoder is absent/exhausted must fall back to software
        // instead of failing to start (the `-allow_sw 1` semantic). The
        // `EnableHardware...` key without the matching `RequireHardware...` key
        // expresses exactly that preference.
        let encoderSpecification: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanTrue as Any
        ]
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: encoderSpecification as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &created
        )
        guard status == noErr, let session = created else {
            throw H264EncoderError.sessionCreationFailed(status: status)
        }
        applyConfiguration(to: session)
        let prepareStatus = VTCompressionSessionPrepareToEncodeFrames(session)
        guard prepareStatus == noErr else {
            VTCompressionSessionInvalidate(session)
            throw H264EncoderError.sessionPrepareFailed(status: prepareStatus)
        }
        self.session = session
    }

    private func applyConfiguration(to session: VTCompressionSession) {
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_ProfileLevel,
            value: kVTProfileLevel_H264_Baseline_4_2
        )
        // No B-frames: the RTP path needs each frame to reference only past
        // frames, and low latency matters more than a few percent of bitrate.
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_AllowFrameReordering,
            value: kCFBooleanFalse
        )
        let maxKeyFrameInterval = max(1, H264VideoEncoder.keyFrameIntervalSeconds * fps)
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
            value: maxKeyFrameInterval as CFNumber
        )
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
            value: H264VideoEncoder.keyFrameIntervalSeconds as CFNumber
        )
        if let bitrate = averageBitRateBps {
            VTSessionSetProperty(
                session,
                key: kVTCompressionPropertyKey_AverageBitRate,
                value: bitrate as CFNumber
            )
            // DataRateLimits peak ceiling: a 1s window at ~1.5x the average
            // caps transient spikes without starving scroll/animation bursts.
            // Cheap to wire, so wired here rather than deferred.
            let peakBytesPerSecond = (bitrate / 8) * 3 / 2
            let limits = [peakBytesPerSecond as CFNumber, 1 as CFNumber] as CFArray
            VTSessionSetProperty(
                session,
                key: kVTCompressionPropertyKey_DataRateLimits,
                value: limits
            )
        }
    }

    /// Encode one delivered pixel buffer. Applies the drop-when-behind decision
    /// at the input and consumes a pending force-keyframe request. Fire and
    /// forget: encoded output arrives on the VideoToolbox callback and is written
    /// via `FrameWriter.writeEncoded`. Returns `false` when the frame was dropped
    /// before encode (encoder behind) so the caller can skip its bookkeeping.
    @discardableResult
    func encode(pixelBuffer: CVPixelBuffer, presentationTime: CMTime) -> Bool {
        guard let session = session else { return false }

        lock.lock()
        let behind = EncoderDropPolicy.shouldDropBeforeEncode(
            inFlightFrames: inFlightFrames,
            maxInFlightFrames: H264VideoEncoder.maxInFlightFrames
        )
        if behind {
            onDroppedFrame()
            lock.unlock()
            return false
        }
        inFlightFrames += 1
        lock.unlock()

        var frameProperties: [CFString: Any]?
        if forceKeyFrameLatch.consume() {
            frameProperties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue as Any]
        }

        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: presentationTime,
            duration: .invalid,
            frameProperties: frameProperties as CFDictionary?,
            infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            self?.handleEncodedFrame(status: status, sampleBuffer: sampleBuffer)
        }
        if status != noErr {
            lock.lock()
            inFlightFrames = max(0, inFlightFrames - 1)
            lock.unlock()
            onDroppedFrame()
            diagnosticSink("warn: VTCompressionSessionEncodeFrame failed (status \(status))\n")
            return false
        }
        return true
    }

    /// VideoToolbox output callback: convert the avcC sample to Annex-B (SPS/PPS
    /// prepended on every IDR) and emit it as an encoded-video record.
    private func handleEncodedFrame(status: OSStatus, sampleBuffer: CMSampleBuffer?) {
        lock.lock()
        inFlightFrames = max(0, inFlightFrames - 1)
        lock.unlock()

        // A successful callback with a data buffer is sufficient; `contiguousData`
        // below rejects an empty payload, so no separate sample-count check.
        guard status == noErr, let sampleBuffer = sampleBuffer else { return }
        let isKeyframe = H264VideoEncoder.isKeyframe(sampleBuffer)
        if isKeyframe {
            refreshParameterSets(from: sampleBuffer)
        }
        guard let sample = H264VideoEncoder.contiguousData(from: sampleBuffer) else { return }

        let record: Data
        do {
            record = try AnnexBConverter.assembleAccessUnit(
                fromAvcc: sample,
                nalUnitHeaderLength: currentNalUnitHeaderLength(),
                parameterSets: isKeyframe ? currentParameterSets() : [],
                isKeyframe: isKeyframe
            )
        } catch {
            diagnosticSink("warn: avcC->Annex-B conversion failed: \(error)\n")
            return
        }

        let ptsMs = H264VideoEncoder.presentationTimestampMs(sampleBuffer)
        let header = FrameProtocol.encodeEncodedVideoHeader(
            payloadLength: record.count,
            isKeyframe: isKeyframe,
            presentationTimestampMs: ptsMs
        )
        if !writer.writeEncoded(header: header, payload: record) {
            // Overflow of the bounded output queue is fatal: dropping an emitted
            // record breaks decodability, so exit and let the supervisor relaunch
            // with a fresh IDR instead.
            onFatalError("encoded output queue overflow; refusing to drop an emitted record")
        }
    }

    /// Invalidate the session (orderly shutdown / reconfiguration teardown).
    func stop() {
        guard let session = session else { return }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }

    // MARK: - Parameter sets

    private func refreshParameterSets(from sampleBuffer: CMSampleBuffer) {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        var parameterSetCount = 0
        var headerLength: Int32 = 4
        // Query the parameter-set count and NAL header length once.
        let probe = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0, parameterSetPointerOut: nil,
            parameterSetSizeOut: nil, parameterSetCountOut: &parameterSetCount,
            nalUnitHeaderLengthOut: &headerLength
        )
        guard probe == noErr, parameterSetCount > 0 else { return }

        var sets: [Data] = []
        for index in 0..<parameterSetCount {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format, parameterSetIndex: index, parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
            )
            if status == noErr, let pointer = pointer, size > 0 {
                sets.append(Data(bytes: pointer, count: size))
            }
        }
        lock.lock()
        formatParameterSets = sets
        nalUnitHeaderLength = Int(headerLength)
        lock.unlock()
    }

    private func currentParameterSets() -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return formatParameterSets
    }

    private func currentNalUnitHeaderLength() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return nalUnitHeaderLength
    }

    // MARK: - CMSampleBuffer helpers

    private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer, createIfNecessary: false
        ) as? [[CFString: Any]], let first = attachments.first else {
            // No attachments array means "not-not-sync"; treat as keyframe so the
            // decoder never waits on a missing IDR.
            return true
        }
        // A frame is a keyframe unless it is explicitly marked NotSync.
        if let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
            return !notSync
        }
        return true
    }

    private static func contiguousData(from sampleBuffer: CMSampleBuffer) -> Data? {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            blockBuffer, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &length, dataPointerOut: &pointer
        )
        guard status == noErr, let pointer = pointer, length > 0 else { return nil }
        return Data(bytes: pointer, count: length)
    }

    private static func presentationTimestampMs(_ sampleBuffer: CMSampleBuffer) -> UInt32 {
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard pts.isValid, pts.isNumeric else { return 0 }
        let seconds = CMTimeGetSeconds(pts)
        guard seconds.isFinite, seconds >= 0 else { return 0 }
        return UInt32(truncatingIfNeeded: UInt64(seconds * 1000))
    }
}
