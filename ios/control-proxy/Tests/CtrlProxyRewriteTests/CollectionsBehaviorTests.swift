@testable import CtrlProxyRewrite
import Foundation
import XCTest

/// Behavioral tests for the rewrite's lock-confined collections and the max-size
/// helper. These are internal implementation types with no wire contract, so they
/// are verified against their documented semantics (not differentially against the
/// reference): a 500-event most-recent ring, snapshot-safe registry iteration, and
/// front-truncation.
final class CollectionsBehaviorTests: XCTestCase {
    // MARK: - RangeReplaceableCollection max-size helper

    func testRemovePrefixEnforcingMaximumSize() {
        var a = Array(0 ..< 10)
        XCTAssertEqual(a.removePrefix(enforcingMaximumSize: 4), 6)
        XCTAssertEqual(a, [6, 7, 8, 9])
        // Already within bounds → no-op, returns 0.
        XCTAssertEqual(a.removePrefix(enforcingMaximumSize: 4), 0)
        XCTAssertEqual(a, [6, 7, 8, 9])
        XCTAssertEqual(a.removePrefix(enforcingMaximumSize: 0), 4)
        XCTAssertEqual(a, [])
    }

    func testAppendEnforcingMaximumSizeKeepsMostRecent() {
        var a: [Int] = []
        for i in 0 ..< 6 {
            a.append(i, enforcingMaximumSize: 3)
        }
        XCTAssertEqual(a, [3, 4, 5])
    }

    // MARK: - SdkEventBuffer (500-event most-recent ring)

    func testSdkEventBufferKeepsMostRecent500() {
        let buffer = SdkEventBuffer.shared
        _ = buffer.drain() // clear any prior state

        func event(_ i: Int) -> Data { Data([UInt8(i >> 8), UInt8(i & 0xFF)]) }
        for i in 0 ..< 600 {
            buffer.append(event(i))
        }

        let drained = buffer.drain()
        XCTAssertEqual(drained.count, 500)
        XCTAssertEqual(drained.first, event(100), "oldest surviving event should be index 100")
        XCTAssertEqual(drained.last, event(599), "newest event should be index 599")

        // Drain empties the buffer.
        XCTAssertTrue(buffer.drain().isEmpty)
    }

    func testSdkEventBufferPreservesOrderUnderCap() {
        let buffer = SdkEventBuffer.shared
        _ = buffer.drain()
        for i in 0 ..< 3 {
            buffer.append(Data([UInt8(i)]))
        }
        XCTAssertEqual(buffer.drain(), [Data([0]), Data([1]), Data([2])])
    }

    // MARK: - ConnectionRegistry

    func testConnectionRegistryOperations() {
        let registry = ConnectionRegistry<Int>()
        XCTAssertTrue(registry.isEmpty)
        XCTAssertEqual(registry.count, 0)

        registry.set(10, forId: 1)
        registry.set(20, forId: 2)
        registry.set(30, forId: 3)
        XCTAssertEqual(registry.count, 3)
        XCTAssertFalse(registry.isEmpty)
        XCTAssertEqual(registry.value(forId: 2), 20)
        XCTAssertNil(registry.value(forId: 99))
        XCTAssertEqual(registry.values().sorted(), [10, 20, 30])

        // Overwrite in place.
        registry.set(25, forId: 2)
        XCTAssertEqual(registry.value(forId: 2), 25)
        XCTAssertEqual(registry.count, 3)

        registry.removeValue(forId: 2)
        XCTAssertNil(registry.value(forId: 2))
        XCTAssertEqual(registry.count, 2)

        let removed = registry.removeAll()
        XCTAssertEqual(removed.sorted(), [10, 30])
        XCTAssertTrue(registry.isEmpty)
        XCTAssertEqual(registry.removeAll(), [])
    }

    /// A `values()` snapshot must be safe to iterate while the registry is mutated
    /// (the issue #3611 invariant) — the snapshot is an independent copy.
    func testConnectionRegistrySnapshotIsIndependent() {
        let registry = ConnectionRegistry<Int>()
        registry.set(1, forId: 1)
        registry.set(2, forId: 2)
        let snapshot = registry.values()
        _ = registry.removeAll()
        XCTAssertEqual(snapshot.sorted(), [1, 2], "snapshot must not reflect later mutation")
    }
}
