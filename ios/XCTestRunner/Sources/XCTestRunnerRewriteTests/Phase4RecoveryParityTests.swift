import Foundation
import XCTest

// Differential parity for the recovery feature-flag parsing (reference vs rewrite). Both `parse`
// funcs are internal statics returning the same `(enabled, maxToolCalls)` tuple.
@testable import XCTestRunner
@testable import XCTestRunnerRewrite

final class Phase4RecoveryParityTests: XCTestCase {
    func testDaemonRecoveryConfigParseParity() {
        let texts = [
            "{\"key\":\"ai-recovery\",\"enabled\":true,\"config\":{\"maxToolCalls\":5}}",
            "{\"enabled\":false,\"config\":{\"maxToolCalls\":9}}",
            "{\"enabled\":true}",                 // missing config → default maxToolCalls
            "{\"config\":{\"maxToolCalls\":3}}",  // missing enabled → default enabled
            "not json at all",                    // unparseable → both defaults
            "{}",
        ]
        for text in texts {
            let reference = XCTestRunner.DaemonRecoveryConfigProvider.parse(text)
            let rewrite = XCTestRunnerRewrite.DaemonRecoveryConfigProvider.parse(text)
            XCTAssertEqual(reference.enabled, rewrite.enabled, "text=\(text)")
            XCTAssertEqual(reference.maxToolCalls, rewrite.maxToolCalls, "text=\(text)")
        }
    }
}
