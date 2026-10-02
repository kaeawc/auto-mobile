import Foundation
import os

/// A named log filter with optional regex patterns for tag and message, plus a minimum log level.
///
/// Severity level mapping between platforms:
/// - Android `wtf` corresponds to iOS `fault` (both represent the most severe log level).
public struct LogFilter: Sendable {
    public let name: String
    public let tagPattern: NSRegularExpression?
    public let messagePattern: NSRegularExpression?
    public let minLevel: LogLevel

    public init(
        name: String,
        tagPattern: NSRegularExpression? = nil,
        messagePattern: NSRegularExpression? = nil,
        minLevel: LogLevel = .verbose
    ) {
        self.name = name
        self.tagPattern = tagPattern
        self.messagePattern = messagePattern
        self.minLevel = minLevel
    }

    /// Returns `true` when the given tag, message, and level satisfy this filter.
    func matches(tag: String?, message: String, level: LogLevel) -> Bool {
        guard level >= minLevel else { return false }
        if let tagPattern = tagPattern {
            guard let tag = tag else { return false }
            let range = NSRange(tag.startIndex..., in: tag)
            if tagPattern.firstMatch(in: tag, range: range) == nil {
                return false
            }
        }
        if let messagePattern = messagePattern {
            let range = NSRange(message.startIndex..., in: message)
            if messagePattern.firstMatch(in: message, range: range) == nil {
                return false
            }
        }
        return true
    }
}

/// Log convenience methods with filter-based log capture.
///
/// Wraps `os.Logger` and applies registered filters to control which entries are
/// captured by `OSLogReader`. Filters are registered by name with optional regex
/// patterns for tag and message, plus a minimum `LogLevel` (`verbose`, `debug`,
/// `info`, `warning`, `error`, `fault`). Filters gate OSLogReader output only —
/// they do not buffer events into `SdkEventBuffer` (CtrlProxy's `/sdk-events`
/// endpoint already reads from `OSLogStore`).
///
/// Severity level mapping: Android `wtf` corresponds to iOS `fault`.
public final class AutoMobileLog: Sendable {
    public static let shared = AutoMobileLog()

    private let logger = os.Logger(subsystem: "dev.jasonpearson.automobile", category: "sdk")
    private let filters = OSAllocatedUnfairLock<[String: LogFilter]>(initialState: [:])

    private init() {}

    /// Called by AutoMobileSDK.initialize; kept for interface compatibility.
    func initialize(bundleId _: String?, buffer _: some EventBuffering) {
        // Buffer is intentionally not stored — filters gate OSLogReader output only.
        // Buffering here would cause double-emit since CtrlProxy's /sdk-events
        // endpoint already merges SDK-buffered events with OSLogStore output.
    }

    // MARK: - Filter API

    /// Registers a named filter. If a filter with the same name exists it is replaced.
    ///
    /// - Parameters:
    ///   - name: Unique filter name used for later removal.
    ///   - tagPattern: Optional regex applied to the log tag. `nil` matches any tag.
    ///   - messagePattern: Optional regex applied to the log message. `nil` matches any message.
    ///   - minLevel: Minimum log level required for a match (default `.verbose`).
    public func addFilter(
        name: String,
        tagPattern: NSRegularExpression? = nil,
        messagePattern: NSRegularExpression? = nil,
        minLevel: LogLevel = .verbose
    ) {
        let filter = LogFilter(name: name, tagPattern: tagPattern, messagePattern: messagePattern, minLevel: minLevel)
        filters.withLock { $0[name] = filter }
    }

    /// Removes the filter with the given name. No-op if the name is not registered.
    public func removeFilter(name: String) {
        filters.withLock { _ = $0.removeValue(forKey: name) }
    }

    /// Removes all registered filters.
    public func clearFilters() {
        filters.withLock { $0.removeAll() }
    }

    /// Returns a snapshot of the currently registered filter names.
    public var filterNames: [String] {
        filters.withLock { Array($0.keys) }
    }

    // MARK: - Log Methods

    private func formatted(_ tag: String?, _ message: String) -> String {
        if let tag = tag { return "[\(tag)] \(message)" }
        return message
    }

    public func v(_ tag: String? = nil, _ message: String) {
        let text = formatted(tag, message)
        logger.debug("\(text, privacy: .public)")
    }

    public func d(_ tag: String? = nil, _ message: String) {
        let text = formatted(tag, message)
        logger.debug("\(text, privacy: .public)")
    }

    public func i(_ tag: String? = nil, _ message: String) {
        let text = formatted(tag, message)
        logger.info("\(text, privacy: .public)")
    }

    public func w(_ tag: String? = nil, _ message: String) {
        let text = formatted(tag, message)
        logger.warning("\(text, privacy: .public)")
    }

    public func e(_ tag: String? = nil, _ message: String) {
        let text = formatted(tag, message)
        logger.error("\(text, privacy: .public)")
    }

    public func fault(_ tag: String? = nil, _ message: String) {
        let text = formatted(tag, message)
        logger.fault("\(text, privacy: .public)")
    }

    // MARK: - Testing Support

    /// Called by AutoMobileSDK.reset; kept for interface compatibility.
    func reset() {
        filters.withLock { $0.removeAll() }
    }
}
