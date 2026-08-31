import Foundation
import XCTest
import XCTestRunner
import XCTestRunnerRewrite
import XCTestRunnerTestSupport

/// Phase-2a: the generic seams + stateless impls. `DefaultPlanLoader` behavior is diffed against the
/// reference; the relocated `FakeTimer` (now in TestSupport, lock-confined Sendable) is smoke-tested.
final class Phase2SeamsTests: XCTestCase {
    func testDefaultPlanLoaderAbsolutePathParity() throws {
        let content = "platform: ios\nsteps:\n  - tool: observe\n"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("phase2-plan-\(UUID().uuidString).yaml")
        try content.write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }

        let referenceContent = try XCTestRunner.DefaultPlanLoader().loadPlan(at: url.path, bundle: nil)
        let rewriteContent = try XCTestRunnerRewrite.DefaultPlanLoader().loadPlan(at: url.path, bundle: nil)
        XCTAssertEqual(referenceContent, rewriteContent)
        XCTAssertEqual(rewriteContent, content)
    }

    func testDefaultPlanLoaderMissingPathParity() {
        let missing = "/definitely/not/here/\(UUID().uuidString).yaml"
        var referenceMessage: String?
        var rewriteMessage: String?
        XCTAssertThrowsError(try XCTestRunner.DefaultPlanLoader().loadPlan(at: missing, bundle: nil)) {
            referenceMessage = String(describing: $0)
        }
        XCTAssertThrowsError(try XCTestRunnerRewrite.DefaultPlanLoader().loadPlan(at: missing, bundle: nil)) {
            rewriteMessage = String(describing: $0)
        }
        XCTAssertEqual(referenceMessage, rewriteMessage)
    }

    func testFakeTimerAdvancesAndRecords() {
        // Module-qualified: the reference module also ships a `FakeTimer` (untouched oracle), so the
        // bare name is ambiguous in the dual-linking test target.
        let timer = XCTestRunnerTestSupport.FakeTimer(initialTime: 10)
        XCTAssertEqual(timer.now(), 10)
        timer.sleep(seconds: 5)
        XCTAssertEqual(timer.now(), 15)
        timer.sleep(seconds: 2.5)
        XCTAssertEqual(timer.now(), 17.5)
        XCTAssertEqual(timer.sleeps, [5, 2.5])
    }
}
