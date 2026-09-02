import Foundation

/// Per-thread AutoMobile session identity. The session UUID is stored in the current thread's
/// dictionary so each XCTest worker thread gets its own session. `Sendable`: the type holds no
/// mutable instance state (identity lives in `Thread.current.threadDictionary`, not in a property).
///
/// NOTE: the thread-local model is correct for the synchronous per-worker executor and is NOT a live
/// race. It would only break if the executor moved to async (a `Task` can resume on any pool thread);
/// that rework is deferred (Phase 8), and the executor deliberately stays synchronous.
public final class AutoMobileSession: Sendable {
    public static let shared = AutoMobileSession()
    private static let sessionKey = "AutoMobileSession.sessionUuid"

    private init() {}

    public static func currentSessionUuid() -> String {
        return shared.sessionUuid()
    }

    public func sessionUuid() -> String {
        let threadDict = Thread.current.threadDictionary
        if let existing = threadDict[AutoMobileSession.sessionKey] as? String {
            return existing
        }
        let uuid = UUID().uuidString
        threadDict[AutoMobileSession.sessionKey] = uuid
        return uuid
    }

    /// Override the session UUID for this thread.
    /// Used when startDevice returns a sessionId (autolock or default).
    public func setSessionUuid(_ uuid: String) {
        Thread.current.threadDictionary[AutoMobileSession.sessionKey] = uuid
    }

    public static func setCurrentSessionUuid(_ uuid: String) {
        shared.setSessionUuid(uuid)
    }
}
