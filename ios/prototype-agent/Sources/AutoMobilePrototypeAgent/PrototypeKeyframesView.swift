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
            KeyframeAnimator(initialValue: PrototypeKeyframePhases(
                scale: initial("scale"), scaleX: initial("scaleX"), scaleY: initial("scaleY"),
                rotation: initial("rotation"), offsetX: initial("offsetX"), offsetY: initial("offsetY"),
                alpha: initial("alpha")
            ), trigger: generation) { phases in
                content
                    .scaleEffect(
                        x: value("scale", phases.scale) * value("scaleX", phases.scaleX),
                        y: value("scale", phases.scale) * value("scaleY", phases.scaleY)
                    )
                    .rotationEffect(.degrees(value("rotation", phases.rotation)))
                    .offset(x: value("offsetX", phases.offsetX), y: value("offsetY", phases.offsetY))
                    .opacity(value("alpha", phases.alpha))
            } keyframes: { _ in
                KeyframeTrack(\.scale) { timeline("scale") }
                KeyframeTrack(\.scaleX) { timeline("scaleX") }
                KeyframeTrack(\.scaleY) { timeline("scaleY") }
                KeyframeTrack(\.rotation) { timeline("rotation") }
                KeyframeTrack(\.offsetX) { timeline("offsetX") }
                KeyframeTrack(\.offsetY) { timeline("offsetY") }
                KeyframeTrack(\.alpha) { timeline("alpha") }
            }
        }

        private func value(_ name: String, _ phase: Double) -> Double {
            guard let track = tracks[name] else { return name.hasPrefix("scale") || name == "alpha" ? 1 : 0 }
            // Native springs animate property values; standard uses the shared exact Bezier sampler.
            let curve = track.objectFields?["curve"]?.stringValue ?? "standard"
            if curve == "spring" { return phase }
            return keyframeValue(points: PrototypeKeyframes.points(track), curve: curve, fraction: phase)
        }

        private func initial(_ name: String) -> Double {
            tracks[name]?.objectFields?["curve"]?.stringValue == "spring"
                && (name.hasPrefix("scale") || name == "alpha") ? 1 : 0
        }

        @KeyframeTrackContentBuilder<Double>
        private func timeline(_ name: String)
            -> some KeyframeTrackContent<Double>
        {
            // A trigger during a play resets from zero, rather than continuing the interrupted phase.
            MoveKeyframe(initial(name))
            // KeyframeTrackContentBuilder has no `for`: the contract allows at most 8 points (7 segments).
            if let track = tracks[name] {
                let count = PrototypeKeyframes.points(track).count
                if count > 1 { segment(track, 1) }
                if count > 2 { segment(track, 2) }
                if count > 3 { segment(track, 3) }
                if count > 4 { segment(track, 4) }
                if count > 5 { segment(track, 5) }
                if count > 6 { segment(track, 6) }
                if count > 7 { segment(track, 7) }
            } else {
                MoveKeyframe(0)
            }
        }

        @KeyframeTrackContentBuilder<Double>
        private func segment(
            _ track: JSONValue,
            _ index: Int
        )
            -> some KeyframeTrackContent<Double>
        {
            let points = PrototypeKeyframes.points(track)
            let end = points[index].0
            let seconds = (end - points[index - 1].0) * duration
            let curve = track.objectFields?["curve"]?.stringValue ?? "standard"
            if curve == "spring" {
                SpringKeyframe(
                    points[index].1,
                    duration: seconds,
                    spring: Spring(
                        duration: PrototypeKeyframeTiming.springDuration,
                        bounce: PrototypeKeyframeTiming.springBounce
                    )
                )
            } else if curve == "linear" {
                LinearKeyframe(end, duration: seconds)
            } else {
                // Linear phase in native cubic time; the sampler applies (0.2,0,0,1) per segment.
                CubicKeyframe(end, duration: seconds, startVelocity: 1 / duration, endVelocity: 1 / duration)
            }
        }
    }
#endif
