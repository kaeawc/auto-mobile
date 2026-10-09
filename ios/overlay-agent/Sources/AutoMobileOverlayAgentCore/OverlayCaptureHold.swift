import Foundation

/// State machine behind `hide_for_capture` / `restore_after_capture` (#9305): the overlay is
/// hidden for the host's screenshot and comes back on `restore_after_capture` or when the
/// deadline passes, whichever is first. The deadline is the safety net for a host that is
/// cancelled between hide and restore. UIKit-free: the agent supplies timers, tests a clock.
struct OverlayCaptureHold {
    static let defaultDeadlineMs = 1500
    /// Upper bound so a bad request cannot keep the overlay hidden for long.
    static let maxDeadlineMs = 5000

    /// Handed to the timer the agent schedules; an expiry only counts for the hold that set it.
    struct Ticket: Equatable {
        let generation: Int
        let deadlineMs: Int
    }

    private let now: () -> TimeInterval
    private var generation = 0
    private var deadline: TimeInterval?

    init(now: @escaping () -> TimeInterval) {
        self.now = now
    }

    var isHiding: Bool {
        deadline != nil
    }

    static func clampedDeadlineMs(_ requested: Any?) -> Int {
        guard let number = requested as? NSNumber else { return defaultDeadlineMs }
        return min(max(number.intValue, 1), maxDeadlineMs)
    }

    /// Starts (or extends) a hold. A second hide while hidden replaces the first deadline and
    /// invalidates its timer.
    mutating func hide(deadlineMs: Int) -> Ticket {
        generation += 1
        deadline = now() + Double(deadlineMs) / 1000
        return Ticket(generation: generation, deadlineMs: deadlineMs)
    }

    /// Ends the hold; `true` when something was hidden and the overlay must be restored.
    mutating func restore() -> Bool {
        defer { deadline = nil }
        return deadline != nil
    }

    /// The timer for `ticket` fired: restores only if that hold is still the current one.
    mutating func expire(_ ticket: Ticket) -> Bool {
        guard ticket.generation == generation, let deadline, now() >= deadline else { return false }
        self.deadline = nil
        return true
    }
}
