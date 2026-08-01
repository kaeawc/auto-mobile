import Foundation

/// Converts the Float32 little-endian PCM emitted by ScreenCaptureKit into
/// signed little-endian PCM16 for the shared WebRTC PCMU packetizer.
public enum AudioPcm16Encoder {
    /// Bounds how many PCM bytes may be copied out of a CoreMedia audio buffer.
    ///
    /// The sample count reported by `CMSampleBufferGetNumSamples` and the byte
    /// count reported by `mDataByteSize` can disagree for a short/partially
    /// packed buffer. Copying `sampleCount * bytesPerSample` blindly would then
    /// over-read adjacent heap memory (info leak) or truncate. Returns `nil`
    /// when the buffer is shorter than the sample count requires, signalling the
    /// caller to drop the buffer rather than emit over-read/partial audio.
    public static func safeCopyByteCount(
        sampleCount: Int,
        bytesPerSample: Int,
        availableBytes: Int
    ) -> Int? {
        guard sampleCount >= 0, bytesPerSample > 0, availableBytes >= 0 else { return nil }
        let (requested, overflow) = sampleCount.multipliedReportingOverflow(by: bytesPerSample)
        guard !overflow, availableBytes >= requested else { return nil }
        return requested
    }

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
