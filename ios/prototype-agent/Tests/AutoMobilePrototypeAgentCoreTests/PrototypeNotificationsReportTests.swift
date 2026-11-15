@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

/// Replays the shared notifications report cases (#14277) the TypeScript reference defines.
final class PrototypeNotificationsReportTests: XCTestCase {
    private struct ReportCase: Decodable {
        let name: String
        let snapshot: JSONValue
        let report: JSONValue
    }

    private func cases() throws -> [ReportCase] {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try JSONDecoder().decode([ReportCase].self, from: Data(
            contentsOf: repository.appendingPathComponent("test/fixtures/prototype-notifications/report.json")
        ))
    }

    func testSharedCasesBuildTheExpectedReport() throws {
        let cases = try cases()
        XCTAssertFalse(cases.isEmpty)
        for testCase in cases {
            XCTAssertEqual(PrototypeNotificationsReport.of(testCase.snapshot), testCase.report, testCase.name)
        }
    }

    func testNamesAPrototypeIdOnlyForANonEmptyProtoTag() {
        XCTAssertEqual(PrototypeNotificationsReport.id(ofTag: .string("proto:upload")), "upload")
        XCTAssertNil(PrototypeNotificationsReport.id(ofTag: .string("proto:")))
        XCTAssertNil(PrototypeNotificationsReport.id(ofTag: .string("Discovery")))
        XCTAssertNil(PrototypeNotificationsReport.id(ofTag: .null))
    }
}
