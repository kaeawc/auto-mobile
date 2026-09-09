import Foundation
import os

/// Global buffer for SDK events received via HTTP POST, shared across all
/// connections and drained by `GET /sdk-events`.
///
/// Rewrite archetype: a genuinely-`Sendable` lock-confined collection. Where the
/// reference used `NSLock` + `@unchecked Sendable`, this holds an
/// `OSAllocatedUnfairLock<[Data]>` (itself `Sendable`), so the class is `Sendable`
/// with no escape hatch. Behavior is identical: a 500-event ring that keeps the
/// most-recent events.
public final class SdkEventBuffer: Sendable {
    public static let shared = SdkEventBuffer()

    private static let maxEvents = 500

    private let synchronizedBuffer = OSAllocatedUnfairLock<[Data]>(initialState: {
        var buffer: [Data] = []
        buffer.reserveCapacity(SdkEventBuffer.maxEvents)
        return buffer
    }())

    private init() {}

    public func append(_ data: Data) {
        synchronizedBuffer.withLock {
            $0.append(data, enforcingMaximumSize: Self.maxEvents)
        }
    }

    public func drain() -> [Data] {
        synchronizedBuffer.withLock { buffer in
            let events = buffer
            buffer.removeAll(keepingCapacity: true)
            return events
        }
    }
}
