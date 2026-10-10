import Foundation

/// Idle expiry, mirroring Android's `PrototypeLifecycle` / `PrototypeController.armIdle`: the shown
/// prototype is dismissed with reason `ttl` after `ttlMilliseconds` without activity. The owner
/// calls `arm()` on a show (including a same-id replace) and on a real user interaction, and
/// `cancel()` when the prototype ends; configuration changes, hiding for a screenshot and initial
/// pager reports are not activity. A hidden prototype still expires. UIKit-free: the agent supplies
/// the clock.
final class PrototypeIdleTimer {
    /// Android's `DEFAULT_PROTOTYPE_IDLE_TTL_MILLIS`: five minutes.
    static let defaultTtlMilliseconds = 300_000

    private let clock: PrototypeClock
    private let onExpire: () -> Void
    private var timer: PrototypeTimerHandle?
    private var generation = 0

    /// Positive, settable locally (Android's `setIdleTtlMillis`); no wire field carries it. A new
    /// value applies from the next `arm()`.
    var ttlMilliseconds: Int {
        didSet { precondition(ttlMilliseconds > 0, "Prototype idle TTL must be positive") }
    }

    init(
        clock: PrototypeClock,
        ttlMilliseconds: Int = PrototypeIdleTimer.defaultTtlMilliseconds,
        onExpire: @escaping () -> Void
    ) {
        precondition(ttlMilliseconds > 0, "Prototype idle TTL must be positive")
        self.clock = clock
        self.ttlMilliseconds = ttlMilliseconds
        self.onExpire = onExpire
    }

    var isArmed: Bool {
        timer != nil
    }

    /// Restarts the countdown, replacing any running one.
    func arm() {
        cancel()
        let token = generation
        timer = clock.schedule(afterMilliseconds: ttlMilliseconds) { [weak self] in
            // A superseded timer that already fired must not expire the restarted countdown.
            guard let self, token == generation else { return }
            timer = nil
            onExpire()
        }
    }

    func cancel() {
        generation += 1
        timer?.cancel()
        timer = nil
    }
}

/// The authenticated host connections. The prototype belongs to the host session, not to one
/// socket (as on Android, where the controller sees a client count): it ends when the last one
/// goes away, and a prototype shown after that edge is ended too. Unauthenticated connections never
/// count, and closing is idempotent because Network.framework can report both `failed` and
/// `cancelled` for one connection.
struct PrototypeClientTracker<ID: Hashable> {
    private var authenticated: Set<ID> = []

    var count: Int {
        authenticated.count
    }

    /// The new count when `id` newly counts, else nil.
    mutating func authenticate(_ id: ID) -> Int? {
        authenticated.insert(id).inserted ? count : nil
    }

    /// The new count when `id` was counted, else nil.
    mutating func close(_ id: ID) -> Int? {
        authenticated.remove(id) == nil ? nil : count
    }
}
