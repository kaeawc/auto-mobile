import Foundation

/// State machine behind `hide_for_capture` / `restore_after_capture` (#9305): the prototype is
/// hidden for the host's screenshot and comes back when the last hold is released or expires.
/// Holds are token-counted (#10995) so overlapping captures cannot show the prototype during each
/// other: each `hide` returns its own token with its own deadline, and the window is shown again
/// only once no token is left. The deadline is the safety net for a host that is cancelled between
/// hide and restore. UIKit-free: the agent supplies timers, tests a clock.
///
/// Tokens start from a random per-process seed (#11018), so a host still holding a token from a
/// previous agent process cannot release a live hold in a relaunched one: the stale token is
/// unknown, `restore` answers `restored: false`, and the host treats that capture as unconfirmed.
struct PrototypeCaptureHold {
    static let defaultDeadlineMs = 1500
    /// Upper bound so a bad request cannot keep the prototype hidden for long. It must cover the
    /// host's iOS screenshot timeout (10 s, `IOS_SCREENSHOT_TIMEOUT_MS`) plus its margin, or a slow
    /// capture would outlive its hold.
    static let maxDeadlineMs = 15000

    /// Handed to the timer the agent schedules; an expiry only counts for the hold that set it.
    struct Ticket: Equatable {
        let token: Int
        let deadlineMs: Int
    }

    /// Largest token seed. The host reads tokens as JSON numbers in JavaScript, which are exact
    /// only up to 2^53 - 1, so seeds stay below 2^52 and leave 2^52 tokens of headroom; a full
    /// 64-bit seed would round in the host and make every restore miss its hold.
    static let maxTokenSeed = 1 << 52

    /// A fresh seed from the system's cryptographically secure generator.
    static func randomTokenSeed() -> Int {
        var generator = SystemRandomNumberGenerator()
        return randomTokenSeed(using: &generator)
    }

    static func randomTokenSeed(using generator: inout some RandomNumberGenerator) -> Int {
        Int.random(in: 0 ..< maxTokenSeed, using: &generator)
    }

    private let now: () -> TimeInterval
    private var lastToken: Int
    private var deadlines: [Int: TimeInterval] = [:]

    /// `tokenSeed` is the value the first token follows; tests inject it, the agent leaves the
    /// random per-process default.
    init(now: @escaping () -> TimeInterval, tokenSeed: Int = PrototypeCaptureHold.randomTokenSeed()) {
        self.now = now
        lastToken = tokenSeed
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
        /// No hold is left, so the prototype must be shown again.
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
    /// last one, so the prototype must be shown again.
    mutating func expire(_ ticket: Ticket) -> Bool {
        guard let deadline = deadlines[ticket.token], now() >= deadline else { return false }
        deadlines.removeValue(forKey: ticket.token)
        return deadlines.isEmpty
    }
}
