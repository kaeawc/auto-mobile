import Foundation

/// Pure, device-free arithmetic shared by the in-helper H.264 encoder (issue
/// #4788). Every decision the encoder makes that can be pinned without a live
/// `VTCompressionSession` lives here so it is unit-testable and stays in
/// lockstep with the TypeScript sender.
///
/// The Level 4.2 macroblock budget (`maxMacroblocksPerFrame`) and the
/// resolution/bitrate arithmetic MUST match `src/features/webrtc/IosH264Source.ts`
/// (`resolveIosEncoderScale`, `defaultIosBitrateBps`) and
/// `src/features/webrtc/h264Level.ts` byte for byte — the TS side advertises
/// Level 4.2 in the WHIP SDP, and the helper must encode within exactly that
/// capability. The shared golden vectors in
/// `test/fixtures/h264-level42-scale-golden-vectors.json` pin the constant and
/// every case across both languages (mirrors #4787's record golden vectors).
public enum H264EncodeMath {
    /// H.264 macroblock edge, in pixels (`H264_MACROBLOCK_SIZE`).
    public static let macroblockSize = 16
    /// Level 4.2 per-picture macroblock ceiling (`WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME`).
    /// RFC 6184 §8.2.2 / ITU-T H.264 Annex A.
    public static let maxMacroblocksPerFrame = 8_192
    /// Smallest 4:2:0 chroma-subsampled edge (`MIN_ENCODER_DIMENSION`).
    public static let minEncoderDimension = 2
    /// Bits budgeted per encoded pixel per frame (`IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL`).
    public static let defaultBitsPerPixel = 0.1

    /// An encode resolution in pixels.
    public struct EncoderSize: Equatable {
        public let width: Int
        public let height: Int
        public init(width: Int, height: Int) {
            self.width = width
            self.height = height
        }
    }

    /// Number of 16x16 macroblocks a frame occupies (`h264MacroblocksPerFrame`).
    public static func macroblocksPerFrame(width: Int, height: Int) -> Int {
        divCeil(width, macroblockSize) * divCeil(height, macroblockSize)
    }

    /// Resolve the encode size for a captured frame, or `nil` when the frame can
    /// be encoded at its native size. Port of `resolveIosEncoderScale`: native
    /// dimensions are kept when even and already inside the Level 4.2 budget, odd
    /// dimensions round down to even (4:2:0 cannot encode an odd edge), and an
    /// oversized capture shrinks just far enough to fit the budget with its
    /// aspect ratio intact.
    public static func resolveEncoderScale(_ size: EncoderSize) -> EncoderSize? {
        let width = size.width
        let height = size.height
        if macroblocksPerFrame(width: width, height: height) <= maxMacroblocksPerFrame {
            let even = EncoderSize(width: evenFloor(Double(width)), height: evenFloor(Double(height)))
            return even.width == width && even.height == height ? nil : even
        }

        // Shrink the macroblock grid, not the pixels: flooring both axes of an
        // area-preserving scale keeps columns*rows inside the budget by
        // construction, so no iterative search is needed.
        let columns = divCeil(width, macroblockSize)
        let rows = divCeil(height, macroblockSize)
        let factor = (Double(maxMacroblocksPerFrame) / Double(columns * rows)).squareRoot()
        let targetRows = clampMacroblockAxis(Int((Double(rows) * factor).rounded(.down)))
        let targetColumns = clampMacroblockAxis(
            // An extreme aspect ratio can floor one axis to the 1-macroblock
            // clamp, which would let the product escape the budget; re-cap.
            min(
                Int((Double(columns) * factor).rounded(.down)),
                Int((Double(maxMacroblocksPerFrame) / Double(targetRows)).rounded(.down))
            )
        )
        let scale = min(
            Double(targetColumns * macroblockSize) / Double(width),
            Double(targetRows * macroblockSize) / Double(height)
        )
        return EncoderSize(
            width: evenFloor(Double(width) * scale),
            height: evenFloor(Double(height) * scale)
        )
    }

    /// Resolution-aware default bitrate (bps) derived from the *encoded* pixel
    /// dimensions and declared fps. Port of `defaultIosBitrateBps`: always a
    /// positive finite integer (a non-finite input falls back to the 1 bps
    /// floor). See `defaultBitsPerPixel`.
    public static func defaultBitrateBps(size: EncoderSize, fps: Int) -> Int {
        let budget = Double(size.width) * Double(size.height) * Double(fps) * defaultBitsPerPixel
        guard budget.isFinite else { return 1 }
        // Match JS `Math.round` (half rounds toward +infinity), not Swift's
        // round-half-to-even.
        let rounded = (budget + 0.5).rounded(.down)
        return max(1, Int(rounded))
    }

    /// Bitrate (bps) from a bits-per-pixel budget over the delivered dimensions
    /// and fps. Same arithmetic as `defaultBitrateBps` with an operator-supplied
    /// budget instead of the default.
    public static func bitrateBps(width: Int, height: Int, fps: Int, bitsPerPixel: Double) -> Int {
        let budget = Double(width) * Double(height) * Double(fps) * bitsPerPixel
        guard budget.isFinite else { return 1 }
        let rounded = (budget + 0.5).rounded(.down)
        return max(1, Int(rounded))
    }

    // MARK: - Private helpers

    private static func divCeil(_ numerator: Int, _ denominator: Int) -> Int {
        Int((Double(numerator) / Double(denominator)).rounded(.up))
    }

    /// `evenFloor`: floor to the nearest even integer, but never below the 4:2:0
    /// minimum edge.
    private static func evenFloor(_ value: Double) -> Int {
        max(minEncoderDimension, Int((value / 2).rounded(.down)) * 2)
    }

    private static func clampMacroblockAxis(_ value: Int) -> Int {
        min(maxMacroblocksPerFrame, max(1, value))
    }
}
