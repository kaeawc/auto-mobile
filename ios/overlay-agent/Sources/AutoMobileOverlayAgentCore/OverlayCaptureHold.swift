import Foundation

/// State machine behind `hide_for_capture` / `restore_after_capture` (#9305): the overlay is
/// hidden for the host's screenshot and comes back when the last hold is released or expires.
/// Holds are token-counted (#10995) so overlapping captures cannot show the overlay during each
/// other: each `hide` returns its own token with its own deadline, and the window is shown again
/// only once no token is left. The deadline is the safety net for a host that is cancelled between
/// hide and restore. UIKit-free: the agent supplies timers, tests a clock.
struct OverlayCaptureHold {
    static let defaultDeadlineMs = 1500
    /// Upper bound so a bad request cannot keep the overlay hidden for long. It must cover the
    /// host's iOS screenshot timeout (10 s, `IOS_SCREENSHOT_TIMEOUT_MS`) plus its margin, or a slow
    /// capture would outlive its hold.
    static let maxDeadlineMs = 15000

    /// Handed to the timer the agent schedules; an expiry only counts for the hold that set it.
    struct Ticket: Equatable {
        let token: Int
        let deadlineMs: Int
    }

    private let now: () -> TimeInterval
    private var lastToken = 0
    private var deadlines: [Int: TimeInterval] = [:]

    init(now: @escaping () -> TimeInterval) {
        self.now = now
    }

    var isHiding: Bool {
        !deadlines.isEmpty
    }

    static func clampedDeadlineMs(_ requested: Any?) -> Int {
        guard let number = requested as? NSNumber else { return defaultDeadlineMs }
        return min(max(number.intValue, 1), maxDeadlineMs)
    }

    /// Starts a hold with its own token and deadline; other holds are untouched.
    mutating func hide(deadlineMs: Int) -> Ticket {
        lastToken += 1
        deadlines[lastToken] = now() + Double(deadlineMs) / 1000
        return Ticket(token: lastToken, deadlineMs: deadlineMs)
    }

    /// Result of releasing a hold.
    struct Release: Equatable {
        /// A hold was released (the token was still live, or any hold existed for a tokenless restore).
        let released: Bool
        /// No hold is left, so the overlay must be shown again.
        let shouldShow: Bool
    }

    /// Releases `token`'s hold; a restore without a token (an older host) releases every hold.
    /// A token that already expired or was released releases nothing.
    mutating func restore(token: Int?) -> Release {
        guard let token else {
            let had = isHiding
            deadlines.removeAll()
            return Release(released: had, shouldShow: had)
        }
        guard deadlines.removeValue(forKey: token) != nil else {
            return Release(released: false, shouldShow: false)
        }
        return Release(released: true, shouldShow: deadlines.isEmpty)
    }

    /// The timer for `ticket` fired: drops that hold if still live and due. `true` when it was the
    /// last one, so the overlay must be shown again.
    mutating func expire(_ ticket: Ticket) -> Bool {
        guard let deadline = deadlines[ticket.token], now() >= deadline else { return false }
        deadlines.removeValue(forKey: ticket.token)
        return deadlines.isEmpty
    }
}
