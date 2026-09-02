import Foundation

/// Recycles the large per-frame heap slabs the raw video path copies pixel data into,
/// so a steady capture reuses a couple of buffers instead of malloc/free-ing (and
/// page-faulting/zero-filling) a fresh multi-megabyte BGRA slab every frame. Only the
/// *allocation* is pooled — copying off the locked `CVPixelBuffer` is unavoidable, so
/// this trims allocation churn and first-touch page faults, not the memcpy itself.
///
/// A vended buffer returns to the pool automatically via the `Data`'s custom
/// deallocator, which fires when the last reference is released — i.e. after a dropped
/// frame is replaced (on the capture queue) or after the output worker finishes writing
/// it (on the output queue). So a buffer is only reused once it is genuinely no longer
/// in flight; the single-slot video queue means at most two slabs cycle in steady state.
///
/// `@unchecked Sendable`: the free list is guarded by `lock`, and the deallocator (which
/// calls `giveBack` from either queue) only ever takes `lock` — never a `FrameWriter`
/// lock — so there is no lock-ordering cycle with the writer's `stateLock`.
public final class FrameBufferPool: @unchecked Sendable {
    private struct Slab {
        let pointer: UnsafeMutableRawPointer
        let capacity: Int
    }

    private let lock = NSLock()
    private var free: [Slab] = []
    /// Upper bound on retained free buffers. The raw video queue keeps at most one
    /// pending frame, so a small handful covers "one draining + one filling" with slack.
    private let maxPooledBuffers: Int

    public init(maxPooledBuffers: Int = 3) {
        precondition(maxPooledBuffers > 0)
        self.maxPooledBuffers = maxPooledBuffers
    }

    deinit {
        for slab in free {
            slab.pointer.deallocate()
        }
    }

    /// A `Data` of exactly `count` bytes copied from `source`, backed by a pooled (or
    /// freshly allocated) slab that returns to this pool when the `Data` is released.
    /// A non-positive `count` yields an empty `Data` (nothing to pool).
    public func makeData(copyingFrom source: UnsafeRawPointer, count: Int) -> Data {
        guard count > 0 else { return Data() }
        let slab = takeSlab(minimumCapacity: count)
        slab.pointer.copyMemory(from: source, byteCount: count)
        return Data(
            bytesNoCopy: slab.pointer,
            count: count,
            deallocator: .custom { [self] _, _ in giveBack(slab) }
        )
    }

    /// Reuse the first free slab that fits, or allocate a fresh one sized exactly to the
    /// request. (First-fit rather than best-fit: the free list is capped at a handful,
    /// and a steady capture's buffers are all the same frame size anyway.)
    private func takeSlab(minimumCapacity: Int) -> Slab {
        lock.lock()
        if let index = free.firstIndex(where: { $0.capacity >= minimumCapacity }) {
            let slab = free.remove(at: index)
            lock.unlock()
            return slab
        }
        lock.unlock()
        return Slab(
            pointer: .allocate(byteCount: minimumCapacity, alignment: 16),
            capacity: minimumCapacity
        )
    }

    private func giveBack(_ slab: Slab) {
        lock.lock()
        if free.count < maxPooledBuffers {
            free.append(slab)
            lock.unlock()
        } else {
            lock.unlock()
            slab.pointer.deallocate()
        }
    }
}
