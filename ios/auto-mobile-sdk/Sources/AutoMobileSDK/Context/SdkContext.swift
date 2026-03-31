import Foundation

/// Thread-safe mutable context holding ambient state attached to SDK events.
public final class SdkContext: @unchecked Sendable {
    private let lock = NSLock()
    private var _sessionId: String?
    private var _userId: String?
    private var _appVersion: String?
    private var _tags: [String: String] = [:]

    public init() {}

    public var sessionId: String? {
        get { lock.lock(); defer { lock.unlock() }; return _sessionId }
        set { lock.lock(); _sessionId = newValue; lock.unlock() }
    }

    public var userId: String? {
        get { lock.lock(); defer { lock.unlock() }; return _userId }
        set { lock.lock(); _userId = newValue; lock.unlock() }
    }

    public var appVersion: String? {
        get { lock.lock(); defer { lock.unlock() }; return _appVersion }
        set { lock.lock(); _appVersion = newValue; lock.unlock() }
    }

    public func setTag(_ key: String, value: String) {
        lock.lock(); _tags[key] = value; lock.unlock()
    }

    public func removeTag(_ key: String) {
        lock.lock(); _tags.removeValue(forKey: key); lock.unlock()
    }

    public func clearTags() {
        lock.lock(); _tags.removeAll(); lock.unlock()
    }

    /// Returns an immutable snapshot.
    public func snapshot() -> SdkContextSnapshot {
        lock.lock()
        defer { lock.unlock() }
        return SdkContextSnapshot(
            sessionId: _sessionId, userId: _userId,
            appVersion: _appVersion, tags: _tags
        )
    }

    public func reset() {
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
