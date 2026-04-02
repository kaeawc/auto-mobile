import Foundation

/// Thread-safe mutable context holding ambient state attached to SDK events.
final class SdkContext: @unchecked Sendable {
    private let lock = NSLock()
    private var _sessionId: String?
    private var _userId: String?
    private var _appVersion: String?
    private var _tags: [String: String] = [:]

    init() {}

    var sessionId: String? {
        get { lock.lock(); defer { lock.unlock() }; return _sessionId }
        set { lock.lock(); _sessionId = newValue; lock.unlock() }
    }

    var userId: String? {
        get { lock.lock(); defer { lock.unlock() }; return _userId }
        set { lock.lock(); _userId = newValue; lock.unlock() }
    }

    var appVersion: String? {
        get { lock.lock(); defer { lock.unlock() }; return _appVersion }
        set { lock.lock(); _appVersion = newValue; lock.unlock() }
    }

    func setTag(_ key: String, value: String) {
        lock.lock(); _tags[key] = value; lock.unlock()
    }

    func removeTag(_ key: String) {
        lock.lock(); _tags.removeValue(forKey: key); lock.unlock()
    }

    func clearTags() {
        lock.lock(); _tags.removeAll(); lock.unlock()
    }

    /// Returns an immutable snapshot.
    func snapshot() -> SdkContextSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return SdkContextSnapshot(
            sessionId: _sessionId, userId: _userId,
            appVersion: _appVersion, tags: _tags
        )
    }

    func reset() {
        lock.lock()
        _sessionId = nil; _userId = nil; _appVersion = nil; _tags.removeAll()
        lock.unlock()
    }
}

/// Immutable snapshot of SDK context.
public struct SdkContextSnapshot: Codable, Sendable, Equatable {
    public let sessionId: String?
    public let userId: String?
    public let appVersion: String?
    public let tags: [String: String]
}
