import Foundation
import XCTest

// Differential parity for the performance wire models. Imports NEITHER module: the
// per-module drivers (`ReferencePerformanceWire` / `RewritePerformanceWire`) produce
// encoded bytes and this suite diffs them, so a divergence in either module's
// `PerformanceSnapshot` / `PerformanceUpdateResponse` encoding fails here.
final class PerformanceWireParityTests: XCTestCase {
    /// `PerformanceSnapshot` carries no live clock, so its bytes must match exactly.
    func testSnapshotEncodesIdenticallyAcrossModules() throws {
        for spec in PerfSnapshotSpecs.all {
            XCTAssertEqual(
                try ReferencePerformanceWire.encodeSnapshot(spec),
                try RewritePerformanceWire.encodeSnapshot(spec),
                "PerformanceSnapshot bytes diverge for spec timestamp=\(spec.timestamp)"
            )
        }
    }

    /// `PerformanceUpdateResponse` stamps its top-level `timestamp` from a live `Date()`
    /// at init, so compare the JSON objects with that key stripped (the nested
    /// `performanceData.timestamp` comes from the spec and must still match).
    func testPerformanceUpdateEncodesIdenticallyAcrossModules() throws {
        for spec in PerfSnapshotSpecs.all {
            let reference = normalized(try ReferencePerformanceWire.encodeUpdate(spec))
            let rewrite = normalized(try RewritePerformanceWire.encodeUpdate(spec))
            XCTAssertEqual(
                reference, rewrite,
                "PerformanceUpdateResponse (timestamp-stripped) diverges for spec timestamp=\(spec.timestamp)"
            )
            XCTAssertEqual(rewrite?["type"] as? String, "performance_update")
            XCTAssertNotNil(rewrite?["performanceData"], "performanceData must survive normalization")
        }
    }

    /// Parse JSON to a dictionary with the live-`Date()`-stamped top-level `timestamp`
    /// removed (mirrors the strip in `ResponseModelParityTests`).
    private func normalized(_ data: Data, file: StaticString = #filePath, line: UInt = #line) -> NSDictionary? {
        guard var dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            XCTFail("performance update was not a JSON object", file: file, line: line)
            return nil
        }
        dict.removeValue(forKey: "timestamp")
        return dict as NSDictionary
    }
}
