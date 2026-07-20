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
    if asbd.mBitsPerChannel == 16 {
        return Data(bytes: input, count: sampleCount * MemoryLayout<Int16>.size)
    }
    if asbd.mBitsPerChannel == 32,
       (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0 {
        return AudioPcm16Encoder.encodeFloat32LE(
            Data(bytes: input, count: sampleCount * MemoryLayout<Float>.size)
        )
    }
    return nil
}
