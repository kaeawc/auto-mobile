import Foundation

/// The orientation and its monotonic device-orientation-change generation at a
/// capture boundary. Equal endpoint orientations with different generations
/// represent an A→B→A transition (so in-flight geometry must be treated as
/// untrusted). Ported verbatim; `Sendable` POD.
struct RotationCaptureSample: Equatable, Sendable {
    let rotation: Int?
    let generation: UInt64

    static func stableRotation(
        between before: RotationCaptureSample,
        and after: RotationCaptureSample
    ) -> Int? {
        before.rotation == after.rotation && before.generation == after.generation
            ? after.rotation
            : nil
    }
}
