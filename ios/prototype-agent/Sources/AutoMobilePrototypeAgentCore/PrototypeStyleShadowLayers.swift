import Foundation

/// Resolved in authored order: the first layer is painted bottom-most within its shadow group.
struct PrototypeStyleShadowLayer: Equatable {
    let color: PrototypeRGBA?
    let sigma: Double
    let spread: Double
    let x: Double
    let y: Double
    let inner: Bool

    static func resolve(_ shadows: [Shadow]?, palette: PrototypePalette) -> [Self] {
        (shadows ?? []).map {
            Self(
                color: palette.resolve($0.color),
                sigma: $0.radius / 2,
                spread: $0.spread ?? 0,
                x: $0.offset?.x ?? 0,
                y: $0.offset?.y ?? 0,
                inner: $0.inner ?? false
            )
        }
    }

    /// Outer sources expand; inner holes shrink. An empty hole casts over the whole node.
    var sourceInset: Double { inner ? spread : -spread }
    var inverseExtent: Double { 4 * sigma + abs(x) + abs(y) + abs(spread) + 1 }
}

/// Radius resolution shared by every paint, clip, and shadow source.
enum PrototypeStyleCorners {
    static func sourceBounds(width: Double, height: Double, spread: Double) -> CGRect? {
        guard width + 2 * spread > 0, height + 2 * spread > 0 else { return nil }
        return CGRect(x: -spread, y: -spread, width: width + 2 * spread, height: height + 2 * spread)
    }

    static func radii(
        _ radius: CornerRadius?,
        width: Double,
        height: Double,
        spread: Double = 0
    )
        -> [Double]
    {
        let limit = max(0, min(width + 2 * spread, height + 2 * spread) / 2)
        let values: [Double]
        switch radius {
        case let .uniform(value): values = Array(repeating: value, count: 4)
        case let .corners(topStart, topEnd, bottomEnd, bottomStart):
            values = [topStart, topEnd, bottomEnd, bottomStart]
        default: values = [0, 0, 0, 0]
        }
        return values.map { min(limit, max(0, $0 + spread)) }
    }
}
