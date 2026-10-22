import Foundation
import ImageIO

struct PrototypeLibraryImageSize: Equatable {
    let width: Int
    let height: Int
}

protocol ImageHeaderProbe {
    func dimensions(_ bytes: Data) throws -> PrototypeLibraryImageSize
}

struct PrototypeLibraryImageIOProbe: ImageHeaderProbe {
    func dimensions(_ bytes: Data) throws -> PrototypeLibraryImageSize {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(bytes as CFData, options),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, options) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0,
              width.doubleValue <= Double(PrototypeLibraryImporter.maxImagePixels),
              height.doubleValue <= Double(PrototypeLibraryImporter.maxImagePixels)
        else {
            throw PrototypeLibraryFailure(path: "image", message: "Invalid image dimensions")
        }
        return PrototypeLibraryImageSize(width: width.intValue, height: height.intValue)
    }
}
