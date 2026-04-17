import Foundation

#if !canImport(os)
/// No-op `Logger` shim for non-Apple Swift toolchains where `os.Logger`
/// isn't available. Lets the top-level `Logger(...)` declarations in
/// `GesturePerformer.swift` / `CommandHandler.swift` and every
/// `.debug(...)` / `.error(...)` call site compile without per-call
/// `#if canImport(os)` guards. All logging on non-Apple platforms is a
/// no-op — we don't run the CtrlProxy runtime there, only typecheck it.
public enum OSLogPrivacy {
    case `public`
    case `private`
}

public struct OSLogInterpolation: StringInterpolationProtocol {
    public init(literalCapacity _: Int, interpolationCount _: Int) {}
    public mutating func appendLiteral(_: String) {}
    public mutating func appendInterpolation<T>(_: T, privacy _: OSLogPrivacy) {}
    public mutating func appendInterpolation<T>(_: T) {}
}

public struct OSLogMessage: ExpressibleByStringLiteral, ExpressibleByStringInterpolation {
    public init(stringLiteral _: String) {}
    public init(stringInterpolation _: OSLogInterpolation) {}
}

public struct Logger {
    public init(subsystem _: String, category _: String) {}
    public func debug(_: OSLogMessage) {}
    public func error(_: OSLogMessage) {}
}
#endif

/// Shared subsystem identifier for all CtrlProxy `os.Logger` output.
///
/// Log-level contract across the CtrlProxy Swift sources:
///   - `.debug`  — normal success path trace. Not persisted to the unified
///                 log store; only visible when actively streaming.
///   - `.error`  — failures only. Persisted, rare, high-signal.
///
/// Do NOT promote success-path logs to `.info` — `Logger.info` is persisted
/// and every text input would leave durable records. Enable streaming during
/// a debug session with:
///
///     xcrun simctl spawn booted log stream --level=debug \
///       --predicate 'subsystem == "dev.kaeawc.automobile.ctrlproxy"'
///
/// Defined as a top-level `let` so callers can write
/// `Logger(subsystem: ctrlProxyLogSubsystem, category: "…")` without
/// pulling in a full enum namespace. Rename-safe: a single constant for
/// the whole package means filters in dashboards or log-show commands
/// can't drift across files.
let ctrlProxyLogSubsystem = "dev.kaeawc.automobile.ctrlproxy"
