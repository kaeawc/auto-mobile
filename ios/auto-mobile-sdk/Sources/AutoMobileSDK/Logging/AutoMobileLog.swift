import Foundation
import os.log

/// Log convenience methods.
/// Thin wrappers around os.Logger; logs are captured by OSLogStore in CtrlProxy.
public final class AutoMobileLog: @unchecked Sendable {
    public static let shared = AutoMobileLog()

    private let logger = os.Logger(subsystem: "dev.jasonpearson.automobile", category: "sdk")

    private init() {}

    /// Called by AutoMobileSDK.initialize; kept for interface compatibility.
    func initialize(bundleId: String?, buffer: SdkEventBuffer) {}

    // MARK: - Log Methods

    private func formatted(_ tag: String?, _ message: String) -> String {
        if let tag = tag { return "[\(tag)] \(message)" }
        return message
    }

    public func v(_ tag: String? = nil, _ message: String) {
        logger.debug("\(self.formatted(tag, message), privacy: .public)")
    }

    public func d(_ tag: String? = nil, _ message: String) {
        logger.debug("\(self.formatted(tag, message), privacy: .public)")
    }

    public func i(_ tag: String? = nil, _ message: String) {
        logger.info("\(self.formatted(tag, message), privacy: .public)")
    }

    public func w(_ tag: String? = nil, _ message: String) {
        logger.warning("\(self.formatted(tag, message), privacy: .public)")
    }

    public func e(_ tag: String? = nil, _ message: String) {
        logger.error("\(self.formatted(tag, message), privacy: .public)")
    }

    public func fault(_ tag: String? = nil, _ message: String) {
        logger.fault("\(self.formatted(tag, message), privacy: .public)")
    }

    // MARK: - Testing Support

    /// Called by AutoMobileSDK.reset; kept for interface compatibility.
    internal func reset() {}
}
