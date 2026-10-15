import Foundation
#if canImport(os)
    import os
#endif

/// Reads and writes XCTest's per-request timeout for live UI queries (#10640).
///
/// The production implementation resolves XCUIAutomation's exported C accessors
/// `_XCTXPCRequestTimeout` / `_XCTSetXPCRequestTimeout` with `dlsym`, so a missing or renamed
/// symbol on a future SDK degrades to "unavailable" instead of a crash or link failure.
protocol XCTestQueryTimeoutControlling {
    /// The current timeout in seconds, or nil when the getter is unavailable.
    func currentTimeout() -> TimeInterval?
    /// Sets the timeout in seconds. Returns false when the setter is unavailable.
    func setTimeout(_ seconds: TimeInterval) -> Bool
}

/// Shortens how long XCTest waits for one live UI query before it fails the attempt (#10640).
///
/// `-[XCUIElementQuery _executeWithError:]` sends each query to the app's automation session
/// (`-[XCTRunnerAutomationSession matchesForQuery:error:]`) and waits up to XCTest's XPC request
/// timeout, 30 s by default, for the answer. It then retries, 3 attempts in total with a 1 s
/// delay. When the app is suspended (a few seconds after Home, while `XCUIApplication.state`
/// still reports foreground), every attempt runs to the full timeout, so one `frame` or
/// `exists` read blocks the runner's main thread for about 92 s before failing with
/// "Timed out while evaluating UI query". Lowering that per-request timeout makes the same
/// query fail in about `3 x (timeout + 1 s)` and frees the main thread.
///
/// The same timeout also covers the runner's other requests to testmanagerd (app monitor
/// lookups, keyboard modifier state, resetting privacy authorization), so the value is kept
/// well above what any of those take on a responsive device.
enum XCTestQueryTimeout {
    /// Runner environment variable (delivered through the xctestrun) that overrides the value.
    /// A number of seconds in `allowedRange`, or `off` / `0` to keep XCTest's own default.
    static let environmentKey = "CTRL_PROXY_IOS_QUERY_TIMEOUT"

    /// Default per-attempt timeout in seconds. One query against a suspended app then fails in
    /// about 9 s (3 x (2 s + 1 s)), inside the 10 s hierarchy response bound (`XCUIQueryBound`), and
    /// a coordinate tap (3 event-dispatch attempts, each resolving the app) in about 27 s instead of
    /// about 280 s. An app whose main thread stalls for up to about 7 s is still answered by a
    /// retry. The accessibility snapshot request has its own XCTest timeout and is not affected.
    static let defaultSeconds: TimeInterval = 2

    /// Values outside this range are clamped to it.
    static let allowedRange: ClosedRange<TimeInterval> = 1 ... 60

    enum Selection: Equatable {
        case apply(TimeInterval)
        case keepXCTestDefault
    }

    enum Outcome: Equatable {
        case applied(previous: TimeInterval?, current: TimeInterval)
        case keptXCTestDefault
        case unavailable
    }

    /// The timeout to apply for the runner environment value `raw`.
    /// Unset, empty or unparseable values select `defaultSeconds`.
    static func selection(environmentValue raw: String?) -> Selection {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if trimmed == "off" { return .keepXCTestDefault }
        guard let seconds = TimeInterval(trimmed), seconds.isFinite else {
            return .apply(defaultSeconds)
        }
        if seconds <= 0 { return .keepXCTestDefault }
        return .apply(min(max(seconds, allowedRange.lowerBound), allowedRange.upperBound))
    }

    /// Applies the selected timeout through `control`. Call once at runner startup, on the main
    /// thread, before the first live query.
    @discardableResult
    static func apply(
        environmentValue: String?,
        control: any XCTestQueryTimeoutControlling,
        log: (String) -> Void = { _ in }
    )
        -> Outcome
    {
        switch selection(environmentValue: environmentValue) {
        case .keepXCTestDefault:
            log("XCTest query timeout left at XCTest's default (\(environmentKey)=\(environmentValue ?? ""))")
            return .keptXCTestDefault
        case let .apply(seconds):
            let previous = control.currentTimeout()
            guard control.setTimeout(seconds) else {
                log("XCTest query timeout unavailable on this SDK; live queries keep XCTest's default")
                return .unavailable
            }
            log("XCTest query timeout set to \(seconds)s (was \(previous.map { "\($0)s" } ?? "unknown"))")
            return .applied(previous: previous, current: seconds)
        }
    }
}

/// `XCTestQueryTimeoutControlling` backed by XCUIAutomation's exported accessors, looked up at
/// runtime. `lookup` is injectable so tests can simulate an SDK that lacks the symbols.
struct DlsymXCTestQueryTimeoutControl: XCTestQueryTimeoutControlling {
    static let getterSymbol = "_XCTXPCRequestTimeout"
    static let setterSymbol = "_XCTSetXPCRequestTimeout"

    private typealias Getter = @convention(c) () -> Double
    private typealias Setter = @convention(c) (Double) -> Void

    private let lookup: (String) -> UnsafeMutableRawPointer?

    init(lookup: @escaping (String) -> UnsafeMutableRawPointer? = Self.defaultLookup) {
        self.lookup = lookup
    }

    /// Searches every image loaded in the runner (`RTLD_DEFAULT`).
    static func defaultLookup(_ name: String) -> UnsafeMutableRawPointer? {
        dlsym(UnsafeMutableRawPointer(bitPattern: -2), name)
    }

    func currentTimeout() -> TimeInterval? {
        guard let address = lookup(Self.getterSymbol) else { return nil }
        return unsafeBitCast(address, to: Getter.self)()
    }

    func setTimeout(_ seconds: TimeInterval) -> Bool {
        guard let address = lookup(Self.setterSymbol) else { return false }
        unsafeBitCast(address, to: Setter.self)(seconds)
        return true
    }
}

#if canImport(XCTest) && os(iOS)
    extension XCTestQueryTimeout {
        /// Applies the configured timeout to the running XCTest process and logs the outcome.
        @MainActor
        static func applyToRunner(environment: [String: String] = ProcessInfo.processInfo.environment) {
            let logger = Logger(subsystem: "dev.jasonpearson.automobile", category: "XCTestQueryTimeout")
            let outcome = apply(
                environmentValue: environment[environmentKey],
                control: DlsymXCTestQueryTimeoutControl(),
                log: { message in logger.debug("\(message, privacy: .public)") }
            )
            print("[CtrlProxy] XCTest query timeout: \(outcome)")
        }
    }
#endif
