#if canImport(UIKit)
    import SwiftUI

    /// Each track runs in draw space; layout proposals and observed spec state stay unchanged.
    struct PrototypeKeyframesModifier: ViewModifier {
        let frames: JSONValue?
        let trigger: JSONValue?
        let profile: PrototypeMotionProfile
        let activity: PrototypeKeyframeActivity
        @State private var generation = 0
        @State private var owner = UUID()

        @ViewBuilder
        func body(content: Content) -> some View {
            if #available(iOS 17, *), let fields = frames?.objectFields,
               let duration = fields["durationMs"]?.numberValue
            {
                let tracks = PrototypeKeyframes.filtered(fields["tracks"]?.objectFields ?? [:], profile: profile)
                content.modifier(PrototypeKeyframeTracks(
                    tracks: tracks,
                    duration: duration / 1000,
                    generation: generation
                ))
                .id(profile == .full ? 0 : profile == .reduced ? 1 : 2)
                .onChange(of: trigger) { _, _ in
                    guard !tracks.isEmpty else { return }
                    generation += 1
                    activity.play(owner: owner, durationMs: Int(duration))
                }
                .onChange(of: profile) { _, _ in activity.stop(owner: owner) }
                .onDisappear { activity.stop(owner: owner) }
            } else {
                content
            }
        }
    }

    @available(iOS 17, *)
    private struct PrototypeKeyframePhases {
        var scale = 0.0
        var scaleX = 0.0
        var scaleY = 0.0
        var rotation = 0.0
        var offsetX = 0.0
        var offsetY = 0.0
        var alpha = 0.0
    }

    @available(iOS 17, *)
    private struct PrototypeKeyframeTracks: ViewModifier {
        let tracks: [String: JSONValue]
        let duration: Double
        let generation: Int

        func body(content: Content) -> some View {
            KeyframeAnimator(initialValue: PrototypeKeyframePhases(), trigger: generation) { phases in
                content
                    .scaleEffect(
                        x: value("scale", phases.scale) * value("scaleX", phases.scaleX),
                        y: value("scale", phases.scale) * value("scaleY", phases.scaleY)
                    )
                    .rotationEffect(.degrees(value("rotation", phases.rotation)))
                    .offset(x: value("offsetX", phases.offsetX), y: value("offsetY", phases.offsetY))
                    .opacity(value("alpha", phases.alpha))
            } keyframes: { _ in
                KeyframeTrack(\.scale) { timeline() }
                KeyframeTrack(\.scaleX) { timeline() }
                KeyframeTrack(\.scaleY) { timeline() }
                KeyframeTrack(\.rotation) { timeline() }
                KeyframeTrack(\.offsetX) { timeline() }
                KeyframeTrack(\.offsetY) { timeline() }
                KeyframeTrack(\.alpha) { timeline() }
            }
        }

        /// Every track runs one linear 0 to 1 phase; `keyframeValue` applies the points and curve, so all
        /// three curves share the Android sampler (the result builder has no control flow).
        private func value(_ name: String, _ phase: Double) -> Double {
            guard let track = tracks[name] else { return name.hasPrefix("scale") || name == "alpha" ? 1 : 0 }
            let curve = track.objectFields?["curve"]?.stringValue ?? "standard"
            return keyframeValue(points: PrototypeKeyframes.points(track), curve: curve, fraction: phase)
        }

        @KeyframeTrackContentBuilder<Double>
        private func timeline() -> some KeyframeTrackContent<Double> {
            // A trigger during a play resets from zero, rather than continuing the interrupted phase.
            MoveKeyframe(0)
            LinearKeyframe(1, duration: duration)
        }
    }
#endif
