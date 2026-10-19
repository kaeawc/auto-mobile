import SwiftUI

// MARK: - Crayon sketch (iOS)

// Mirror of the Android design-system `CrayonSketch`: a pure, deterministic,
// seeded jitter of a rounded-rectangle perimeter, drawn as a doubled-up marker
// outline. Deterministic (no `Double.random`) so it is host-testable and never
// flakes; the loop closes exactly and the modifier attenuates the caller's alpha.
// Native SwiftUI (Shape/Canvas) — no Metal here (that is the shader item).

/// Deterministic hash noise in [-1, 1) from a seed and index.
func crayonNoise(_ seed: UInt64, _ i: Int) -> CGFloat {
    var hash = seed ^ (UInt64(i) &* 0x9E37_79B9_7F4A_7C15)
    hash = (hash ^ (hash >> 33)) &* 0xFF51_AFD7_ED55_8CCD
    hash = (hash ^ (hash >> 33)) &* 0xC4CE_B9FE_1A85_EC53
    hash ^= (hash >> 33)
    let unit = Double(hash >> 11) / Double(UInt64(1) << 53) // [0, 1)
    return CGFloat(unit * 2 - 1)
}

/// Base rounded-rectangle perimeter, sampled clockwise from the top edge and
/// closed (the last point repeats the first). Every point is within the box.
private func roundedRectPerimeter(
    _ width: CGFloat, _ height: CGFloat, _ corner: CGFloat, _ segmentsPerEdge: Int
)
    -> [CGPoint]
{
    let radius = min(max(corner, 0), min(width, height) / 2)
    // At least one straight-edge sample: a zero count skips every edge point and a
    // negative one is a `0..<n` range precondition failure.
    let segs = max(1, segmentsPerEdge)
    var pts: [CGPoint] = []
    func edge(_ startX: CGFloat, _ startY: CGFloat, _ x1: CGFloat, _ y1: CGFloat) {
        for step in 0 ..< segs {
            let fraction = CGFloat(step) / CGFloat(segs)
            pts.append(CGPoint(x: startX + (x1 - startX) * fraction, y: startY + (y1 - startY) * fraction))
        }
    }
    // Half-open like `edge`: emit the arc's start but not its end, so the arc's last
    // point never duplicates the following edge's first point. A duplicated seam
    // point gets its own jitter and shows as a knot; the dropped corner point is
    // supplied by the next segment's start (and the final one by the closing append).
    func arc(_ centerX: CGFloat, _ centerY: CGFloat, _ startDeg: CGFloat) {
        let steps = 3
        for step in 0 ..< steps {
            let ang = (startDeg + 90 * CGFloat(step) / CGFloat(steps)) * .pi / 180
            pts.append(CGPoint(x: centerX + radius * cos(ang), y: centerY + radius * sin(ang)))
        }
    }
    edge(radius, 0, width - radius, 0)
    arc(width - radius, radius, -90)
    edge(width, radius, width, height - radius)
    arc(width - radius, height - radius, 0)
    edge(width - radius, height, radius, height)
    arc(radius, height - radius, 90)
    edge(0, height - radius, 0, radius)
    arc(radius, radius, 180)
    if let first = pts.first { pts.append(first) }
    return pts
}

/// The hand-drawn crayon outline of a rounded rectangle: a deterministic, seeded
/// jitter of the perimeter. Same `seed` -> identical points; jitter is bounded by
/// `roughness`; the loop closes exactly (last point == first point).
func crayonOutlineOffsets(
    width: CGFloat,
    height: CGFloat,
    cornerRadius: CGFloat,
    seed: UInt64,
    roughness: CGFloat,
    segmentsPerEdge: Int = 6
)
    -> [CGPoint]
{
    let base = roundedRectPerimeter(width, height, cornerRadius, segmentsPerEdge)
    var jittered = base.enumerated().map { i, point in
        CGPoint(
            x: point.x + crayonNoise(seed, i * 2) * roughness,
            y: point.y + crayonNoise(seed, i * 2 + 1) * roughness
        )
    }
    // Close the loop exactly rather than letting the closing point drift.
    if jittered.count > 1 { jittered[jittered.count - 1] = jittered[0] }
    return jittered
}

/// A SwiftUI `Shape` for the crayon outline of its rect.
struct CrayonOutline: Shape {
    var cornerRadius: CGFloat = 18
    var seed: UInt64 = 0
    var roughness: CGFloat = 2.5

    func path(in rect: CGRect) -> Path {
        // Sample ~1 point per 26pt of the longest edge for consistent wobble density.
        let seg = max(6, min(48, Int(max(rect.width, rect.height) / 26)))
        let offsets = crayonOutlineOffsets(
            width: rect.width, height: rect.height,
            cornerRadius: cornerRadius, seed: seed, roughness: roughness, segmentsPerEdge: seg
        )
        var path = Path()
        guard let first = offsets.first else { return path }
        path.move(to: CGPoint(x: rect.minX + first.x, y: rect.minY + first.y))
        for point in offsets.dropFirst() {
            path.addLine(to: CGPoint(x: rect.minX + point.x, y: rect.minY + point.y))
        }
        path.closeSubpath()
        return path
    }
}

/// Overlays a hand-drawn crayon border on a view **without** replacing its own
/// (stateful) styling — two offset strokes give the doubled-up marker feel.
struct CrayonBorderModifier: ViewModifier {
    let color: Color
    var width: CGFloat = 2.5
    var cornerRadius: CGFloat = 18
    var seed: UInt64 = 0
    var roughness: CGFloat = 2.5

    func body(content: Content) -> some View {
        content.crayonGrain(cornerRadius: cornerRadius).overlay {
            ZStack {
                // `.opacity` multiplies (attenuates) the colour's existing alpha.
                CrayonOutline(cornerRadius: cornerRadius, seed: seed &+ 101, roughness: roughness * 1.2)
                    .stroke(
                        color.opacity(0.55),
                        style: StrokeStyle(lineWidth: width * 0.8, lineCap: .round, lineJoin: .round)
                    )
                CrayonOutline(cornerRadius: cornerRadius, seed: seed, roughness: roughness)
                    .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
            }
        }
    }
}

extension View {
    func crayonBorder(
        color: Color,
        width: CGFloat = 2.5,
        cornerRadius: CGFloat = 18,
        seed: UInt64 = 0,
        roughness: CGFloat = 2.5
    )
        -> some View
    {
        modifier(CrayonBorderModifier(
            color: color,
            width: width,
            cornerRadius: cornerRadius,
            seed: seed,
            roughness: roughness
        ))
    }
}
