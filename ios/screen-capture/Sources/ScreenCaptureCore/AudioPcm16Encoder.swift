import Foundation

/// Converts the Float32 little-endian PCM emitted by ScreenCaptureKit into
/// signed little-endian PCM16 for the shared WebRTC PCMU packetizer.
public enum AudioPcm16Encoder {
    public static func encodeFloat32LE(_ input: Data) -> Data? {
        guard input.count.isMultiple(of: MemoryLayout<Float>.size) else { return nil }

        var output = Data(count: input.count / 2)
        input.withUnsafeBytes { source in
            output.withUnsafeMutableBytes { destination in
                guard let sourceBase = source.baseAddress, let destinationBase = destination.baseAddress else { return }
                for index in 0..<(input.count / MemoryLayout<Float>.size) {
                    let float = sourceBase.advanced(by: index * 4).loadUnaligned(as: Float.self)
                    let sample = Int16(max(-1, min(1, float)) * Float(Int16.max))
                    destinationBase.advanced(by: index * 2).storeBytes(of: sample.littleEndian, as: Int16.self)
                }
            }
        }
        return output
    }
}
