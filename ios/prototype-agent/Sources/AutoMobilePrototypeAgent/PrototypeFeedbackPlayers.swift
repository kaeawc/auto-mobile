#if canImport(UIKit)
    import AudioToolbox
    import UIKit

    /// UIKit haptics for `haptics.perform` (#14329). The Simulator does not render haptics but the
    /// generators run, so the call still succeeds and is logged. "System Haptics" off is not
    /// detectable, so nothing is reported suppressed.
    @MainActor
    final class UIKitHapticsPlayer: PrototypeHapticsPlayer {
        func perform(_ effect: PrototypeHapticEffect) -> PrototypeFeedbackOutcome {
            run(PrototypeHapticPlan.plan(for: effect))
            return .played
        }

        private func run(_ plan: PrototypeHapticPlan) {
            switch plan {
            case let .impact(style):
                UIImpactFeedbackGenerator(style: Self.style(style)).impactOccurred()
            case .selection:
                UISelectionFeedbackGenerator().selectionChanged()
            case let .notification(kind):
                UINotificationFeedbackGenerator().notificationOccurred(Self.type(kind))
            case let .double(style, gapMs):
                let generator = UIImpactFeedbackGenerator(style: Self.style(style))
                generator.impactOccurred()
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(gapMs)) {
                    generator.impactOccurred()
                }
            }
        }

        private static func style(_ impact: PrototypeHapticPlan.Impact) -> UIImpactFeedbackGenerator.FeedbackStyle {
            switch impact {
            case .light: .light
            case .medium: .medium
            case .heavy: .heavy
            case .rigid: .rigid
            case .soft: .soft
            }
        }

        private static func type(_ kind: PrototypeHapticPlan.Notification) -> UINotificationFeedbackGenerator
            .FeedbackType
        {
            switch kind {
            case .success: .success
            case .warning: .warning
            case .error: .error
            }
        }
    }

    /// System sounds for `sound.play`; volume is the device's, never changed here.
    @MainActor
    final class SystemSoundPlayer: PrototypeSoundPlayer {
        func play(_ cue: PrototypeSoundCue, volume _: Int?) -> PrototypeFeedbackOutcome {
            AudioServicesPlaySystemSound(PrototypeSystemSound.id(for: cue))
            return .played
        }
    }

    extension PrototypePlatformRegistry {
        /// The haptics, sound and links modules the injected agent and ProtoViewer register; none needs
        /// a permission or an Info.plist key.
        static func feedbackModules() -> PrototypePlatformRegistry {
            PrototypePlatformRegistry(modules: [
                PrototypeHapticsModule(player: UIKitHapticsPlayer()),
                PrototypeSoundModule(player: SystemSoundPlayer()),
                PrototypeLinksModule(opener: UIKitLinkOpener()),
            ])
        }
    }
#endif
