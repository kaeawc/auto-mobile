import Foundation

/// Bounded polling for physical-device readiness on capture startup.
///
/// After `CMIOSystem.enableScreenCaptureDevices()` a freshly-connected USB iOS
/// device needs a brief moment to register with AVFoundation before it appears
/// in a `DiscoverySession`. The helper previously paid an unconditional
/// `Thread.sleep(forTimeInterval: 0.5)` for this on every physical-device
/// `--list-devices` / `--capture` start (issue #4737). This polls the same
/// deadline instead and returns as soon as the device enumerates, falling back
/// to the deadline if it never appears.
///
/// The clock and sleep are injected so the loop can be unit-tested with fakes;
/// production callers use the wall clock and `Thread.sleep`.
public enum DeviceReadinessPolling {
    /// Polls `isReady` on a short interval until it returns `true` or `deadline`
    /// seconds elapse.
    ///
    /// - Parameters:
    ///   - deadline: overall budget in seconds. Matches the historical fixed
    ///     sleep so the worst case is unchanged.
    ///   - interval: gap between probes in seconds.
    ///   - now: monotonic-ish clock reading in seconds (injected for tests).
    ///   - sleep: blocks for the given number of seconds (injected for tests).
    ///   - isReady: probe that reports whether the device has enumerated.
    /// - Returns: `true` if `isReady` succeeded before the deadline, otherwise
    ///   `false` (the deadline lapsed).
    @discardableResult
    public static func waitUntilReady(
        deadline: TimeInterval = 0.5,
        interval: TimeInterval = 0.05,
        now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
        isReady: () -> Bool
    ) -> Bool {
        let start = now()
        if isReady() {
            return true
        }
        while true {
            let remaining = deadline - (now() - start)
            if remaining <= 0 {
                return false
            }
            sleep(min(interval, remaining))
            if isReady() {
                return true
            }
        }
    }
}
