import AudioToolbox
import CoreMedia
import Foundation
import ScreenCaptureCore

/// ScreenCaptureKit is configured for 8 kHz mono output. Convert its common
/// Float32 or signed-16-bit linear PCM representation to signed PCM16LE.
func pcm16leAudio(sampleBuffer: CMSampleBuffer) -> Data? {
    guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
          asbd.mSampleRate == 8_000,
          asbd.mChannelsPerFrame == 1,
          asbd.mFormatID == kAudioFormatLinearPCM
    else { return nil }

    var audioBufferList = AudioBufferList()
    var blockBuffer: CMBlockBuffer?
    let result = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer,
        bufferListSizeNeededOut: nil,
        bufferListOut: &audioBufferList,
        bufferListSize: MemoryLayout<AudioBufferList>.size,
        blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil,
        flags: 0,
        blockBufferOut: &blockBuffer
    )
    guard result == noErr, let input = audioBufferList.mBuffers.mData else { return nil }

    let sampleCount = CMSampleBufferGetNumSamples(sampleBuffer)
    let availableBytes = Int(audioBufferList.mBuffers.mDataByteSize)
    if asbd.mBitsPerChannel == 16 {
        guard let count = AudioPcm16Encoder.safeCopyByteCount(
            sampleCount: sampleCount,
            bytesPerSample: MemoryLayout<Int16>.size,
            availableBytes: availableBytes
        ) else { return nil }
        return Data(bytes: input, count: count)
    }
    if asbd.mBitsPerChannel == 32,
       (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0 {
        guard let count = AudioPcm16Encoder.safeCopyByteCount(
            sampleCount: sampleCount,
            bytesPerSample: MemoryLayout<Float>.size,
            availableBytes: availableBytes
        ) else { return nil }
        // Wrap the retained block buffer's float samples without copying (deallocator
        // .none): `encodeFloat32LE` reads them synchronously and returns an owned PCM16
        // buffer, so `blockBuffer` outlives this view. Avoids a throwaway copy of the
        // raw floats purely to adapt to the `Data` parameter.
        return AudioPcm16Encoder.encodeFloat32LE(
            Data(bytesNoCopy: input, count: count, deallocator: .none)
        )
    }
    return nil
}
