import Foundation

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
