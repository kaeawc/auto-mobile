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
