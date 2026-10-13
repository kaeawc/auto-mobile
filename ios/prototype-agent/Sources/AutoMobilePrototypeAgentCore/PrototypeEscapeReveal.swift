import Foundation

/// Host-owned escape pill visibility (#12064). Like `PrototypeIdleTimer`, callbacks run on the
/// owner's clock; UIKit supplies the main-queue clock and unit tests supply a fake.
final class PrototypeEscapeReveal {
    static let holdSeconds = 1.0
    static let visibleMilliseconds = 5000

    private let clock: PrototypeClock
    private let onChange: (Bool) -> Void
    private var timer: PrototypeTimerHandle?
    private var generation = 0
    private var hasEscape = false
    private(set) var isVisible = false

    init(clock: PrototypeClock, onChange: @escaping (Bool) -> Void) {
        self.clock = clock
        self.onChange = onChange
    }

    /// Session changes never reveal the pill. An in-place escape keeps its original deadline.
    func sync(hasEscape: Bool, shown: Bool) {
        self.hasEscape = hasEscape && shown
        if !self.hasEscape { hide() }
    }

    /// Revealing an already visible pill restarts its deadline without publishing another change.
    func reveal() {
        guard hasEscape else { return }
        cancelTimer()
        setVisible(true)
        let token = generation
        timer = clock.schedule(afterMilliseconds: Self.visibleMilliseconds) { [weak self] in
            guard let self, token == generation else { return }
            timer = nil
            setVisible(false)
        }
    }

    func hide() {
        cancelTimer()
        setVisible(false)
    }

    private func cancelTimer() {
        generation += 1
        timer?.cancel()
        timer = nil
    }

    private func setVisible(_ visible: Bool) {
        guard isVisible != visible else { return }
        isVisible = visible
        onChange(visible)
    }
}
