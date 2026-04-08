import Foundation

public final class AutoMobileSession {
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
