@testable import CtrlProxy
import OSLog

/// Bridges the REFERENCE `OSLogReader.mapLevel` (imports only `CtrlProxy`).
enum ReferenceOSLog {
    static func mapLevel(_ level: OSLogEntryLog.Level) -> Int {
        OSLogReader.mapLevel(level)
    }

    static var pollIntervalMs: Int { OSLogReader.pollIntervalMs }
}
