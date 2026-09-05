import Foundation

/// Keeps a process-lifetime rotation epoch separate from synchronous XCUI capture work.
///
/// `Sendable` (compiler-checked, no `@unchecked`): both stored properties are immutable
/// `let`s of `Sendable` types, so the single `DeviceRotation.changeMonitor` global is
/// concurrency-safe. `capture`/`captureSample` stay synchronous and take a
/// (non-`Sendable`) sampler and operation by parameter, so a `@MainActor` caller can wrap
/// its XCUITest work without an isolation hop.
final class RotationChangeMonitor: Sendable {
    private let changeGeneration = RotationChangeGeneration()
    private let signal: any RotationChangeSignaling

    init(signal: any RotationChangeSignaling) {
        self.signal = signal
        signal.startObserving { [weak self] in
            self?.changeGeneration.recordOrientationChange()
        }
    }

    func captureSample(using sampler: RotationSampling) -> RotationCaptureSample {
        changeGeneration.captureSample(rotation: sampler.currentRotation())
    }

    func capture<T>(
        using sampler: RotationSampling,
        _ operation: () throws -> T
    ) rethrows -> (value: T, rotation: Int?) {
        let beforeCapture = captureSample(using: sampler)
        let value = try operation()
        let afterCapture = captureSample(using: sampler)
        return (
            value,
            RotationCaptureSample.stableRotation(between: beforeCapture, and: afterCapture)
        )
    }
}
