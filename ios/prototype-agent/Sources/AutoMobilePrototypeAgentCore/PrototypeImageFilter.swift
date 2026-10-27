import Foundation

struct PrototypeImageFilter: Equatable {
    let saturation: Double
    let tint: PrototypeRGBA?

    init(_ spec: ImageFilter?, palette: PrototypePalette) {
        saturation = spec?.saturation ?? 1
        tint = palette.resolve(spec?.tint)
    }
}
