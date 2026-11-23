@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypePlatformReportTests: XCTestCase {
    func testSharedReportsRoundTrip() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(
            contentsOf: repository.appendingPathComponent("test/fixtures/prototype-platform-report/report.json")
        )
        let decoder = JSONDecoder()
        let reports = try decoder.decode([PrototypePlatformReport].self, from: data)
        XCTAssertFalse(reports.isEmpty)
        let expected = try decoder.decode([JSONValue].self, from: data)
        XCTAssertEqual(reports.map(\.wireObject), expected)
        let reasons = Set(reports.flatMap { $0.modules.values.compactMap(\.reason) })
        XCTAssertEqual(reasons, Set(PrototypePlatformReport.Reason.allCases))
    }
}
