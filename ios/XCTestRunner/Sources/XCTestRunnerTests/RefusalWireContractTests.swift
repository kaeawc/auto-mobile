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
        }

        let codes: [String: Row]
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
