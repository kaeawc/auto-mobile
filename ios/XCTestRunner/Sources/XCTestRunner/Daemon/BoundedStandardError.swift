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
    private let data = OSAllocatedUnfairLock(initialState: (bytes: Data(), capped: false))
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
            Self.capturedText(from: current.bytes)
        }
    }

    private func append(_ incoming: Data) {
        guard !incoming.isEmpty else { return }
        data.withLock { current in
            guard !current.capped else { return }
            let remaining = Self.maximumBytes - current.bytes.count
            current.bytes.append(incoming.prefix(remaining))
            if current.bytes.count == Self.maximumBytes {
                current.capped = true
                current.bytes = Self.cappedData(current.bytes)
            }
        }
    }

    /// Keep a complete UTF-8 prefix at the byte cap, including when a scalar spans pipe reads.
    static func cappedData(_ incoming: Data) -> Data {
        var captured = Data(incoming.prefix(maximumBytes))
        guard captured.count == maximumBytes else { return captured }
        var scalarStart = captured.count - 1
        while scalarStart > 0, captured[scalarStart] & 0xC0 == 0x80 {
            scalarStart -= 1
        }
        let lead = captured[scalarStart]
        let scalarBytes = lead & 0xE0 == 0xC0 ? 2 : lead & 0xF0 == 0xE0 ? 3 : lead & 0xF8 == 0xF0 ? 4 : 1
        if captured.count - scalarStart < scalarBytes {
            captured.removeSubrange(scalarStart...)
        }
        return captured
    }

    static func capturedText(from captured: Data) -> String? {
        let captured = cappedData(captured)
        guard !captured.isEmpty else { return nil }
        return String(data: captured, encoding: .utf8)
    }

    deinit {
        pipe.fileHandleForReading.readabilityHandler = nil
    }
}
