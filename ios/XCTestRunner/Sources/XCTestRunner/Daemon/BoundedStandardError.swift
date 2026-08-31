import Foundation
import os

/// Bounded stderr collector for a launched daemon subprocess: caps captured stderr at 4 KiB so a
/// chatty failing process can't grow the buffer without limit. The pipe's `readabilityHandler` fires
/// on an arbitrary GCD queue, so the captured bytes are **lock-confined** (`OSAllocatedUnfairLock`,
/// replacing the reference's `NSLock`).
///
/// `@unchecked Sendable` (not clean-Sendable) only because the other stored property is a `Pipe`,
/// which Foundation does not mark `Sendable`; it is an immutable reference whose file handle is
/// touched solely at init (installing the handler) and in `text()` (removing it, then draining) —
/// never concurrently with itself. All mutable state lives behind the lock.
final class BoundedStandardError: @unchecked Sendable {
    private static let maximumBytes = 4096
    private let data = OSAllocatedUnfairLock<Data>(initialState: Data())
    let pipe = Pipe()

    init() {
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.append(handle.availableData)
        }
    }

    func text() -> String? {
        pipe.fileHandleForReading.readabilityHandler = nil
        append(pipe.fileHandleForReading.readDataToEndOfFile())
        return data.withLock { current in
            guard !current.isEmpty else { return nil }
            return String(data: current, encoding: .utf8)
        }
    }

    private func append(_ incoming: Data) {
        guard !incoming.isEmpty else { return }
        data.withLock { current in
            let remaining = Self.maximumBytes - current.count
            guard remaining > 0 else { return }
            current.append(incoming.prefix(remaining))
        }
    }

    deinit {
        pipe.fileHandleForReading.readabilityHandler = nil
    }
}
