import Foundation
import XCTest
@testable import XCTestRunner

/// Typed daemon refusals cross the wire in the shapes captured in `test/fixtures/refusal-wire`
/// (generated from the real TypeScript builders). Every fixture must be classified as
/// `expectations.json` says; a recorded known gap pins the runner's current, divergent answer.
final class RefusalWireContractTests: XCTestCase {
    private struct Expectations: Decodable {
        struct Row: Decodable {
            let expected: String
            let knownGaps: [String: String]?
            let fields: Fields
        }

        struct Fields: Decodable {
            let code: String?
            let retryable: Bool
            let acquireNewSession: Bool
            let retryAfterMs: Int?
            let externalDevices: [String]?
            let recovering: Bool?
        }

        let codes: [String: Row]
    }

    /// A failed socket frame (`mcpRequestFailureDetails`) carries the typed fields at the top level,
    /// not in a tool result (#11544): the runner must classify it as the surfaces table says.
    func testEveryFailedSocketFrameIsClassifiedAsTheSurfacesExpectationsSay() throws {
        let surfaces = fixtureDirectory.appendingPathComponent("surfaces")
        let table = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: surfaces.appendingPathComponent("expectations.json")))
                as? [String: Any]
        )
        let rows = try XCTUnwrap(table["fixtures"] as? [String: [String: Any]])
        var checked = 0
        for (stem, row) in rows where stem.hasPrefix("socket-frame.") {
            let root = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(contentsOf: surfaces.appendingPathComponent("\(stem).json")))
                    as? [String: Any]
            )
            let frame = try XCTUnwrap(root["payload"] as? [String: Any], stem)
            let fields = try XCTUnwrap(row["fields"] as? [String: Any], stem)
            let refusal = try XCTUnwrap(
                AutoMobilePlanExecutor.DaemonRefusal.parse(frame), "\(stem) did not decode as a refusal"
            )
            XCTAssertEqual(
                refusal.recovering,
                (fields["details"] as? [String: Any])?["recovering"] as? Bool ?? false,
                "\(stem): recovering"
            )
            XCTAssertEqual(refusal.code, fields["code"] as? String, "\(stem): code")
            XCTAssertEqual(refusal.retryable, fields["retryable"] as? Bool, "\(stem): retryable")
            XCTAssertEqual(refusal.acquiresNewSession, fields["acquireNewSession"] as? Bool, "\(stem): nextAction")
            XCTAssertEqual(refusal.retryAfterMs, (fields["retryAfterMs"] as? NSNumber)?.intValue, "\(stem): hint")
            XCTAssertEqual(refusal.disposition.rawValue, row["expected"] as? String, stem)
            checked += 1
        }
        XCTAssertGreaterThan(checked, 0, "socket-frame rows were not found")
    }

    private func hintsTable() throws -> [String: Any] {
        let file = fixtureDirectory.deletingLastPathComponent()
            .appendingPathComponent("refusal-wire-hints/hints.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
    }

    private func hintRows(_ key: String) throws -> [[String: Any]] {
        try XCTUnwrap(hintsTable()[key] as? [[String: Any]])
    }

    func testTheFinalizeWaitCapAndCodesAreTheOnesSharedWithTheProxyAndJUnitRunner() throws {
        typealias Backoff = AutoMobilePlanExecutor.DeviceWaitBackoff
        let finalizeWait = try XCTUnwrap(hintsTable()["finalizeWait"] as? [String: Any])
        let waitBudgetMs = try XCTUnwrap((finalizeWait["waitBudgetMs"] as? NSNumber)?.intValue)
        let codes = try XCTUnwrap(finalizeWait["codes"] as? [String])
        XCTAssertEqual(Backoff.finalizeWaitCapMs, waitBudgetMs)
        XCTAssertEqual(Backoff.finalizeWaitCodes, Set(codes))
        for code in codes {
            // A hint far past the cap still stops the wait exactly at the shared budget.
            var almostSpent = Backoff(waits: 8, waitedMs: waitBudgetMs - 1)
            XCTAssertEqual(almostSpent.nextDelayMs(retryAfterMs: Int.max, code: code), 1, code)
            var spent = Backoff(waits: 8, waitedMs: waitBudgetMs)
            XCTAssertNil(spent.nextDelayMs(retryAfterMs: Int.max, code: code), code)
        }
    }

    func testARetryAfterHintIsUsableAsTheSharedHintsTableSays() throws {
        for row in try hintRows("usableHints") {
            let name = row["name"] as? String ?? ""
            let expected = (row["usable"] as? NSNumber)?.intValue
            XCTAssertEqual(
                AutoMobilePlanExecutor.DeviceWaitBackoff.usableHintMs(wire: row["wire"]), expected, name
            )
            let frame: [String: Any] = ["success": false, "error": "x", "code": "c", "retryAfterMs": row["wire"] as Any]
            XCTAssertEqual(
                AutoMobilePlanExecutor.DaemonRefusal.parse(frame)?.retryAfterMs, expected, "\(name) via parse"
            )
        }
    }

    func testTheNextDeviceWaitIsTheSharedHintsTableAnswerAndNeverOverflows() throws {
        for row in try hintRows("backoffSteps") {
            let name = row["name"] as? String ?? ""
            var backoff = AutoMobilePlanExecutor.DeviceWaitBackoff(
                waits: (row["waits"] as? NSNumber)?.intValue ?? 0,
                waitedMs: (row["waitedMs"] as? NSNumber)?.intValue ?? 0
            )
            // The wire value reaches the backoff the way production hands it over: through parse.
            let frame: [String: Any] = [
                "success": false, "error": "x", "code": row["code"] as Any,
                "retryAfterMs": row["retryAfterMs"] as Any,
            ]
            let refusal = try XCTUnwrap(AutoMobilePlanExecutor.DaemonRefusal.parse(frame), name)
            XCTAssertEqual(
                backoff.nextDelayMs(retryAfterMs: refusal.retryAfterMs, code: refusal.code),
                (row["delayMs"] as? NSNumber)?.intValue,
                name
            )
            // A raw Int hint (no parse) must clamp the same way.
            var raw = AutoMobilePlanExecutor.DeviceWaitBackoff(
                waits: (row["waits"] as? NSNumber)?.intValue ?? 0,
                waitedMs: (row["waitedMs"] as? NSNumber)?.intValue ?? 0
            )
            let rawHint = (row["retryAfterMs"] as? NSNumber)?.intValue
            XCTAssertEqual(
                raw.nextDelayMs(retryAfterMs: rawHint, code: row["code"] as? String),
                (row["delayMs"] as? NSNumber)?.intValue,
                "\(name) raw"
            )
        }
    }

    private var fixtureDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // XCTestRunnerTests
            .deletingLastPathComponent() // Sources
            .deletingLastPathComponent() // XCTestRunner
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repository root
            .appendingPathComponent("test/fixtures/refusal-wire")
    }

    func testEveryRefusalFixtureIsClassifiedAsTheSharedExpectationsTableSays() throws {
        let directory = fixtureDirectory
        let expectations = try JSONDecoder().decode(
            Expectations.self, from: Data(contentsOf: directory.appendingPathComponent("expectations.json"))
        )
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasSuffix(".json") && $0 != "expectations.json" }
        XCTAssertEqual(Set(files.map { String($0.dropLast(".json".count)) }), Set(expectations.codes.keys))

        for file in files {
            let code = String(file.dropLast(".json".count))
            let row = try XCTUnwrap(expectations.codes[code], code)
            let root = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent(file)))
                    as? [String: Any]
            )
            let result = try XCTUnwrap(root["result"] as? [String: Any], code)
            let content = try XCTUnwrap(result["content"] as? [[String: Any]], code)
            let text = try XCTUnwrap(content.first?["text"] as? String, code)
            let refusal = try XCTUnwrap(
                AutoMobilePlanExecutor.DaemonRefusal.parse(text), "\(code) did not decode as a refusal"
            )
            XCTAssertEqual(refusal.recovering, row.fields.recovering ?? false, "\(code): recovering")
            XCTAssertEqual(refusal.code, row.fields.code, "\(code): code")
            XCTAssertEqual(refusal.retryable, row.fields.retryable, "\(code): retryable")
            XCTAssertEqual(refusal.acquiresNewSession, row.fields.acquireNewSession, "\(code): nextAction")
            XCTAssertEqual(refusal.retryAfterMs, row.fields.retryAfterMs, "\(code): retryAfterMs")
            // The runner does not act on externalDevices; the wire must still carry the pinned list.
            let payload = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], code
            )
            XCTAssertEqual(
                payload["externalDevices"] as? [String], row.fields.externalDevices, "\(code): externalDevices"
            )
            let actual = refusal.disposition.rawValue
            if let gap = row.knownGaps?["swift"] {
                XCTAssertNotEqual(gap, row.expected, "\(code): known gap must differ from the expectation")
                XCTAssertEqual(actual, gap, "\(code): known gap no longer matches; remove it")
            } else {
                XCTAssertEqual(actual, row.expected, code)
            }
        }
    }
}
