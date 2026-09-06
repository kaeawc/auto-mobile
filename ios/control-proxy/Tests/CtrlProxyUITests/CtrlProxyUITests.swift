import XCTest

// Note: CtrlProxy sources are compiled directly into this target (not imported as framework)
// This gives XCTest access for XCUIApplication support

/// XCUITest runner that starts the CtrlProxy iOS WebSocket server
/// Similar to Appium's WebDriverAgent, but matching Android AccessibilityService protocol
///
/// Usage:
/// 1. Build and run this test target on a device/simulator
/// 2. The test will start the WebSocket server on port 8765
/// 3. Connect your automation client to ws://localhost:8765/ws
/// 4. Send commands matching Android AccessibilityService protocol
///
/// Environment Variables:
/// - CTRL_PROXY_IOS_PORT: Server port (default: 8765)
/// - CTRL_PROXY_IOS_BUNDLE_ID: Target app bundle ID (optional)
/// - CTRL_PROXY_IOS_TIMEOUT: How long to keep server running in seconds (default: forever)
///
final class CtrlProxyUITests: XCTestCase {
    private var service: CtrlProxy?

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    override func tearDownWithError() throws {
        service?.stop()
    }

    /// Main test that starts the WebSocket server
    /// This test runs indefinitely (or until timeout) to keep the server alive
    func testRunService() throws {
        // Get configuration from environment
        let port = getPort()
        let bundleId = getBundleId()

        print("========================================")
        print("  CtrlProxy iOS")
        print("========================================")
        print("Port: \(port)")
        print("Bundle ID: \(bundleId ?? "default")")
        print("Timeout: \(getTimeout().map { "\($0)s" } ?? "forever")")
        print("========================================")
        print("")
        print("WebSocket: ws://localhost:\(port)/ws")
        print("Health:    http://localhost:\(port)/health")
        print("")
        print("Protocol: Android AccessibilityService compatible")
        print("========================================")

        // Create and start service
        service = CtrlProxy(port: port)

        if let bundleId = bundleId {
            try service?.start(bundleId: bundleId)
        } else {
            try service?.start()
        }

        // Keep the test alive using XCTWaiter instead of RunLoop spinning.
        // The expectation is intentionally never fulfilled; .timedOut is the
        // expected result for a normal timed shutdown. The process is killed
        // externally by the MCP stop() path before the timeout elapses.
        let keepAlive = expectation(description: "CtrlProxy iOS keep-alive")
        let result = XCTWaiter().wait(for: [keepAlive], timeout: getTimeout() ?? 86400)
        XCTAssertEqual(result, .timedOut, "Expected service to run until timeout")
    }

    /// Test that just verifies the service can start
    func testServiceStarts() throws {
        let service = CtrlProxy(port: 8766)
        try service.start()

        // Give it a moment
        Thread.sleep(forTimeInterval: 1.0)

        XCTAssertTrue(true, "Service started successfully")

        service.stop()
    }

    /// Test that launches a specific app and starts the service
    func testLaunchAppAndRunService() throws {
        guard let bundleId = getBundleId() else {
            throw XCTSkip("CTRL_PROXY_IOS_BUNDLE_ID environment variable not set")
        }

        service = CtrlProxy(port: getPort())
        try service?.start(bundleId: bundleId)

        let keepAlive = expectation(description: "CtrlProxy iOS keep-alive")
        let result = XCTWaiter().wait(for: [keepAlive], timeout: getTimeout() ?? 300)
        XCTAssertEqual(result, .timedOut, "Expected service to run until timeout")
    }

    func testHierarchyIncludesTypedTextInputsMissingFromSnapshotTree() throws {
        let app = XCUIApplication()
        app.launchEnvironment["CTRL_PROXY_SNAPSHOT_GAP_TEST_MODE"] = "1"
        app.launch()

        let messageTextView = app.descendants(matching: .textView)
            .matching(NSPredicate(format: "label == %@", "Message #sample"))
            .firstMatch
        XCTAssertTrue(messageTextView.waitForExistence(timeout: 5))
        XCTAssertTrue(messageTextView.isHittable)
        XCTAssertTrue(messageTextView.identifier.isEmpty)

        let locator = ElementLocator(application: app)
        locator.setApplication(app, bundleId: "dev.jasonpearson.automobile.ctrlproxy")

        let initialHierarchy = try locator.getViewHierarchy(disableAllFiltering: false)
        let initialNodes = hierarchyNodes(in: try XCTUnwrap(initialHierarchy.hierarchy))
        let messageNodes = initialNodes.filter {
            $0.className == "UITextView" && $0.text == "Message #sample"
        }
        let messageNode = try XCTUnwrap(messageNodes.first)
        XCTAssertEqual(messageNodes.count, 1)
        XCTAssertNil(messageNode.resourceId)
        XCTAssertEqual(messageNode.role, "textfield")
        XCTAssertEqual(messageNode.clickable, "true")
        XCTAssertEqual(messageNode.actions, ["set_text", "clear_text"])
        XCTAssertEqual(messageNode.bounds?.left, Int(messageTextView.frame.minX))
        XCTAssertEqual(messageNode.bounds?.top, Int(messageTextView.frame.minY))
        XCTAssertEqual(messageNode.bounds?.right, Int(messageTextView.frame.maxX))
        XCTAssertEqual(messageNode.bounds?.bottom, Int(messageTextView.frame.maxY))

        let standardFieldNodes = initialNodes.filter {
            $0.className == "UITextField" && $0.resourceId == "standard-field"
        }
        XCTAssertEqual(standardFieldNodes.count, 1)

        let gestures = GesturePerformer(application: app, elementLocator: locator)
        try gestures.performAction("tap", label: "Message #sample")
        try gestures.typeText(text: "hello")
        let typedTextExpectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "hello"),
            object: messageTextView
        )
        XCTAssertEqual(XCTWaiter().wait(for: [typedTextExpectation], timeout: 5), .completed)
        XCTAssertEqual(messageTextView.value as? String, "hello")

        let secureField = app.secureTextFields["secure-field"]
        secureField.tap()
        secureField.typeText("secret")

        let finalHierarchy = try locator.getViewHierarchy(disableAllFiltering: false)
        let secureNode = hierarchyNodes(in: try XCTUnwrap(finalHierarchy.hierarchy)).first {
            $0.className == "UISecureTextField" && $0.resourceId == "secure-field"
        }
        XCTAssertEqual(secureNode?.value, String(repeating: "\u{2022}", count: 6))
        XCTAssertEqual(secureNode?.password, "true")
    }

    // MARK: - Configuration Helpers

    private func getPort() -> UInt16 {
        if let portString = ProcessInfo.processInfo.environment["CTRL_PROXY_IOS_PORT"],
           let port = UInt16(portString)
        {
            return port
        }
        return CtrlProxy.defaultPort
    }

    private func getBundleId() -> String? {
        return ProcessInfo.processInfo.environment["CTRL_PROXY_IOS_BUNDLE_ID"]
    }

    private func getTimeout() -> TimeInterval? {
        if let timeoutString = ProcessInfo.processInfo.environment["CTRL_PROXY_IOS_TIMEOUT"],
           let timeout = TimeInterval(timeoutString)
        {
            return timeout
        }
        return nil
    }

    private func hierarchyNodes(in element: UIElementInfo) -> [UIElementInfo] {
        [element] + (element.node ?? []).flatMap { hierarchyNodes(in: $0) }
    }
}
