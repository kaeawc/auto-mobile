import Foundation

/// Geometry and hit-testing for the visual-only tap target canvas.
enum TapAtTargetLayout {
    enum Kind: Equatable {
        case square(side: Double)
        case horizontalBar(width: Double, height: Double)
        case verticalBar(width: Double, height: Double)
        case circle(diameter: Double)

        var size: CGSize {
            switch self {
            case let .square(side):
                CGSize(width: CGFloat(side), height: CGFloat(side))
            case let .horizontalBar(width, height), let .verticalBar(width, height):
                CGSize(width: CGFloat(width), height: CGFloat(height))
            case let .circle(diameter):
                CGSize(width: CGFloat(diameter), height: CGFloat(diameter))
            }
        }

        var label: String {
            switch self {
            case .square: "square"
            case .horizontalBar, .verticalBar: "bar"
            case .circle: "circle"
            }
        }
    }

    struct Target: Equatable, Identifiable {
        let id: String
        let kind: Kind
        let rect: CGRect

        var center: CGPoint {
            CGPoint(x: rect.midX, y: rect.midY)
        }
    }

    struct Resolution: Equatable {
        let hitTargetID: String?
        let nearestTargetID: String
        let distanceFromNearestCenter: Double
    }

    private struct Definition {
        let id: String
        let kind: Kind
        let xFraction: CGFloat
        let yFraction: CGFloat
    }

    static let targetCount = 11

    /// Positions are proportional to the canvas bounds; each target retains its
    /// exact point dimensions on every device size.
    static func targets(in size: CGSize) -> [Target] {
        let definitions: [Definition] = [
            Definition(id: "T1", kind: .square(side: 120), xFraction: 0.18, yFraction: 0.20),
            Definition(id: "T2", kind: .square(side: 88), xFraction: 0.82, yFraction: 0.20),
            Definition(id: "T3", kind: .square(side: 44), xFraction: 0.14, yFraction: 0.76),
            Definition(id: "T4", kind: .square(side: 32), xFraction: 0.86, yFraction: 0.76),
            Definition(id: "T5", kind: .square(side: 24), xFraction: 0.50, yFraction: 0.10),
            Definition(id: "T6", kind: .square(side: 16), xFraction: 0.92, yFraction: 0.49),
            Definition(id: "T7", kind: .square(side: 10), xFraction: 0.08, yFraction: 0.49),
            Definition(id: "T8", kind: .square(side: 6), xFraction: 0.50, yFraction: 0.50),
            Definition(id: "T9", kind: .horizontalBar(width: 64, height: 8), xFraction: 0.50, yFraction: 0.68),
            Definition(id: "T10", kind: .verticalBar(width: 8, height: 64), xFraction: 0.36, yFraction: 0.38),
            Definition(id: "T11", kind: .circle(diameter: 36), xFraction: 0.64, yFraction: 0.38),
        ]

        return definitions.map { definition in
            let targetSize = definition.kind.size
            let center = CGPoint(x: size.width * definition.xFraction, y: size.height * definition.yFraction)
            return Target(
                id: definition.id,
                kind: definition.kind,
                rect: CGRect(
                    x: center.x - targetSize.width / 2,
                    y: center.y - targetSize.height / 2,
                    width: targetSize.width,
                    height: targetSize.height
                )
            )
        }
    }

    static func distance(from point: CGPoint, to target: Target) -> Double {
        hypot(Double(point.x - target.center.x), Double(point.y - target.center.y))
    }

    static func resolve(_ point: CGPoint, against targets: [Target]) -> Resolution? {
        guard let nearest = targets.min(by: {
            distance(from: point, to: $0) < distance(from: point, to: $1)
        }) else {
            return nil
        }

        return Resolution(
            hitTargetID: targets.first(where: { $0.rect.contains(point) })?.id,
            nearestTargetID: nearest.id,
            distanceFromNearestCenter: distance(from: point, to: nearest)
        )
    }

    static func summary(hitTargetIDs: Set<String>) -> String {
        let misses = (1 ... targetCount).map { "T\($0)" }.filter { !hitTargetIDs.contains($0) }
        return "hits: \(targetCount - misses.count)/\(targetCount), misses: [\(misses.joined(separator: ", "))]"
    }
}
