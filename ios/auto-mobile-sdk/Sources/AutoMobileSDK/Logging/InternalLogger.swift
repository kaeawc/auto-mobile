import os

internal enum InternalLogger {
    private static let logger = os.Logger(subsystem: "dev.jasonpearson.automobile", category: "SDK")

    static func debug(_ message: @autoclosure () -> String) {
        #if DEBUG
        let msg = message()
        logger.debug("\(msg, privacy: .public)")
        #endif
    }

    static func warning(_ message: @autoclosure () -> String) {
        #if DEBUG
        let msg = message()
        logger.warning("\(msg, privacy: .public)")
        #endif
    }

    static func error(_ message: @autoclosure () -> String) {
        let msg = message()
        logger.error("\(msg, privacy: .public)")
    }
}
