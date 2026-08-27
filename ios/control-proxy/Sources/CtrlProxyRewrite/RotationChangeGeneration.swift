import Foundation
import os

/// Tracks device-orientation notifications independently of capture endpoint samples.
///
/// The counter intentionally advances for every notification: even an A→B→A cycle must
/// make in-flight hierarchy and screenshot geometry untrusted, though their endpoint
/// rotations match.
///
/// Rewrite archetype: **lock-confined `Sendable`**. The reference guarded a
/// `var generation` with an `NSLock` on a non-`Sendable` class; the monotonic counter
/// lives in an `OSAllocatedUnfairLock<UInt64>` here, so the type is genuinely `Sendable`
/// (no `@unchecked`) and can be held by the process-lifetime `RotationChangeMonitor`.
final class RotationChangeGeneration: Sendable {
    private let generation = OSAllocatedUnfairLock<UInt64>(initialState: 0)

    func captureSample(rotation: Int?) -> RotationCaptureSample {
        generation.withLock { RotationCaptureSample(rotation: rotation, generation: $0) }
    }

    func recordOrientationChange() {
        generation.withLock { $0 &+= 1 }
    }
}
