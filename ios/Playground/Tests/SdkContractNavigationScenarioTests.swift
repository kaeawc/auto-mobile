import AutoMobileSDK
import os
import XCTest

@testable import Playground

final class SdkContractNavigationScenarioTests: XCTestCase {
    /// Unit-level host forwarding, not a captured device lifecycle or a multi-scene assertion.
    @MainActor
    func testRegistrationPreservesHostDelegateAndForwardsLifecycle() {
        let names = OSAllocatedUnfairLock(initialState: [String]())
        let bridge = AutoMobileWebViewBridge(webViewId: "unit", emitEvent: { event in
            names.withLock { $0.append(event.name) }
        })
        let host = SdkContractNavigationScenario(bridge: bridge)
        host.registerWebView()
        defer { bridge.detach() }
        XCTAssertTrue(host.webView.navigationDelegate === host)
        host.webView(host.webView, didCommit: nil)
        host.webView(host.webView, didFinish: nil)
        XCTAssertEqual(names.withLock { $0 }, ["navigation_committed", "navigation_finished"])
        XCTAssertTrue(host.webView.navigationDelegate === host)
    }
}
