import Foundation
import os

/// Thread-safe mutable context holding ambient state attached to SDK events.
final class SdkContext: Sendable {
    private struct State: Sendable {
        var sessionId: String?
        var userId: String?
        var appVersion: String?
        var tags: [String: String] = [:]
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    init() {}

    var sessionId: String? {
        get { state.withLock { $0.sessionId } }
        set { state.withLock { $0.sessionId = newValue } }
    }

    var userId: String? {
        get { state.withLock { $0.userId } }
        set { state.withLock { $0.userId = newValue } }
    }

    var appVersion: String? {
        get { state.withLock { $0.appVersion } }
        set { state.withLock { $0.appVersion = newValue } }
    }

    func setTag(_ key: String, value: String) {
        state.withLock { $0.tags[key] = value }
    }

    func removeTag(_ key: String) {
        state.withLock { _ = $0.tags.removeValue(forKey: key) }
    }

    func clearTags() {
        state.withLock { $0.tags.removeAll() }
    }

    /// Returns an immutable snapshot.
    func snapshot() -> SdkContextSnapshot {
        state.withLock { state in
            SdkContextSnapshot(
                sessionId: state.sessionId, userId: state.userId,
                appVersion: state.appVersion, tags: state.tags
            )
        }
    }

    func reset() {
        state.withLock { state in
            state.sessionId = nil; state.userId = nil; state.appVersion = nil; state.tags.removeAll()
        }
    }
}

/// Immutable snapshot of SDK context.
public struct SdkContextSnapshot: Codable, Sendable, Equatable {
    public let sessionId: String?
    public let userId: String?
    public let appVersion: String?
    public let tags: [String: String]
}
