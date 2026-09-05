import Foundation
import XCTest

/// Wire-contract tests for the performance wire models (`PerformanceSnapshot` /
/// `PerformanceUpdateResponse`), driven module-agnostically via `RewritePerformanceWire`.
///
/// Phase-7E re-anchor: was differential (byte/object-diff of reference vs rewrite encodings).
/// With the reference retired it is reference-free — it pins the Codable **key-omission
/// contract** (nil optionals are omitted, non-nil are emitted) via key counts, plus the update
/// envelope shape. The specs still cover every-field / all-nil / mixed / escaping / ProMotion.
final class PerformanceWireParityTests: XCTestCase {
    /// Every non-nil field is emitted and every nil field is omitted (the Codable contract).
    func testSnapshotOmitsNilFieldsOnly() throws {
        // `full`: all 10 fields populated → all 10 keys present.
        let full = JSONGolden.object(try RewritePerformanceWire.encodeSnapshot(PerfSnapshotSpecs.full))
        XCTAssertEqual(full?.count, 10, "fully-populated snapshot must emit all 10 fields")
        XCTAssertEqual((full?["timestamp"] as? NSNumber)?.int64Value, PerfSnapshotSpecs.full.timestamp)

        // `allNil`: only the required `timestamp` → exactly 1 key.
        let allNil = JSONGolden.object(try RewritePerformanceWire.encodeSnapshot(PerfSnapshotSpecs.allNil))
        XCTAssertEqual(allNil?.count, 1, "all-optionals-nil snapshot must emit only `timestamp`")
        XCTAssertEqual((allNil?["timestamp"] as? NSNumber)?.int64Value, PerfSnapshotSpecs.allNil.timestamp)

        // Every spec encodes to a valid object carrying its timestamp.
        for spec in PerfSnapshotSpecs.all {
            let object = JSONGolden.object(try RewritePerformanceWire.encodeSnapshot(spec))
            XCTAssertEqual((object?["timestamp"] as? NSNumber)?.int64Value, spec.timestamp,
                           "snapshot timestamp for spec timestamp=\(spec.timestamp)")
        }
    }

    /// The update envelope wraps the snapshot under `performanceData` with a
    /// `performance_update` discriminator (top-level `timestamp` is a live `Date()`).
    func testPerformanceUpdateEnvelopeShape() throws {
        for spec in PerfSnapshotSpecs.all {
            let object = JSONGolden.object(try RewritePerformanceWire.encodeUpdate(spec), strippingTimestamp: true)
            XCTAssertEqual(object?["type"] as? String, "performance_update",
                           "type for spec timestamp=\(spec.timestamp)")
            XCTAssertNotNil(object?["performanceData"] as? [String: Any],
                            "performanceData must be an object for spec timestamp=\(spec.timestamp)")
        }
    }
}
