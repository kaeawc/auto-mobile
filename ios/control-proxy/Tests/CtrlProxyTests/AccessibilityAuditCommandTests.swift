@testable import CtrlProxy
import Foundation
import XCTest

private struct AuditCall: Equatable, Sendable {
    let bundleId: String?
    let checks: [String]
}

private actor FakeAccessibilityAuditor: AccessibilityAuditing {
    private(set) var calls: [AuditCall] = []
    private let outcome: AccessibilityAuditOutcome

    init(outcome: AccessibilityAuditOutcome) {
        self.outcome = outcome
    }

    func audit(bundleId: String?, checks: [String]) async -> AccessibilityAuditOutcome {
        calls.append(AuditCall(bundleId: bundleId, checks: checks))
        return outcome
    }
}

@MainActor
final class AccessibilityAuditCommandTests: XCTestCase {
    private let issue = AccessibilityAuditIssue(
        check: "contrast", summary: "Contrast nearly passed", detail: "Low contrast",
        elementId: "lowContrastLabel", label: "Faint", bounds: ElementBounds(left: 1, top: 2, right: 3, bottom: 4)
    )

    private func run(
        _ json: String,
        outcome: AccessibilityAuditOutcome? = nil
    )
        async throws -> (AccessibilityAuditResponse, FakeAccessibilityAuditor)
    {
        let auditor = FakeAccessibilityAuditor(
            outcome: outcome ?? AccessibilityAuditOutcome(issues: [issue], unsupportedChecks: [], error: nil)
        )
        let locator = FakeElementLocator()
        locator.foregroundBundleId = "com.example.app"
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: FakeGesturePerformer(), perf: PerfProvider(),
            accessibilityAuditor: auditor
        )
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(json.utf8))
        let payload = await handler.handle(request)
        return try (XCTUnwrap(payload as? AccessibilityAuditResponse), auditor)
    }

    func testRunsEveryCheckOnTheForegroundAppByDefault() async throws {
        let (response, auditor) = try await run(#"{"type":"request_accessibility_audit","requestId":"audit-1"}"#)
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.requestId, "audit-1")
        XCTAssertEqual(response.engine, "xcuitest")
        XCTAssertEqual(response.issues.map(\.elementId), ["lowContrastLabel"])
        XCTAssertEqual(response.unsupportedChecks, [])
        let calls = await auditor.calls
        XCTAssertEqual(calls, [AuditCall(bundleId: "com.example.app", checks: AccessibilityAuditCheck.all)])
    }

    func testUnknownChecksAreReportedNotRun() async throws {
        let (response, auditor) = try await run(
            #"{"type":"request_accessibility_audit","appId":"com.example.other","checks":["contrast","bogus"]}"#
        )
        XCTAssertEqual(response.unsupportedChecks, ["bogus"])
        let calls = await auditor.calls
        XCTAssertEqual(calls, [AuditCall(bundleId: "com.example.other", checks: ["contrast"])])
    }

    func testOnlyUnknownChecksNeverStartAnAudit() async throws {
        let (response, auditor) = try await run(#"{"type":"request_accessibility_audit","checks":["bogus"]}"#)
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.unsupportedChecks, ["bogus"])
        let calls = await auditor.calls
        XCTAssertEqual(calls, [])
    }

    func testAuditFailureIsReportedWithAnyIssuesCollected() async throws {
        let (response, _) = try await run(
            #"{"type":"request_accessibility_audit"}"#,
            outcome: AccessibilityAuditOutcome(issues: [issue], unsupportedChecks: [], error: "audit failed")
        )
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.error, "audit failed")
        XCTAssertEqual(response.issues.count, 1)
    }

    func testResponseEncodesTheWireContract() throws {
        let response = AccessibilityAuditResponse(
            requestId: "audit-1", issues: [issue], unsupportedChecks: ["bogus"], error: nil, totalTimeMs: 17
        )
        let wire = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as? [String: Any]
        )
        XCTAssertEqual(wire["type"] as? String, "accessibility_audit_result")
        XCTAssertEqual(wire["engine"] as? String, "xcuitest")
        XCTAssertEqual(wire["success"] as? Bool, true)
        XCTAssertEqual(wire["unsupportedChecks"] as? [String], ["bogus"])
        let issues = try XCTUnwrap(wire["issues"] as? [[String: Any]])
        XCTAssertEqual(issues.first?["check"] as? String, "contrast")
        XCTAssertEqual(issues.first?["elementId"] as? String, "lowContrastLabel")
        XCTAssertNil(wire["error"])
    }
}
