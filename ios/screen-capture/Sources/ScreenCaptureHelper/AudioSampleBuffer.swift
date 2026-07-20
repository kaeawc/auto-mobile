import AudioToolbox
import CoreMedia
import Foundation

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
    var output = Data(count: sampleCount * 2)
    output.withUnsafeMutableBytes { bytes in
        guard let destination = bytes.baseAddress else { return }
        for index in 0..<sampleCount {
            let sample: Int16
            if asbd.mBitsPerChannel == 16 {
                sample = input.advanced(by: index * 2).loadUnaligned(as: Int16.self)
            } else if asbd.mBitsPerChannel == 32,
                      (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0 {
                let float = input.advanced(by: index * 4).loadUnaligned(as: Float.self)
                sample = Int16(max(-1, min(1, float)) * Float(Int16.max))
            } else {
                return
            }
            destination.advanced(by: index * 2).storeBytes(of: sample.littleEndian, as: Int16.self)
        }
    }
    return output
}
