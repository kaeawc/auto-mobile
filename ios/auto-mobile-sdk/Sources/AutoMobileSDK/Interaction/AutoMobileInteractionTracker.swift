import Foundation
import os
#if canImport(UIKit)
    import UIKit
#endif

/// Automatic tap tracking.
/// iOS equivalent of Android's AutoMobileClickTracker.
/// Tracks user taps with coordinates, target view info, and accessibility labels.
public final class AutoMobileInteractionTracker: Sendable {
    public static let shared = AutoMobileInteractionTracker()

    private struct State: Sendable {
        var buffer: SdkEventBuffer?
        var bundleId: String?
        var isEnabled = false
        var lastTapProcessedAt: TimeInterval = 0
        var dateProvider: DateProvider = SystemDateProvider()
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    /// Minimum interval between tap event processing (milliseconds).
    static let tapDebounceMs: TimeInterval = 100

    private init() {}

    func initialize(
        bundleId: String?, buffer: SdkEventBuffer, dateProvider: DateProvider = SystemDateProvider()
    ) {
        state.withLock { state in
            state.bundleId = bundleId
            state.buffer = buffer
            state.dateProvider = dateProvider
        }
    }

    /// Whether interaction tracking is enabled.
    public var isEnabled: Bool {
        state.withLock { $0.isEnabled }
    }

    /// Enable or disable interaction tracking.
    /// When enabled, call `recordTap` from your gesture recognizers or SwiftUI tap handlers.
    public func setEnabled(_ enabled: Bool) {
        state.withLock { $0.isEnabled = enabled }
    }

    /// Record a tap event at the given coordinates.
    /// Optionally include information about the tapped element.
    public func recordTap(
        x: Double,
        y: Double,
        accessibilityLabel: String? = nil,
        accessibilityIdentifier: String? = nil,
        viewType: String? = nil,
        text: String? = nil
    ) {
        guard AutoMobileSDK.shared.isEnabled else { return }

        let snapshot = state.withLock { state -> (buffer: SdkEventBuffer?, accepted: Bool) in
            guard state.isEnabled else {
                return (nil, false)
            }

            let now = state.dateProvider.now().timeIntervalSince1970
            let elapsed = (now - state.lastTapProcessedAt) * 1000
            guard elapsed >= Self.tapDebounceMs else {
                return (nil, false)
            }
            state.lastTapProcessedAt = now
            return (state.buffer, true)
        }
        guard snapshot.accepted else { return }
        let currentBuffer = snapshot.buffer

        var properties: [String: String] = [
            "x": String(format: "%.1f", x),
            "y": String(format: "%.1f", y),
        ]

        if let label = accessibilityLabel, !label.isEmpty {
            properties["accessibilityLabel"] = label
        }
        if let identifier = accessibilityIdentifier, !identifier.isEmpty {
            properties["accessibilityIdentifier"] = identifier
        }
        if let viewType = viewType, !viewType.isEmpty {
            properties["viewType"] = viewType
        }
        if let text = text, !text.isEmpty {
            properties["text"] = text
        }

        let event = SdkInteractionEvent(interactionType: "_auto_tap", properties: properties)
        currentBuffer?.add(event)
    }

    #if canImport(UIKit)
        /// Record a tap from a UITapGestureRecognizer.
        /// Inspects the view hierarchy to extract accessibility info from the tapped view.
        public func recordTap(from recognizer: UITapGestureRecognizer, in view: UIView) {
            guard isEnabled else { return }

            let target: TapTarget
            if Thread.isMainThread {
                target = MainActor.assumeIsolated { TapTarget(recognizer: recognizer, view: view) }
            } else {
                target = DispatchQueue.main.sync {
                    MainActor.assumeIsolated { TapTarget(recognizer: recognizer, view: view) }
                }
            }

            // Keep debounce and event delivery on the caller's thread; only UIKit reads hop.
            recordTap(
                x: target.x,
                y: target.y,
                accessibilityLabel: target.accessibilityLabel,
                accessibilityIdentifier: target.accessibilityIdentifier,
                viewType: target.viewType,
                text: target.text
            )
        }

        private struct TapTarget: Sendable {
            let x: Double
            let y: Double
            let accessibilityLabel: String?
            let accessibilityIdentifier: String?
            let viewType: String?
            let text: String?

            @MainActor
            init(recognizer: UITapGestureRecognizer, view: UIView) {
                let location = recognizer.location(in: view)
                let hitView = view.hitTest(location, with: nil)
                x = Double(location.x)
                y = Double(location.y)
                accessibilityLabel = hitView?.accessibilityLabel
                accessibilityIdentifier = hitView?.accessibilityIdentifier
                viewType = hitView.map { String(describing: type(of: $0)) }
                text = (hitView as? UILabel)?.text ?? (hitView as? UIButton)?.titleLabel?.text
            }
        }
    #endif

    // MARK: - Testing Support

    func reset() {
        state.withLock { state in
            state.buffer = nil
            state.bundleId = nil
            state.isEnabled = false
            state.lastTapProcessedAt = 0
            state.dateProvider = SystemDateProvider()
        }
    }
}
