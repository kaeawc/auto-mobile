#if canImport(UIKit)
    import SwiftUI

    /// Style `shimmer` (#14207, #14689): a highlight band sweeping across the node's background, on
    /// top of its content and inside its corner shape, as Android's `prototypeShimmer`. The node reads
    /// "Loading" to VoiceOver. With motion off (`motion: "none"` or Reduce Motion) no band is drawn, so
    /// screenshots and `observe` see the plain placeholder.
    struct PrototypeShimmerModifier<ClipShape: Shape>: ViewModifier {
        let enabled: Bool
        let animated: Bool
        let shape: ClipShape

        func body(content: Content) -> some View {
            if enabled {
                content
                    .overlay {
                        if animated {
                            PrototypeShimmerBand().clipShape(shape).allowsHitTesting(false)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityValue("Loading")
                    .accessibilityAddTraits(.updatesFrequently)
            } else {
                content
            }
        }
    }

    /// The sweep itself, driven by the display clock so it needs no state of its own.
    private struct PrototypeShimmerBand: View {
        /// The band's peak opacity, as on Android.
        private static let alpha = 0.35

        var body: some View {
            TimelineView(.animation) { timeline in
                GeometryReader { geometry in
                    let width = geometry.size.width
                    let band = width / 2
                    let centre = PrototypeLoadingStates.shimmerCentre(
                        progress: PrototypeLoadingStates.shimmerProgress(
                            at: timeline.date.timeIntervalSinceReferenceDate
                        ),
                        width: width,
                        band: band
                    )
                    LinearGradient(
                        colors: [.clear, .white.opacity(Self.alpha), .clear],
                        startPoint: UnitPoint(x: width > 0 ? (centre - band / 2) / width : 0, y: 0),
                        endPoint: UnitPoint(x: width > 0 ? (centre + band / 2) / width : 0, y: 1)
                    )
                }
            }
        }
    }
#endif
