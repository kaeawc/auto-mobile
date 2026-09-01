// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

@testable import CtrlProxy
import XCTest

/// Field-name wire-parity backstop for the TS client ↔ Swift runner (issue #2954,
/// checklist item 3 of #2857).
///
/// The command-name tripwire (`test/features/observe/ios/ctrlProxyWireParity.integration.test.ts`)
/// catches a renamed `type` discriminator but not a renamed field *inside* a command
/// payload. This suite is the Swift half of a two-sided guard around the shared JSON
/// snapshot fixture `test/fixtures/ios-ctrlproxy-request-snapshots.json`:
///
///   1. (TS) `ctrlProxyRequestSnapshots.test.ts` captures every snapshot live from the
///      real TS builders and asserts deep equality with the fixture, so the fixture
///      cannot drift from what the client actually sends.
///   2. (here) Every snapshot is decoded through the real `WebSocketRequest` wire path
///      and every wire field must land on a same-named property of the typed payload
///      struct with the same value — via `Mirror`, so new fixture entries are covered
///      automatically with no per-command test arm.
///
/// A one-sided payload-field rename therefore fails a test on whichever side moved:
/// TS rename → TS capture test fails → fixture update → this suite fails until
/// `Models.swift` matches; Swift rename → this suite fails immediately.
///
/// Assumption (holds for every request payload in `Models.swift`): payload structs use
/// synthesized `Decodable` with no custom `CodingKeys`, so a property's Mirror label IS
/// its wire key. A payload that introduces custom `CodingKeys` breaks that equivalence
/// and fails here loudly — update the normalization (not the fixture) in that case.
final class RequestSnapshotWireParityTests: XCTestCase {
    private struct Snapshot {
        let name: String
        let wire: [String: Any]
    }

    private enum FixtureError: Error {
        case malformed(String)
    }

    /// The canonical fixture lives at the repo root so the TS and Swift suites read the
    /// same bytes. `#filePath` is `<repo>/ios/control-proxy/Tests/CtrlProxyTests/<file>`,
    /// so five `deleteLastPathComponent()` calls reach the repo root. A missing fixture
    /// fails loudly (never skips): silently skipping would defeat the tripwire.
    private static func fixtureURL() -> URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            url.deleteLastPathComponent()
        }
        return url
            .appendingPathComponent("test")
            .appendingPathComponent("fixtures")
            .appendingPathComponent("ios-ctrlproxy-request-snapshots.json")
    }

    private static func loadSnapshots() throws -> [Snapshot] {
        let data = try Data(contentsOf: fixtureURL())
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = root["snapshots"] as? [[String: Any]]
        else {
            throw FixtureError.malformed("fixture root must be { snapshots: [...] }")
        }
        return try entries.map { entry in
            guard let name = entry["name"] as? String,
                  let wire = entry["wire"] as? [String: Any]
            else {
                throw FixtureError.malformed("snapshot entries must carry `name` and `wire`")
            }
            return Snapshot(name: name, wire: wire)
        }
    }

    // MARK: - Mirror-based payload normalization

    /// Convert a decoded payload value into a JSON-comparable form: optionals unwrap
    /// (nil → NSNull), numbers/strings pass through, structs become dictionaries keyed
    /// by property name, collections and dictionaries recurse.
    private func jsonNormalized(_ value: Any) -> Any {
        let mirror = Mirror(reflecting: value)
        if mirror.displayStyle == .optional {
            guard let child = mirror.children.first else {
                return NSNull()
            }
            return jsonNormalized(child.value)
        }
        // Int/Int64/Double/Float/Bool all bridge to NSNumber; String stays String.
        if let number = value as? NSNumber {
            return number
        }
        if let string = value as? String {
            return string
        }
        switch mirror.displayStyle {
        case .collection:
            return mirror.children.map { jsonNormalized($0.value) }
        case .dictionary:
            var dict = [String: Any]()
            for child in mirror.children {
                let pair = Mirror(reflecting: child.value).children.map(\.value)
                if pair.count == 2, let key = pair[0] as? String {
                    dict[key] = jsonNormalized(pair[1])
                }
            }
            return dict
        case .struct, .class:
            var dict = [String: Any]()
            for child in mirror.children {
                if let label = child.label {
                    dict[label] = jsonNormalized(child.value)
                }
            }
            return dict
        default:
            return value
        }
    }

    /// Assert every wire field lands on a same-named payload property with an equal
    /// value, recursively. Payload-only keys must be NSNull (an optional the wire did
    /// not carry) — a non-nil payload-only value means the struct decoded something
    /// the fixture doesn't document, which is its own kind of drift.
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
                    "\(context): wire field `\(key)` has no matching Swift property — " +
                        "TS/Swift payload field-name drift (see Models.swift)",
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
                "\(context): Swift property `\(key)` decoded \(value) from a wire payload that does not carry it",
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
        // Scalars: NSNumber/NSString/NSNull equality (NSNumber compares across widths,
        // so a wire integer equals a decoded Double of the same value).
        XCTAssertTrue(
            (actual as AnyObject).isEqual(expected),
            "\(context): decoded \(actual) != wire \(expected)",
            file: file,
            line: line
        )
    }

    // MARK: - Tests

    func testFixtureCoversTheAcceptanceCriticalCommands() throws {
        let snapshots = try Self.loadSnapshots()
        XCTAssertGreaterThanOrEqual(snapshots.count, 30, "fixture unexpectedly small — was it truncated?")
        XCTAssertEqual(
            Set(snapshots.map(\.name)).count,
            snapshots.count,
            "snapshot names must be unique"
        )

        let coveredTypes = Set(snapshots.compactMap { $0.wire["type"] as? String })
        let required: Set<String> = [
            "request_action",
            "request_set_text",
            "request_append_text",
            "request_ime_action",
            "request_hierarchy",
            "request_hierarchy_if_stale",
            "list_preference_files",
            "get_preferences",
            "get_preference",
            "set_preference",
            "remove_preference",
            "clear_preferences",
            "execute_sql",
            "list_databases",
            "list_tables",
            "get_table_data",
            "get_table_structure",
        ]
        XCTAssertEqual(required.subtracting(coveredTypes), [], "acceptance-critical commands missing from fixture")
    }

    /// Every snapshot must decode through the real wire path into the payload struct
    /// matching its discriminator, with every wire field landing on a same-named
    /// property carrying the same value.
    func testEverySnapshotDecodesWithFieldNameParity() throws {
        for snapshot in try Self.loadSnapshots() {
            let wireData = try JSONSerialization.data(withJSONObject: snapshot.wire)
            guard let wireJson = String(data: wireData, encoding: .utf8) else {
                XCTFail("\(snapshot.name): could not re-serialize wire object")
                continue
            }

            let request: WebSocketRequest
            do {
                request = try decodeWebSocketRequest(wireJson)
            } catch {
                XCTFail("\(snapshot.name): failed to decode through WebSocketRequest: \(error)")
                continue
            }

            guard let type = snapshot.wire["type"] as? String else {
                XCTFail("\(snapshot.name): snapshot has no `type` discriminator")
                continue
            }
            XCTAssertEqual(request.typeString, type, snapshot.name)

            guard let payloadFields = jsonNormalized(request.payload) as? [String: Any] else {
                XCTFail("\(snapshot.name): payload did not normalize to an object")
                continue
            }
            // `type` is the envelope discriminator, not a payload property.
            var payloadWire = snapshot.wire
            payloadWire.removeValue(forKey: "type")
            assertWireSubset(
                wire: payloadWire,
                payload: payloadFields,
                context: "\(snapshot.name) (\(Swift.type(of: request.payload)))"
            )
        }
    }

    /// Meta-guard: prove the parity check actually bites by feeding it a snapshot with
    /// a renamed field. If this stops failing, the guard has gone vacuous.
    func testARenamedWireFieldIsDetected() throws {
        let wire: [String: Any] = [
            "type": "request_set_text",
            "requestId": "fixture-request-id",
            "text": "hello",
            // The real field is `resourceId`; simulate a one-sided TS rename.
            "identifier": "login_username_field",
        ]
        let request = try decodeWebSocketRequest(
            String(data: JSONSerialization.data(withJSONObject: wire), encoding: .utf8)!
        )
        guard let payloadFields = jsonNormalized(request.payload) as? [String: Any] else {
            XCTFail("payload did not normalize to an object")
            return
        }
        XCTAssertNil(
            payloadFields["identifier"],
            "RequestSetText unexpectedly grew an `identifier` property — update this meta-guard"
        )
        // The decoded struct dropped the renamed field entirely and left the real
        // optional at nil — exactly the silent runtime failure the suite exists to catch.
        XCTAssertTrue(payloadFields["resourceId"] is NSNull)
    }
}
