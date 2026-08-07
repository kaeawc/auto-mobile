import SwiftUI

// MARK: - Crayon sketch (iOS)

// Mirror of the Android design-system `CrayonSketch`: a pure, deterministic,
// seeded jitter of a rounded-rectangle perimeter, drawn as a doubled-up marker
// outline. Deterministic (no `Double.random`) so it is host-testable and never
// flakes; the loop closes exactly and the modifier attenuates the caller's alpha.
// Native SwiftUI (Shape/Canvas) — no Metal here (that is the shader item).

/// Deterministic hash noise in [-1, 1) from a seed and index.
func crayonNoise(_ seed: UInt64, _ i: Int) -> CGFloat {
    var h = seed ^ (UInt64(i) &* 0x9E37_79B9_7F4A_7C15)
    h = (h ^ (h >> 33)) &* 0xFF51_AFD7_ED55_8CCD
    h = (h ^ (h >> 33)) &* 0xC4CE_B9FE_1A85_EC53
    h ^= (h >> 33)
    let u = Double(h >> 11) / Double(UInt64(1) << 53) // [0, 1)
    return CGFloat(u * 2 - 1)
}

/// Base rounded-rectangle perimeter, sampled clockwise from the top edge and
/// closed (the last point repeats the first). Every point is within the box.
private func roundedRectPerimeter(
    _ width: CGFloat, _ height: CGFloat, _ corner: CGFloat, _ segmentsPerEdge: Int
) -> [CGPoint] {
    let r = min(max(corner, 0), min(width, height) / 2)
    var pts: [CGPoint] = []
    func edge(_ x0: CGFloat, _ y0: CGFloat, _ x1: CGFloat, _ y1: CGFloat) {
        for s in 0..<segmentsPerEdge {
            let t = CGFloat(s) / CGFloat(segmentsPerEdge)
            pts.append(CGPoint(x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t))
        }
    }
    func arc(_ cx: CGFloat, _ cy: CGFloat, _ startDeg: CGFloat) {
        let steps = 3
        for s in 0...steps {
            let ang = (startDeg + 90 * CGFloat(s) / CGFloat(steps)) * .pi / 180
            pts.append(CGPoint(x: cx + r * cos(ang), y: cy + r * sin(ang)))
        }
    }
    edge(r, 0, width - r, 0)
    arc(width - r, r, -90)
    edge(width, r, width, height - r)
    arc(width - r, height - r, 0)
    edge(width - r, height, r, height)
    arc(r, height - r, 90)
    edge(0, height - r, 0, r)
    arc(r, r, 180)
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
) -> [CGPoint] {
    let base = roundedRectPerimeter(width, height, cornerRadius, segmentsPerEdge)
    var jittered = base.enumerated().map { i, p in
        CGPoint(
            x: p.x + crayonNoise(seed, i * 2) * roughness,
            y: p.y + crayonNoise(seed, i * 2 + 1) * roughness
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
        for p in offsets.dropFirst() {
            path.addLine(to: CGPoint(x: rect.minX + p.x, y: rect.minY + p.y))
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
        content.overlay {
            ZStack {
                // `.opacity` multiplies (attenuates) the colour's existing alpha.
                CrayonOutline(cornerRadius: cornerRadius, seed: seed &+ 101, roughness: roughness * 1.2)
                    .stroke(color.opacity(0.55), style: StrokeStyle(lineWidth: width * 0.8, lineCap: .round, lineJoin: .round))
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
    ) -> some View {
        modifier(CrayonBorderModifier(color: color, width: width, cornerRadius: cornerRadius, seed: seed, roughness: roughness))
    }
}
