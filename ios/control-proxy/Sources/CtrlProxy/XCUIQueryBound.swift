import Foundation

/// Response bound for commands whose main-actor work is a read-only live XCUITest query (#10640).
///
/// A query against a suspended app (for example a few seconds after Home, while
/// `XCUIApplication.state` still reports foreground) stalls for about 92 s (3 x ~31 s) before
/// XCTest fails it with "Timed out while evaluating UI query". The XCUI types are annotated
/// `@MainActor` in the SDK, so the query cannot move to a worker queue and be abandoned there.
/// The bound is therefore a response bound, like a swipe's: the server answers the host at the
/// bound with an actionable error and discards the late result. It keeps the serial chain and
/// in-flight guard held until the main actor returns, so later commands get `runner_busy`
/// instead of piling onto the blocked actor. Only read-only commands are bounded here, so
/// nothing changes on the device after the host has been told the command failed.
enum XCUIQueryBound {
    /// Matches `WebSocketServer.defaultBusyBudgetMs`: a capture this slow is already pathological,
    /// and the answer still reaches the host before its 15 s `IOS_HIERARCHY_REQUEST_TIMEOUT_MS`.
    static let defaultBoundMs: Int64 = 10000

    static let boundedCommandTypes: Set<String> = [
        RequestType.requestHierarchy.rawValue,
        RequestType.requestHierarchyIfStale.rawValue,
    ]

    /// The execution bound for `commandType`, or nil when the command is not a bounded query.
    /// A host wire budget (`startExpiryMs`, from `timeoutMs`) can only shorten the default.
    static func boundMs(commandType: String, startExpiryMs: Int64?, executionStartedAtMs: Int64) -> Int64? {
        guard boundedCommandTypes.contains(commandType) else { return nil }
        let wireBound = gestureExecutionBoundMs(deadlineMs: startExpiryMs, executionStartedAtMs: executionStartedAtMs)
        return min(defaultBoundMs, wireBound ?? defaultBoundMs)
    }
}
