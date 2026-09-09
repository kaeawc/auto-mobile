import Foundation

/// Converts VideoToolbox's length-prefixed (avcC) H.264 samples to Annex-B and
/// assembles self-decodable access units (issue #4788). Pure and device-free:
/// the byte manipulation is testable without a live `VTCompressionSession`, and
/// its output payloads are pinned against #4787's shared golden vectors.
///
/// VideoToolbox emits each `CMSampleBuffer` as one or more NAL units, each
/// prefixed by a big-endian length field of `nalUnitHeaderLength` bytes (from
/// the format description; 4 in practice). The RTP path needs Annex-B start
/// codes (`00 00 00 01`) and needs every IDR self-decodable, so SPS/PPS are
/// prepended to every keyframe — matching ffmpeg's `-f h264` behavior.
public enum AnnexBConverter {
    /// The 4-byte Annex-B start code prefixed before each NAL unit.
    public static let startCode = Data([0x00, 0x00, 0x00, 0x01])

    /// The five low bits of a NAL header byte carry `nal_unit_type` (H.264
    /// §7.3.1). IDR slices are type 5.
    public static let nalTypeMask: UInt8 = 0x1F
    public static let nalTypeIDR: UInt8 = 5

    public enum ConversionError: Error, Equatable {
        /// `nalUnitHeaderLength` outside the legal 1...4 range.
        case invalidNalHeaderLength(Int)
        /// A length prefix ran past the end of the sample (truncated / corrupt).
        case truncatedSample
    }

    /// Convert a length-prefixed (avcC) sample to Annex-B, replacing each
    /// `nalUnitHeaderLength`-byte big-endian length prefix with a start code.
    /// Handles multi-NAL samples. Does NOT prepend parameter sets — see
    /// `assembleAccessUnit`.
    public static func annexB(fromAvcc sample: Data, nalUnitHeaderLength: Int) throws -> Data {
        guard nalUnitHeaderLength >= 1, nalUnitHeaderLength <= 4 else {
            throw ConversionError.invalidNalHeaderLength(nalUnitHeaderLength)
        }
        var output = Data()
        // For the common 4-byte header the Annex-B output is exactly the input size
        // (a 4-byte length prefix becomes a 4-byte start code), so one reservation
        // avoids reallocating as each NAL is appended.
        output.reserveCapacity(sample.count)
        try appendAnnexB(fromAvcc: sample, nalUnitHeaderLength: nalUnitHeaderLength, into: &output)
        return output
    }

    /// Concatenate parameter-set NALs (SPS then PPS) as Annex-B, each prefixed
    /// with a start code. The NALs are passed already stripped of any length
    /// prefix (as VideoToolbox surfaces them via
    /// `CMVideoFormatDescriptionGetH264ParameterSetAtIndex`).
    public static func parameterSetsAnnexB(_ parameterSets: [Data]) -> Data {
        var output = Data()
        output.reserveCapacity(parameterSetsAnnexBLength(parameterSets))
        for nal in parameterSets where !nal.isEmpty {
            output.append(startCode)
            output.append(nal)
        }
        return output
    }

    /// Assemble one Annex-B access unit from an avcC sample. When `isKeyframe`
    /// is true the parameter sets are prepended so the IDR is self-decodable
    /// (the RTP path drops SPS/PPS otherwise). `parameterSets` are the raw
    /// SPS/PPS NALs (no length prefix); pass an empty array for delta frames or
    /// when they are unavailable.
    ///
    /// The access unit is built into ONE pre-sized `Data`: the parameter-set NALs
    /// (keyframes only) then the sample's slices are appended in place. This replaces
    /// the previous three-allocation path — `parameterSetsAnnexB(...)`, `annexB(...)`,
    /// and their `+` concatenation — with a single per-frame allocation.
    public static func assembleAccessUnit(
        fromAvcc sample: Data,
        nalUnitHeaderLength: Int,
        parameterSets: [Data],
        isKeyframe: Bool
    ) throws -> Data {
        guard nalUnitHeaderLength >= 1, nalUnitHeaderLength <= 4 else {
            throw ConversionError.invalidNalHeaderLength(nalUnitHeaderLength)
        }
        let prependedSets = isKeyframe ? parameterSets : []
        var output = Data()
        output.reserveCapacity(parameterSetsAnnexBLength(prependedSets) + sample.count)
        for nal in prependedSets where !nal.isEmpty {
            output.append(startCode)
            output.append(nal)
        }
        try appendAnnexB(fromAvcc: sample, nalUnitHeaderLength: nalUnitHeaderLength, into: &output)
        return output
    }

    /// Appends each NAL of a length-prefixed (avcC) sample to `output` as a
    /// start-code-prefixed Annex-B NAL. The single NAL-walking implementation shared
    /// by `annexB` and `assembleAccessUnit`, so both build into one caller-owned
    /// buffer. The caller validates `nalUnitHeaderLength`.
    private static func appendAnnexB(
        fromAvcc sample: Data,
        nalUnitHeaderLength: Int,
        into output: inout Data
    ) throws {
        // Index into the sample using its own start index so this is correct even
        // for a `Data` slice whose indices do not begin at 0.
        var cursor = sample.startIndex
        let end = sample.endIndex
        while cursor < end {
            guard end - cursor >= nalUnitHeaderLength else {
                throw ConversionError.truncatedSample
            }
            var nalLength = 0
            for offset in 0..<nalUnitHeaderLength {
                nalLength = (nalLength << 8) | Int(sample[cursor + offset])
            }
            let nalStart = cursor + nalUnitHeaderLength
            guard nalLength > 0, end - nalStart >= nalLength else {
                throw ConversionError.truncatedSample
            }
            output.append(startCode)
            output.append(sample[nalStart..<(nalStart + nalLength)])
            cursor = nalStart + nalLength
        }
    }

    /// The Annex-B byte length of `parameterSets` (start code + NAL per non-empty
    /// set), used to size the assembly buffer exactly.
    private static func parameterSetsAnnexBLength(_ parameterSets: [Data]) -> Int {
        var total = 0
        for nal in parameterSets where !nal.isEmpty {
            total += startCode.count + nal.count
        }
        return total
    }
}
