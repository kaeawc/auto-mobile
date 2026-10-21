import Foundation
import os

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
