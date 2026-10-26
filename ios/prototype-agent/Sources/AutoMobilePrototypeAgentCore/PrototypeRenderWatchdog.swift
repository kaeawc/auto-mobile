import Foundation

/// ProtoViewer's render watchdog, mirroring Android's `DeadlineRenderWatchdog`: a library prototype
/// that has not produced its first content within `budgetMilliseconds` of being mounted is replaced
/// by the app's error state, whose Back and Close actions remain available. The deadline covers
/// loading storage and fonts plus the first rendered content. UIKit-free: the app supplies the clock.
///
/// A main-queue timer cannot fire while the main thread is blocked, so this catches a presentation
/// that never reaches first content (a lost callback, an endless pending state), not a busy loop.
final class PrototypeRenderWatchdog {
    /// Android's `RENDER_READY_BUDGET_MILLIS`: ten seconds.
    static let budgetMilliseconds = 10000

    private let clock: PrototypeClock
    private var timer: PrototypeTimerHandle?
    private var generation = 0

    init(clock: PrototypeClock) {
        self.clock = clock
    }

    var isArmed: Bool {
        timer != nil
    }

    /// Starts the deadline, replacing any running one. `onTimeout` runs at most once per `start`.
    func start(onTimeout: @escaping () -> Void) {
        cancel()
        let token = generation
        timer = clock.schedule(afterMilliseconds: Self.budgetMilliseconds) { [weak self] in
            // A superseded or cancelled timer that already fired must not time out a newer start.
            guard let self, token == generation else { return }
            generation += 1
            timer = nil
            onTimeout()
        }
    }

    /// The first content rendered, or the presentation ended: stop without timing out.
    func cancel() {
        generation += 1
        timer?.cancel()
        timer = nil
    }
}
