import SwiftUI

/// Shared Android/iOS tuning. Positions and cell size are in logical points.
struct CrayonGrainDefaults {
    let cellSize: Float = 1.5
    let maxAlpha: Float = 0.06
    let seed: Float = 0
    let hashX: Float = 12.9898
    let hashY: Float = 78.233
    let hashScale: Float = 43758.5453

    /// Pure mapping in the Metal function's argument order; no rendering required.
    func shaderArgumentValues() -> [Float] {
        [cellSize, maxAlpha, seed, hashX, hashY, hashScale]
    }
}

struct CrayonGrainModifier: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        // Belt-and-braces: project.yml already requires iOS 17.0.
        if #available(iOS 17, *) {
            content.overlay {
                Rectangle()
                    .fill(.white)
                    .colorEffect(Shader(
                        function: ShaderLibrary.default.crayonGrain,
                        arguments: CrayonGrainDefaults().shaderArgumentValues().map { .float($0) }
                    ))
                    .clipShape(PlaygroundShapes().rounded(cornerRadius))
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        } else {
            content
        }
    }
}

extension View {
    func crayonGrain(cornerRadius: CGFloat = 18) -> some View {
        modifier(CrayonGrainModifier(cornerRadius: cornerRadius))
    }
}
