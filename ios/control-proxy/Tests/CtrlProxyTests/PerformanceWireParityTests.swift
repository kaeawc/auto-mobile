import Foundation
import XCTest

final class PerformanceWireParityTests: XCTestCase {
    /// Every non-nil field is emitted and every nil field is omitted (the Codable contract).
    func testSnapshotOmitsNilFieldsOnly() throws {
        // `full`: all 10 fields populated → all 10 keys present.
        let full = try JSONGolden.object(PerformanceWire.encodeSnapshot(PerfSnapshotSpecs.full))
        XCTAssertEqual(full?.count, 10, "fully-populated snapshot must emit all 10 fields")
        XCTAssertEqual((full?["timestamp"] as? NSNumber)?.int64Value, PerfSnapshotSpecs.full.timestamp)

        // `allNil`: only the required `timestamp` → exactly 1 key.
        let allNil = try JSONGolden.object(PerformanceWire.encodeSnapshot(PerfSnapshotSpecs.allNil))
        XCTAssertEqual(allNil?.count, 1, "all-optionals-nil snapshot must emit only `timestamp`")
        XCTAssertEqual((allNil?["timestamp"] as? NSNumber)?.int64Value, PerfSnapshotSpecs.allNil.timestamp)

        // Every spec encodes to a valid object carrying its timestamp.
        for spec in PerfSnapshotSpecs.all {
            let object = try JSONGolden.object(PerformanceWire.encodeSnapshot(spec))
            XCTAssertEqual(
                (object?["timestamp"] as? NSNumber)?.int64Value,
                spec.timestamp,
                "snapshot timestamp for spec timestamp=\(spec.timestamp)"
            )
        }
    }

    /// The update envelope wraps the snapshot under `performanceData` with a
    /// `performance_update` discriminator (top-level `timestamp` is a live `Date()`).
    func testPerformanceUpdateEnvelopeShape() throws {
        for spec in PerfSnapshotSpecs.all {
            let object = try JSONGolden.object(PerformanceWire.encodeUpdate(spec), strippingTimestamp: true)
            XCTAssertEqual(
                object?["type"] as? String,
                "performance_update",
                "type for spec timestamp=\(spec.timestamp)"
            )
            XCTAssertNotNil(
                object?["performanceData"] as? [String: Any],
                "performanceData must be an object for spec timestamp=\(spec.timestamp)"
            )
        }
    }
}
