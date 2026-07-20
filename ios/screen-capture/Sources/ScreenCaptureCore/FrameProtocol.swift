import Foundation

/// Binary frame protocol matching docs/design-docs/plat/ios/screen-streaming.md.
///
/// Wire format (header = 16 bytes, little-endian UInt32):
///
///     ┌──────────┬───────────┬─────────────────┬──────────────┐
///     │ width(4) │ height(4) │ bytesPerRow (4) │ timestampMs  │
///     └──────────┴───────────┴─────────────────┴──────────────┘
///
/// Followed by `height * bytesPerRow` bytes of BGRA pixel data.
public enum FrameProtocol {
    public static let headerSize = 16
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
            // the buffer is non-empty and baseAddress is non-nil.
            let base = ptr.baseAddress!  // swiftlint:disable:this force_unwrapping
            base.storeBytes(of: header.width.littleEndian, as: UInt32.self)
            base.advanced(by: 4).storeBytes(of: header.height.littleEndian, as: UInt32.self)
            base.advanced(by: 8).storeBytes(of: header.bytesPerRow.littleEndian, as: UInt32.self)
            base.advanced(by: 12).storeBytes(of: header.timestampMs.littleEndian, as: UInt32.self)
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

    public static func decodeHeader(_ data: Data) -> Header? {
        guard data.count >= headerSize else { return nil }
        return data.withUnsafeBytes { ptr -> Header in
            // Guarded above by `data.count >= headerSize` (headerSize > 0), so the
            // buffer is non-empty and baseAddress is non-nil.
            let base = ptr.baseAddress!  // swiftlint:disable:this force_unwrapping
            // `load(as:)` requires the address to be aligned to the loaded type;
            // when `data` is a slice of a larger buffer, `base` may be unaligned,
            // making the loads undefined behavior (traps in debug). `loadUnaligned`
            // has no alignment requirement (issue #3627).
            let w = UInt32(littleEndian: base.loadUnaligned(as: UInt32.self))
            let h = UInt32(littleEndian: base.advanced(by: 4).loadUnaligned(as: UInt32.self))
            let r = UInt32(littleEndian: base.advanced(by: 8).loadUnaligned(as: UInt32.self))
            let t = UInt32(littleEndian: base.advanced(by: 12).loadUnaligned(as: UInt32.self))
            return Header(width: w, height: h, bytesPerRow: r, timestampMs: t)
        }
    }
}
