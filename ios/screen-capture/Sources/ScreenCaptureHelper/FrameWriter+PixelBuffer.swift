import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureCore

extension FrameWriter {
    /// Copies one frame from a `CMSampleBuffer` into the bounded latest-frame
    /// queue. The pixel buffer stays locked only for that copy, never for a
    /// potentially blocking stdout write. Returns `false` when no image exists
    /// or when the raw frame exceeds the queue's fixed byte cap.
    @discardableResult
    func write(sampleBuffer: CMSampleBuffer) -> Bool {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return false }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return false }

        return write(
            width: CVPixelBufferGetWidth(pixelBuffer),
            height: CVPixelBufferGetHeight(pixelBuffer),
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            baseAddress: base
        )
    }
}
