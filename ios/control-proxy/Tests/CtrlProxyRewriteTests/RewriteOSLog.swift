@testable import CtrlProxyRewrite
import OSLog

/// Bridges the `CtrlProxyRewrite` `OSLogReader.mapLevel` (see `ReferenceOSLog`).
enum RewriteOSLog {
    static func mapLevel(_ level: OSLogEntryLog.Level) -> Int {
        OSLogReader.mapLevel(level)
    }

    static var pollIntervalMs: Int { OSLogReader.pollIntervalMs }
}
