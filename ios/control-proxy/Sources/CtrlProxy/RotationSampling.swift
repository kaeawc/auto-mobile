import Foundation

/// Reads the current interface rotation as an Android-compatible `0...3`, or `nil` when
/// the platform cannot identify one.
///
/// Not `Sendable`: the sampler is only ever passed as a synchronous method parameter to
/// `RotationChangeMonitor` (never stored), so it crosses no isolation boundary. Keeping
/// the constraint off lets a test fake carry mutable state without `@unchecked`.
protocol RotationSampling {
    func currentRotation() -> Int?
}
