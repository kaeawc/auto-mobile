import os

/// One allocator is shared by every recorder of one AutoMobileNetwork so sequence numbers are unique per app process.
final class NetworkSequenceAllocator: Sendable {
    private let lock = OSAllocatedUnfairLock<UInt64>(initialState: 0)

    func next() -> UInt64 {
        lock.withLock { sequenceNumber in
            sequenceNumber += 1
            return sequenceNumber
        }
    }
}
