import Foundation

/// Protocol for tracking user sessions based on app lifecycle.
protocol SessionTracking: AnyObject, Sendable {
    func currentSessionId() -> String?
    func onForeground()
    func onBackground()
    func shutdown()
}

/// Tracks user sessions based on app lifecycle.
/// A new session starts on first foreground or after timeout while backgrounded.
final class SessionTracker: SessionTracking, @unchecked Sendable {
    enum State { case active, backgrounded, ended }

    private let lock = NSLock()
    private let timeoutMs: Int
    private let uuidProvider: () -> String
    private let timerFactory: () -> any TimerScheduling
    private var _sessionId: String?
    private var state: State = .ended
    private var timeoutTimer: (any TimerScheduling)?

    convenience init(
        timeoutMs: Int = 30_000,
        uuidProvider: @escaping () -> String = { UUID().uuidString }
    ) {
        self.init(timeoutMs: timeoutMs, uuidProvider: uuidProvider, timerFactory: { GCDTimer() })
    }

    init(
        timeoutMs: Int,
        uuidProvider: @escaping () -> String,
        timerFactory: @escaping () -> any TimerScheduling
    ) {
        self.timeoutMs = timeoutMs
        self.uuidProvider = uuidProvider
        self.timerFactory = timerFactory
    }

    func currentSessionId() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return _sessionId
    }

    func onForeground() {
        lock.lock()
        timeoutTimer?.cancel()
        timeoutTimer = nil
        switch state {
        case .ended:
            _sessionId = uuidProvider()
            state = .active
        case .backgrounded:
            state = .active
        case .active:
            break
        }
        lock.unlock()
    }

    func onBackground() {
        lock.lock()
        guard state == .active else { lock.unlock(); return }
        state = .backgrounded
        let timer = timerFactory()
        timeoutTimer = timer
        lock.unlock()

        timer.schedule(intervalMs: timeoutMs) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            if self.state == .backgrounded {
                self.state = .ended
                self._sessionId = nil
            }
            self.timeoutTimer?.cancel()
            self.timeoutTimer = nil
            self.lock.unlock()
        }
    }

    func shutdown() {
        lock.lock()
        timeoutTimer?.cancel()
        timeoutTimer = nil
        state = .ended
        _sessionId = nil
        lock.unlock()
    }
}
