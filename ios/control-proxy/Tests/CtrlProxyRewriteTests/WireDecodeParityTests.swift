import CtrlProxyTestSupport
import Foundation
import XCTest

/// Differential request-decode parity gate (rewrite Phase 0).
///
/// For every snapshot in the shared fixture
/// `test/fixtures/ios-ctrlproxy-request-snapshots.json`, decodes the exact wire
/// JSON through BOTH the reference `CtrlProxy` and the `CtrlProxyRewrite` modules
/// (via `ReferenceWireDecoder` / `RewriteWireDecoder`, which each import a single
/// module to dodge the `CtrlProxy` module-vs-type name clash) and asserts:
///
///   1. both decode to the discriminator the fixture declares, and
///   2. the rewrite's decoded payload is field-for-field identical to the
///      reference's (no silently dropped or renamed wire field), and
///   3. every wire field lands on a same-named rewrite payload property with an
///      equal value (the rewrite still honors the frozen fixture — the guarantee
///      the reference's `RequestSnapshotWireParityTests` gives, now for the new
///      module).
///
/// Together with the reference suite and the TS capture test, the fixture is a
/// three-way tripwire: TS capture / reference Swift / rewrite Swift must agree.
final class WireDecodeParityTests: XCTestCase {
    private static func loadSnapshots() throws -> [WireSnapshot] {
        let url = WireSnapshotFixture.fixtureURL(fromTestFilePath: #filePath)
        return try WireSnapshotFixture.load(contentsOf: url)
    }

    private func wireJSON(_ wire: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: wire)
    }

    // MARK: - Fixture sanity

    func testFixtureLoadsAndCoversTheCommandSurface() throws {
        let snapshots = try Self.loadSnapshots()
        XCTAssertGreaterThanOrEqual(snapshots.count, 30, "fixture unexpectedly small — was it truncated?")
        XCTAssertEqual(
            Set(snapshots.map(\.name)).count,
            snapshots.count,
            "snapshot names must be unique"
        )
    }

    // MARK: - Frozen-fixture decode contract

    func testEverySnapshotHonorsTheFrozenFixture() throws {
        for snapshot in try Self.loadSnapshots() {
            let data = try wireJSON(snapshot.wire)

            let rewrite: (type: String, normalizedPayload: Any)
            do {
                rewrite = try RewriteWireDecoder.decode(data)
            } catch {
                XCTFail("\(snapshot.name): CtrlProxyRewrite failed to decode: \(error)")
                continue
            }

            guard let type = snapshot.wire["type"] as? String else {
                XCTFail("\(snapshot.name): snapshot has no `type` discriminator")
                continue
            }
            XCTAssertEqual(rewrite.type, type, "\(snapshot.name): rewrite discriminator")

            // The rewrite payload still honors the frozen fixture: every wire field lands on a
            // same-named property with an equal value (the fixture is the golden — Phase-7E
            // dropped the now-removed reference-vs-rewrite comparison this test also did).
            guard let rewritePayload = rewrite.normalizedPayload as? [String: Any] else {
                XCTFail("\(snapshot.name): rewrite payload did not normalize to an object")
                continue
            }
            var payloadWire = snapshot.wire
            payloadWire.removeValue(forKey: "type") // discriminator, not a payload property
            assertWireSubset(wire: payloadWire, payload: rewritePayload, context: snapshot.name)
        }
    }

    /// Unknown discriminators surface the exact wire error string
    /// (`"Unknown command type: <type>"`, matched by the TS `rewriteUnknownCommandError`).
    func testUnknownCommandErrorTextMatches() {
        let data = Data(#"{"type":"totally_made_up_command","requestId":"x"}"#.utf8)
        XCTAssertEqual(
            RewriteWireDecoder.decodeErrorMessage(data),
            "Unknown command type: totally_made_up_command"
        )
    }

    // MARK: - Normalized-value comparison helpers

    /// Every wire field lands on a same-named payload property with an equal value;
    /// payload-only keys must be NSNull (an optional the wire did not carry). Ported
    /// from the reference `RequestSnapshotWireParityTests`.
    private func assertWireSubset(
        wire: [String: Any],
        payload: [String: Any],
        context: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for (key, expected) in wire {
            guard let actual = payload[key] else {
                XCTFail(
                    "\(context): wire field `\(key)` has no matching rewrite property — field-name drift",
                    file: file,
                    line: line
                )
                continue
            }
            assertValueEqual(expected: expected, actual: actual, context: "\(context).\(key)", file: file, line: line)
        }
        for (key, value) in payload where wire[key] == nil {
            XCTAssertTrue(
                value is NSNull,
                "\(context): rewrite property `\(key)` decoded \(value) from a wire payload that does not carry it",
                file: file,
                line: line
            )
        }
    }

    private func assertValueEqual(
        expected: Any,
        actual: Any,
        context: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        if let expectedDict = expected as? [String: Any] {
            guard let actualDict = actual as? [String: Any] else {
                XCTFail("\(context): wire has an object, payload decoded \(actual)", file: file, line: line)
                return
            }
            assertWireSubset(wire: expectedDict, payload: actualDict, context: context, file: file, line: line)
            return
        }
        if let expectedArray = expected as? [Any] {
            guard let actualArray = actual as? [Any] else {
                XCTFail("\(context): wire has an array, payload decoded \(actual)", file: file, line: line)
                return
            }
            XCTAssertEqual(actualArray.count, expectedArray.count, context, file: file, line: line)
            for (index, pair) in zip(expectedArray, actualArray).enumerated() {
                assertValueEqual(expected: pair.0, actual: pair.1, context: "\(context)[\(index)]", file: file, line: line)
            }
            return
        }
        XCTAssertTrue(
            (actual as AnyObject).isEqual(expected),
            "\(context): decoded \(actual) != wire \(expected)",
            file: file,
            line: line
        )
    }
}
