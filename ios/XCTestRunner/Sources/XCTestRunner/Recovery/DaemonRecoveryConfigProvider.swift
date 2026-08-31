import Foundation
import os

/// Resolves the `ai-recovery` gate by reading the `automobile:config/feature-flags/ai-recovery`
/// resource from the daemon over the shared `AutoMobileMCPClient`. Mirrors Android
/// `DaemonRecoveryConfigProvider`. The result is memoized for the life of the provider so at most one
/// resource read happens. On any read/parse failure it logs and falls back to the daemon-side
/// defaults (enabled, `maxToolCalls: 5`).
///
/// Concurrency (closes race #4): the reference's `var cached` memo was read-then-written with no
/// synchronization. Here it is **lock-confined** (`OSAllocatedUnfairLock`), double-checked so the
/// daemon read (`fetch`) never runs while holding the lock. Cleanly `Sendable` (no `@unchecked`):
/// `clientProvider` is `@Sendable`, and every stored property is `Sendable`.
public final class DaemonRecoveryConfigProvider: RecoveryConfigProviding {
    public static let resourceURI = "automobile:config/feature-flags/ai-recovery"
    private static let defaultEnabled = true
    private static let defaultMaxToolCalls = 5

    private let clientProvider: @Sendable () -> AutoMobileMCPClient?
    private let timeoutSeconds: TimeInterval
    private let logger: AutoMobileLogger
    private let cached = OSAllocatedUnfairLock<(enabled: Bool, maxToolCalls: Int)?>(initialState: nil)

    public init(
        clientProvider: @escaping @Sendable () -> AutoMobileMCPClient?,
        timeoutSeconds: TimeInterval = 5,
        logger: AutoMobileLogger = StdoutLogger()
    ) {
        self.clientProvider = clientProvider
        self.timeoutSeconds = timeoutSeconds
        self.logger = logger
    }

    public func isRecoveryEnabled() -> Bool { resolve().enabled }
    public func maxRecoveryToolCalls() -> Int { resolve().maxToolCalls }

    private func resolve() -> (enabled: Bool, maxToolCalls: Int) {
        if let existing = cached.withLock({ $0 }) {
            return existing
        }
        let resolved = fetch()
        return cached.withLock { current in
            if let existing = current {
                return existing
            }
            current = resolved
            return resolved
        }
    }

    private func fetch() -> (enabled: Bool, maxToolCalls: Int) {
        guard let client = clientProvider() else {
            return (Self.defaultEnabled, Self.defaultMaxToolCalls)
        }
        do {
            try client.initialize(timeout: timeoutSeconds)
            let response = try client.readResource(uri: Self.resourceURI, timeout: timeoutSeconds)
            return Self.parse(response.text)
        } catch {
            // Log-then-default: a missing/unreadable flag must not block a test run; the daemon-side
            // default is "enabled", so recovery still engages when a key is configured.
            logger.warn("Failed to read ai-recovery feature flag; defaulting to enabled: \(error)")
            return (Self.defaultEnabled, Self.defaultMaxToolCalls)
        }
    }

    static func parse(_ text: String) -> (enabled: Bool, maxToolCalls: Int) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = object as? [String: Any]
        else {
            return (defaultEnabled, defaultMaxToolCalls)
        }
        let enabled = dict["enabled"] as? Bool ?? defaultEnabled
        var maxToolCalls = defaultMaxToolCalls
        if let config = dict["config"] as? [String: Any], let value = config["maxToolCalls"] as? Int {
            maxToolCalls = value
        }
        return (enabled, maxToolCalls)
    }
}
