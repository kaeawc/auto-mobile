import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureCore

extension FrameWriter {
    /// Writes one frame from a `CMSampleBuffer`, locking the underlying pixel
    /// buffer for the duration of the synchronous sink write. Returns `false`
    /// when the sample buffer has no image (e.g. dropped/idle frames).
    @discardableResult
    func write(sampleBuffer: CMSampleBuffer) -> Bool {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return false }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return false }

        write(
            width: CVPixelBufferGetWidth(pixelBuffer),
            height: CVPixelBufferGetHeight(pixelBuffer),
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            baseAddress: base
        )
        return true
    }
}
