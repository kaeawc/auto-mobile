import Foundation

/// Internal mutable timing node used while a perf call-tree is being built up.
///
/// Confined to a single `PerfProvider.PerfCallScope` (one logical operation): it is created,
/// linked into its parent, and stamped with an end time all within one task's serial
/// execution, so it never crosses an isolation boundary on its own. The owning scope carries
/// the `@unchecked Sendable` justification. A completed root is converted to the immutable,
/// `Sendable` `PerfTiming` (`toTiming`) *before* it enters the shared pool, so a mutable node
/// is never stored behind the pool's lock.
final class MutablePerfEntry {
    let name: String
    let startTime: Int64
    var endTime: Int64?
    var children: [MutablePerfEntry] = []
    let isParallel: Bool

    init(name: String, startTime: Int64, isParallel: Bool = false) {
        self.name = name
        self.startTime = startTime
        self.isParallel = isParallel
    }

    /// Convert to the immutable wire node. An entry still open (no `endTime`) has its duration
    /// run to "now" from the injected clock, matching the reference. `isParallel` is deliberately
    /// dropped — it never reached the wire (`PerfTiming` has no such field).
    func toTiming(timeProvider: any TimeProvider) -> PerfTiming {
        let duration = (endTime ?? timeProvider.currentTimeMillis()) - startTime
        let childTimings: [PerfTiming]? = children.isEmpty
            ? nil
            : children.map { $0.toTiming(timeProvider: timeProvider) }
        return PerfTiming(name: name, durationMs: duration, children: childTimings)
    }
}
