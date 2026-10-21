import Foundation
import os

final class RotationChangeGeneration: Sendable {
    private let generation = OSAllocatedUnfairLock<UInt64>(initialState: 0)

    func captureSample(rotation: Int?) -> RotationCaptureSample {
        generation.withLock { RotationCaptureSample(rotation: rotation, generation: $0) }
    }

    func recordOrientationChange() {
        generation.withLock { $0 &+= 1 }
    }
}
