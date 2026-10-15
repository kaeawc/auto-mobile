import Foundation

/// Resolves taps using caller-supplied monotonic timestamps, without clocks or timers.
struct PrototypeTapDisambiguator {
    enum Decision: Equatable {
        case fireDouble
        case deferSingle(deadline: TimeInterval)
    }

    static let doubleTapWindow: TimeInterval = 0.35

    private let window: TimeInterval
    private var pendingSince: TimeInterval?

    init(window: TimeInterval = Self.doubleTapWindow) {
        self.window = window
    }

    mutating func tap(at now: TimeInterval) -> Decision {
        if let pendingSince, now - pendingSince <= window {
            self.pendingSince = nil
            return .fireDouble
        }
        // The caller should flush expired singles before submitting a later tap.
        pendingSince = now
        return .deferSingle(deadline: now + window)
    }

    mutating func expire(at now: TimeInterval) -> Bool {
        guard let pendingSince, now - pendingSince >= window else { return false }
        self.pendingSince = nil
        return true
    }
}
