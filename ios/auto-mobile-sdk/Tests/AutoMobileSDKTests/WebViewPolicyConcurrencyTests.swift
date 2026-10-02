@testable import AutoMobileSDK
import Foundation
import os
import XCTest

final class WebViewPolicyConcurrencyTests: XCTestCase {
    func testConcurrentSnapshotUpdatesAndQueriesLeaveDeterministicFinalState() {
        let policy = AutoMobileWebViewPolicy(configuration: AutoMobileWebViewConfiguration(maxElements: 1))
        let successes = OSAllocatedUnfairLock(initialState: 0)

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            // Four stable IDs avoid eviction while writers and readers overlap.
            let snapshotId = "snapshot-\(index % 4)"
            let accepted = policy.accept(AutoMobileWebSnapshot(snapshotId: snapshotId, elements: [
                AutoMobileWebElement(id: "button", value: "secret"),
                AutoMobileWebElement(id: "bounded-out"),
            ]))
            if accepted.elements.count == 1, accepted.elements.first?.value == "[REDACTED]",
               policy.validates(.click(snapshotId: snapshotId, elementId: "button")),
               !policy.validates(.click(snapshotId: snapshotId, elementId: "bounded-out"))
            {
                successes.withLock { $0 += 1 }
            }
        }

        XCTAssertEqual(successes.withLock { $0 }, 32)
        // All concurrent operations have joined; replace one snapshot deterministically.
        _ = policy.accept(AutoMobileWebSnapshot(snapshotId: "snapshot-3", elements: [
            AutoMobileWebElement(id: "replacement"),
        ]))
        XCTAssertTrue(policy.validates(.focus(snapshotId: "snapshot-3", elementId: "replacement")))
        XCTAssertFalse(policy.validates(.focus(snapshotId: "snapshot-3", elementId: "button")))

        _ = policy.accept(AutoMobileWebSnapshot(snapshotId: "snapshot-z"))
        XCTAssertFalse(policy.validates(.scroll(snapshotId: "snapshot-0", elementId: nil, x: 0, y: 1)))
        for snapshotId in ["snapshot-1", "snapshot-2", "snapshot-3", "snapshot-z"] {
            XCTAssertTrue(policy.validates(.scroll(snapshotId: snapshotId, elementId: nil, x: 0, y: 1)))
        }
    }

    func testPolicyAndSnapshotValuesAreSendable() {
        func requireSendable<T: Sendable>(_: T.Type) {}

        requireSendable(AutoMobileWebViewPolicy.self)
        requireSendable(AutoMobileWebViewConfiguration.self)
        requireSendable(AutoMobileWebSnapshot.self)
        requireSendable(AutoMobileWebElement.self)
        requireSendable(AutoMobileWebAction.self)
    }
}
