@testable import CtrlProxy
import CtrlProxyTestSupport
import Foundation
import XCTest

/// Request decoding is checked against every captured wire snapshot. Each
/// request discriminator and payload field must decode to the expected value,
/// and the decoded payload must not contain unexpected non-null fields.
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

            let decoded: (type: String, normalizedPayload: Any)
            do {
                decoded = try WireDecoder.decode(data)
            } catch {
                XCTFail("\(snapshot.name): CtrlProxy failed to decode: \(error)")
                continue
            }

            guard let type = snapshot.wire["type"] as? String else {
                XCTFail("\(snapshot.name): snapshot has no `type` discriminator")
                continue
            }
            XCTAssertEqual(decoded.type, type, "\(snapshot.name): decoded discriminator")

            guard let decodedPayload = decoded.normalizedPayload as? [String: Any] else {
                XCTFail("\(snapshot.name): decoded payload did not normalize to an object")
                continue
            }
            var payloadWire = snapshot.wire
            payloadWire.removeValue(forKey: "type") // discriminator, not a payload property
            assertWireSubset(wire: payloadWire, payload: decodedPayload, context: snapshot.name)
        }
    }

    func testHostNeverSendsEmptyEnvelopesAreKnownRequests() throws {
        for type in ["get_current_focus", "get_traversal_order"] {
            XCTAssertNotNil(RequestType(rawValue: type))
            let data = try wireJSON(["type": type, "requestId": "fixture-request-id"])
            _ = try JSONDecoder().decode(WebSocketRequest.self, from: data)
            let decoded = try WireDecoder.decode(data)
            XCTAssertEqual(decoded.type, type)
        }
        // request_two_finger_swipe requires x1/y1/x2/y2; set_network_fault_rules requires rules.
        // Neither is an empty/optional payload, so minimal-envelope decoding does not apply.
    }

    /// Unknown discriminators surface the exact wire error string
    /// (`"Unknown command type: <type>"`, matched by the TS `rewriteUnknownCommandError`).
    func testUnknownCommandErrorTextMatches() {
        let data = Data(#"{"type":"totally_made_up_command","requestId":"x"}"#.utf8)
        XCTAssertEqual(
            WireDecoder.decodeErrorMessage(data),
            "Unknown command type: totally_made_up_command"
        )
    }

    // MARK: - Normalized-value comparison helpers

    /// Every wire field lands on a same-named payload property with an equal value;
    /// payload-only keys must be NSNull (an optional the wire did not carry).
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
                    "\(context): wire field `\(key)` has no matching decoded payload property — field-name drift",
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
                "\(context): decoded payload property `\(key)` decoded \(value) from a wire payload that does not carry it",
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
                assertValueEqual(
                    expected: pair.0,
                    actual: pair.1,
                    context: "\(context)[\(index)]",
                    file: file,
                    line: line
                )
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
