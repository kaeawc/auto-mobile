import Foundation

/// Binary frame protocol matching docs/design-docs/plat/ios/screen-streaming.md.
///
/// Wire format (header = 24 bytes, little-endian UInt32):
///
///     ┌─────────┬─────────────┬──────────┬───────────┬─────────────┬─────────────┐
///     │ magic(4)│ checksum(4) │ width(4) │ height(4) │ bytesPerRow │ timestampMs │
///     └─────────┴─────────────┴──────────┴───────────┴─────────────┴─────────────┘
///
/// Followed by `height * bytesPerRow` bytes of BGRA pixel data. `magic` is a
/// fixed sync marker ("AMF1" on the wire) and `checksum` is a CRC-32 (IEEE) over
/// the 16 field bytes that follow it, so the decoder can recover frame
/// boundaries deterministically after corruption (issue #4270). The TypeScript
/// decoder (`src/features/screen-stream/frameProtocol.ts`) must agree byte for
/// byte; the shared CRC-32 check vector pins that on both sides.
public enum FrameProtocol {
    public static let headerSize = 24
    /// Sync marker; on the wire the bytes read "AMF1".
    public static let magic: UInt32 = 0x3146_4D41
    /// Offset where the checksummed field bytes begin.
    static let fieldsOffset = 8
    public static let audioSampleRate: UInt32 = 8_000
    public static let audioChannelCount: UInt32 = 1

    /// Encoded-video discriminator (issue #4787). The header carries no type
    /// field; raw frames and audio are told apart by reserved sentinels in the
    /// geometry fields (audio = width=0, height=8000, bytesPerRow=1). An
    /// encoded-video record reuses width=0 (a raw frame always has width>=1) and
    /// puts this reserved constant in `height`, whose top 31 bits are fixed and
    /// whose low bit carries the keyframe flag:
    ///
    ///     width       = 0                                  (never a raw frame)
    ///     height      = encodedVideoHeightBase | keyframeBit
    ///     bytesPerRow = encoded H.264 payload length in bytes
    ///     timestampMs = presentation timestamp (ms) from the CMSampleBuffer PTS
    ///
    /// `encodedVideoHeightBase` (0xE264_0000) can never equal the audio
    /// sentinel's height of 8000, so an encoded record is unambiguous against
    /// both raw frames (width != 0) and audio (height != 8000). The CRC-32 header
    /// checksum still covers all 16 field bytes, so a corrupt encoded header
    /// fails validation and drives resync exactly like a raw or audio header.
    public static let encodedVideoHeightBase: UInt32 = 0xE264_0000
    /// All bits of `height` except the low keyframe-flag bit.
    public static let encodedVideoHeightMask: UInt32 = 0xFFFF_FFFE
    static let encodedVideoKeyframeBit: UInt32 = 0x0000_0001

    /// A decoded in-helper-encoded H.264 access-unit record (issue #4787),
    /// surfaced distinctly from raw frames and audio.
    public struct EncodedVideoRecord: Equatable {
        public let payloadLength: Int
        public let isKeyframe: Bool
        public let presentationTimestampMs: UInt32

        public init(payloadLength: Int, isKeyframe: Bool, presentationTimestampMs: UInt32) {
            self.payloadLength = payloadLength
            self.isKeyframe = isKeyframe
            self.presentationTimestampMs = presentationTimestampMs
        }
    }

    public struct Header: Equatable {
        public let width: UInt32
        public let height: UInt32
        public let bytesPerRow: UInt32
        public let timestampMs: UInt32

        public init(width: UInt32, height: UInt32, bytesPerRow: UInt32, timestampMs: UInt32) {
            self.width = width
            self.height = height
            self.bytesPerRow = bytesPerRow
            self.timestampMs = timestampMs
        }
    }

    public static func encodeHeader(_ header: Header) -> Data {
        var data = Data(count: headerSize)
        data.withUnsafeMutableBytes { ptr in
            // `data` was allocated with `Data(count: headerSize)` (headerSize > 0), so
            // the buffer is non-empty and baseAddress is non-nil. All offsets are
            // multiples of 4, so the aligned stores are valid.
            let base = ptr.baseAddress!  // swiftlint:disable:this force_unwrapping
            base.storeBytes(of: magic.littleEndian, as: UInt32.self)
            base.advanced(by: 8).storeBytes(of: header.width.littleEndian, as: UInt32.self)
            base.advanced(by: 12).storeBytes(of: header.height.littleEndian, as: UInt32.self)
            base.advanced(by: 16).storeBytes(of: header.bytesPerRow.littleEndian, as: UInt32.self)
            base.advanced(by: 20).storeBytes(of: header.timestampMs.littleEndian, as: UInt32.self)
        }
        let checksum = crc32(data.subdata(in: fieldsOffset..<headerSize))
        data.withUnsafeMutableBytes { ptr in
            let base = ptr.baseAddress!  // swiftlint:disable:this force_unwrapping
            base.advanced(by: 4).storeBytes(of: checksum.littleEndian, as: UInt32.self)
        }
        return data
    }

    public static func encodeAudioHeader(payloadLength: Int) -> Data {
        encodeHeader(Header(
            width: 0,
            height: audioSampleRate,
            bytesPerRow: audioChannelCount,
            timestampMs: UInt32(payloadLength)
        ))
    }

    /// Encode an encoded-video record header (issue #4787). Mirrors
    /// `encodeEncodedVideoHeader` in the TypeScript decoder; the shared golden
    /// vectors pin the two byte for byte. See `encodedVideoHeightBase`.
    public static func encodeEncodedVideoHeader(
        payloadLength: Int,
        isKeyframe: Bool,
        presentationTimestampMs: UInt32
    ) -> Data {
        let keyframeBit = isKeyframe ? encodedVideoKeyframeBit : 0
        return encodeHeader(Header(
            width: 0,
            height: encodedVideoHeightBase | keyframeBit,
            bytesPerRow: UInt32(payloadLength),
            timestampMs: presentationTimestampMs
        ))
    }

    /// True when a decoded header is an encoded-video record: width=0 (never a
    /// raw frame) and `height` masked to the reserved sentinel base. Cannot
    /// collide with the audio sentinel because the base (0xE264_0000) is not 8000.
    public static func isEncodedVideoHeader(_ header: Header) -> Bool {
        header.width == 0 && (header.height & encodedVideoHeightMask) == encodedVideoHeightBase
    }

    /// Decode + validate a header and, when it is an encoded-video record, map it
    /// to an `EncodedVideoRecord`. Returns nil for a corrupt header (marker or
    /// checksum mismatch) or a header that is not an encoded-video record.
    public static func decodeEncodedVideoHeader(_ data: Data) -> EncodedVideoRecord? {
        guard let header = decodeHeader(data), isEncodedVideoHeader(header) else { return nil }
        return EncodedVideoRecord(
            payloadLength: Int(header.bytesPerRow),
            isKeyframe: (header.height & encodedVideoKeyframeBit) != 0,
            presentationTimestampMs: header.timestampMs
        )
    }

    /// Decode + validate a header. Returns nil when the marker or checksum does
    /// not match — i.e. these bytes are not a real frame boundary.
    public static func decodeHeader(_ data: Data) -> Header? {
        guard data.count >= headerSize else { return nil }
        return data.withUnsafeBytes { ptr -> Header? in
            // Guarded above by `data.count >= headerSize` (headerSize > 0), so the
            // buffer is non-empty and baseAddress is non-nil. `loadUnaligned` has no
            // alignment requirement, so a header at an odd address is safe (#3627).
            let base = ptr.baseAddress!  // swiftlint:disable:this force_unwrapping
            let marker = UInt32(littleEndian: base.loadUnaligned(as: UInt32.self))
            guard marker == magic else { return nil }
            let stored = UInt32(littleEndian: base.advanced(by: 4).loadUnaligned(as: UInt32.self))
            let fields = Data(bytes: base.advanced(by: fieldsOffset), count: headerSize - fieldsOffset)
            guard stored == crc32(fields) else { return nil }
            return Header(
                width: UInt32(littleEndian: base.advanced(by: 8).loadUnaligned(as: UInt32.self)),
                height: UInt32(littleEndian: base.advanced(by: 12).loadUnaligned(as: UInt32.self)),
                bytesPerRow: UInt32(littleEndian: base.advanced(by: 16).loadUnaligned(as: UInt32.self)),
                timestampMs: UInt32(littleEndian: base.advanced(by: 20).loadUnaligned(as: UInt32.self))
            )
        }
    }

    private static let crc32Table: [UInt32] = {
        (0..<256).map { index -> UInt32 in
            var remainder = UInt32(index)
            for _ in 0..<8 {
                remainder = (remainder & 1) != 0 ? 0xEDB8_8320 ^ (remainder >> 1) : remainder >> 1
            }
            return remainder
        }
    }()

    /// CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) — the standard CRC
    /// used by zip/gzip/PNG. Implemented here because Foundation ships no CRC-32
    /// primitive and the TypeScript decoder must produce an identical checksum.
    public static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in data {
            crc = (crc >> 8) ^ crc32Table[Int((crc ^ UInt32(byte)) & 0xFF)]
        }
        return crc ^ 0xFFFF_FFFF
    }
}
