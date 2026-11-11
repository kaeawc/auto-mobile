import AutoMobileSdkWire
import CoreGraphics
import Foundation
import XCTest
#if canImport(CtrlProxyWatchPolicy)
    @testable import CtrlProxyWatchPolicy
#endif

@MainActor
final class WatchCommandHandlerTests: XCTestCase {
    func testTapPointMapsToNormalizedOffset() throws {
        let offset = try watchTapNormalizedOffset(
            x: 93, y: 140, frame: CGRect(x: 0, y: 0, width: 186, height: 224)
        )
        XCTAssertEqual(offset.dx, 0.5)
        XCTAssertEqual(offset.dy, 0.625)
    }

    func testTapPointSubtractsClockfaceOrigin() throws {
        let frame = CGRect(x: 10, y: 20, width: 200, height: 250)
        let offset = try watchTapNormalizedOffset(x: 110, y: 145, frame: frame)
        XCTAssertEqual(offset.dx, 0.5)
        XCTAssertEqual(offset.dy, 0.5)
        let corner = try watchTapNormalizedOffset(x: 210, y: 270, frame: frame)
        XCTAssertEqual(corner, CGVector(dx: 1, dy: 1))
        for (x, y) in [(9.0, 100.0), (100.0, 19.0), (211.0, 100.0), (100.0, 271.0)] {
            XCTAssertThrowsError(try watchTapNormalizedOffset(x: x, y: y, frame: frame)) { error in
                guard case WatchCommandError.invalidRequest("tap is outside the watch screen") = error else {
                    return XCTFail("Expected invalidRequest, got \(error)")
                }
            }
        }
    }

    func testTapRouteUsesClockfaceWhenAppIsNotForegroundAndNoAlert() throws {
        var frameReads = 0
        let route = try watchTapRoute(x: 93, y: 140, hasAlerts: false, appForeground: false) {
            frameReads += 1
            return CGRect(x: 0, y: 0, width: 186, height: 224)
        }
        XCTAssertEqual(route, .clockface(CGVector(dx: 0.5, dy: 0.625)))
        XCTAssertEqual(frameReads, 1)
    }

    func testTapRouteRejectsOffScreenPointOnClockface() {
        XCTAssertThrowsError(try watchTapRoute(x: 300, y: 10, hasAlerts: false, appForeground: false) {
            CGRect(x: 0, y: 0, width: 186, height: 224)
        }) { error in
            guard case WatchCommandError.invalidRequest("tap is outside the watch screen") = error else {
                return XCTFail("Expected invalidRequest, got \(error)")
            }
        }
    }

    func testTapRouteKeepsAppAndAlertPathsWithoutReadingClockface() throws {
        let cases: [(hasAlerts: Bool, appForeground: Bool, expected: WatchTapRoute)] = [
            (false, true, .app), (true, true, .systemAlert), (true, false, .systemAlert),
        ]
        for testCase in cases {
            var frameReads = 0
            // Off-screen for the clockface, so a wrong clockface route would throw.
            let route = try watchTapRoute(
                x: 500, y: 500, hasAlerts: testCase.hasAlerts, appForeground: testCase.appForeground
            ) {
                frameReads += 1
                return CGRect(x: 0, y: 0, width: 186, height: 224)
            }
            XCTAssertEqual(route, testCase.expected)
            XCTAssertEqual(frameReads, 0)
        }
    }

    func testTapPointAcceptsScreenBoundaries() throws {
        let frame = CGRect(x: 0, y: 0, width: 200, height: 250)
        for (x, y) in [(0.0, 0.0), (200.0, 0.0), (0.0, 250.0), (200.0, 250.0)] {
            let offset = try watchTapNormalizedOffset(x: x, y: y, frame: frame)
            XCTAssertEqual(offset.dx, x / 200)
            XCTAssertEqual(offset.dy, y / 250)
        }
    }

    func testTapPointRejectsInvalidCoordinates() {
        let frame = CGRect(x: 0, y: 0, width: 200, height: 250)
        let points: [(Double, Double)] = [
            (-1, 100), (100, -1), (.nan, 100), (100, .nan),
            (.infinity, 100), (100, -.infinity), (201, 100), (100, 251),
        ]
        for (x, y) in points {
            XCTAssertThrowsError(try watchTapNormalizedOffset(x: x, y: y, frame: frame)) { error in
                guard case WatchCommandError.invalidRequest("tap is outside the watch screen") = error else {
                    return XCTFail("Expected invalidRequest, got \(error)")
                }
            }
        }
    }

    func testTapPointRejectsInvalidScreenDimensions() {
        let sizes: [CGSize] = [
            .zero, CGSize(width: 0, height: 250), CGSize(width: 200, height: 0),
            CGSize(width: -200, height: 250), CGSize(width: 200, height: -250),
            CGSize(width: CGFloat.nan, height: 250), CGSize(width: 200, height: CGFloat.infinity),
        ]
        for size in sizes {
            XCTAssertThrowsError(try watchTapNormalizedOffset(
                x: 0,
                y: 0,
                frame: CGRect(origin: .zero, size: size)
            )) { error in
                guard case WatchCommandError.invalidRequest("tap is outside the watch screen") = error else {
                    return XCTFail("Expected invalidRequest, got \(error)")
                }
            }
        }
    }

    func testSystemAlertsIgnoreEmptyAlerts() {
        let tree = WatchAlertTree(element: "root", children: [
            WatchAlertTree(element: "empty", elementType: 7),
            WatchAlertTree(element: "empty descendants", elementType: 7, children: [
                WatchAlertTree(element: "empty child"),
            ]),
            WatchAlertTree(element: "ordinary content", label: "App"),
        ])
        XCTAssertEqual(watchSystemAlerts(in: tree), [])
    }

    func testSystemAlertsKeepLabelsAndIdentifiersInOrder() {
        let tree = WatchAlertTree(element: "root", children: [
            WatchAlertTree(element: "permission", elementType: 7, label: "Allow"),
            WatchAlertTree(element: "empty", elementType: 7),
            WatchAlertTree(element: "notification", elementType: 7, identifier: "Invite"),
        ])
        XCTAssertEqual(watchSystemAlerts(in: tree), ["permission", "notification"])
    }

    func testSystemAlertsFindNestedContentWithoutDuplicatingAlerts() {
        let tree = WatchAlertTree(element: "root", children: [
            WatchAlertTree(element: "container", children: [
                WatchAlertTree(element: "alert", elementType: 7, children: [
                    WatchAlertTree(element: "table", children: [
                        WatchAlertTree(element: "text", elementType: 48, label: "Join the meeting?"),
                        WatchAlertTree(element: "nested alert", elementType: 7, identifier: "Invite"),
                    ]),
                ]),
            ]),
        ])
        XCTAssertEqual(watchSystemAlerts(in: tree), ["alert"])
        let nested = tree.children[0].children[0].children[0].children[1]
        // The production alert query can return a nested alert as a separate snapshot too.
        XCTAssertEqual(watchSystemAlerts(in: [tree, nested]), ["alert"])
        XCTAssertEqual(watchSystemAlerts(in: [nested, tree]), ["alert"])
    }

    func testProductionAlertSelectionUsesCapturedNotificationLooks() throws {
        for name in ["notification-permission-alert", "notification-short-look", "notification-long-look"] {
            let hierarchy = try capturedWatchHierarchy(name)
            let tree = try capturedAlertTree(XCTUnwrap(hierarchy.root))
            let queriedAlerts = tree.children.filter { $0.elementType == 7 }
            XCTAssertFalse(queriedAlerts.isEmpty, name)
            XCTAssertEqual(watchSystemAlerts(in: queriedAlerts), ["root.0"], name)
            XCTAssertEqual(watchSystemAlerts(in: tree), ["root.0"], name)
        }
    }

    func testCapturedStatusBarAlertsDoNotCaptureTapsOrAppearInObserve() throws {
        for name in ["notification-permission-alert", "notification-long-look"] {
            let hierarchy = try capturedWatchHierarchy(name)
            var tree = try capturedAlertTree(XCTUnwrap(hierarchy.root))
            let queriedAlerts = tree.children.filter { $0.elementType == 7 }
            XCTAssertEqual(queriedAlerts.count, 2, name)
            let statusAlert = try XCTUnwrap(queriedAlerts.last)
            // Select the captured second root alert itself, without inventing a status-bar tree.
            XCTAssertEqual(watchSystemAlerts(in: [statusAlert]), [], name)
            // Removing only the real notification leaves the status alert and the captured app windows.
            tree.children.removeFirst()
            XCTAssertEqual(watchSystemAlerts(in: tree), [], name)
        }
    }

    func testCrownWakeAvoidsCapturedBackButtonAndTextField() throws {
        let hierarchy = try capturedWatchHierarchy("text-entry-field-empty")
        let point = try XCTUnwrap(watchCrownWakePoint(in: hierarchy))
        XCTAssertGreaterThanOrEqual(point.dx, 0.35)
        XCTAssertGreaterThanOrEqual(point.dy, 0.4)
        let root = try XCTUnwrap(hierarchy.root)
        let controls = watchNodes(in: root).filter {
            ["XCUIElementType(9)", "XCUIElementType(49)"].contains($0.className)
        }
        XCTAssertEqual(controls.count, 2)
        for control in controls {
            let x = Double(point.dx) * Double(hierarchy.screenWidth)
            let y = Double(point.dy) * Double(hierarchy.screenHeight)
            let bounds = control.bounds
            XCTAssertFalse(
                x >= Double(bounds.left) - 8 && x <= Double(bounds.right) + 8
                    && y >= Double(bounds.top) - 8 && y <= Double(bounds.bottom) + 8
            )
        }
    }

    func testCrownWakeRejectsControlsAndEnabledTapTargets() {
        for type in [9, 75, 42, 40, 49, 45, 50, 33, 39, 79] {
            let hierarchy = crownHierarchy(children: [SdkViewNode(
                className: "XCUIElementType(\(type))",
                bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100)
            )])
            XCTAssertNil(watchCrownWakePoint(in: hierarchy), "type \(type)")
        }
        XCTAssertNil(watchCrownWakePoint(in: crownHierarchy(children: [SdkViewNode(
            className: "XCUIElementType(3)",
            bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100), hasTapTarget: true
        )])))
        XCTAssertNil(watchCrownWakePoint(in: crownHierarchy(children: [SdkViewNode(
            className: "XCUIElementType(48)",
            bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100), accessibilityLabel: "Custom tappable text"
        )])))
    }

    func testCrownWakeSkipsCenterCoveredByInteractiveContent() throws {
        for node in [
            SdkViewNode(
                className: "XCUIElementType(3)", bounds: SdkBounds(left: 45, top: 45, right: 55, bottom: 55),
                isUserInteractionEnabled: true, hasTapTarget: true
            ),
            SdkViewNode(
                className: "XCUIElementType(48)", bounds: SdkBounds(left: 45, top: 45, right: 55, bottom: 55),
                accessibilityLabel: "Custom control", isUserInteractionEnabled: true
            ),
        ] {
            let point = try XCTUnwrap(watchCrownWakePoint(in: crownHierarchy(children: [node])))
            XCTAssertEqual(point.dx, 0.65)
            XCTAssertEqual(point.dy, 0.5)
        }
    }

    func testCrownWakeAvoidsPlainOtherAndTextFrames() throws {
        for className in ["Other", "XCUIElementType(48)"] {
            let node = SdkViewNode(
                className: className, bounds: SdkBounds(left: 45, top: 45, right: 55, bottom: 55),
                isUserInteractionEnabled: false, hasTapTarget: false
            )
            XCTAssertTrue((node.accessibilityLabel ?? "").isEmpty)
            let point = try XCTUnwrap(watchCrownWakePoint(in: crownHierarchy(children: [node])))
            XCTAssertEqual(point.dx, 0.65)
            XCTAssertEqual(point.dy, 0.5)
        }
    }

    func testCrownWakeRejectsEveryNonContainerTypeWithAFrame() {
        // Type 1 has conditional structural exemptions covered separately below.
        for type in Array(0 ... 82) + [999] where ![1, 2, 4].contains(type) {
            let node = SdkViewNode(
                className: "XCUIElementType(\(type))", bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
                isUserInteractionEnabled: false, hasTapTarget: false
            )
            XCTAssertNil(watchCrownWakePoint(in: crownHierarchy(children: [node])), "type \(type)")
        }
    }

    func testCrownWakeTraversesExcludedContainers() throws {
        for type in [1, 2, 4] {
            let bounds = SdkBounds(left: 0, top: 0, right: 100, bottom: 100)
            let container = SdkViewNode(
                className: "XCUIElementType(\(type))", bounds: bounds,
                children: type == 1 ? [SdkViewNode(
                    className: "XCUIElementType(48)", bounds: SdkBounds(left: 0, top: 0, right: 10, bottom: 10)
                )] : nil
            )
            let point = try XCTUnwrap(watchCrownWakePoint(in: crownHierarchy(children: [container])))
            XCTAssertEqual(point.dx, 0.5)
            XCTAssertEqual(point.dy, 0.5)
            let occupied = SdkViewNode(className: container.className, bounds: bounds, children: [SdkViewNode(
                className: "XCUIElementType(48)", bounds: bounds
            )])
            XCTAssertNil(watchCrownWakePoint(in: crownHierarchy(children: [occupied])))
        }
    }

    func testCrownWakeRejectsLabeledOrIdentifiedOtherNodes() {
        for hasChildren in [false, true] {
            for enabled in [false, true] {
                for identifierOnly in [false, true] {
                    let node = SdkViewNode(
                        className: "XCUIElementType(1)",
                        bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
                        accessibilityLabel: identifierOnly ? nil : "Custom control",
                        accessibilityIdentifier: identifierOnly ? "custom-control" : nil,
                        isUserInteractionEnabled: enabled,
                        children: hasChildren ? [SdkViewNode(
                            className: "XCUIElementType(48)",
                            bounds: SdkBounds(left: 0, top: 0, right: 10, bottom: 10)
                        )] : nil
                    )
                    XCTAssertNil(watchCrownWakePoint(in: crownHierarchy(children: [node])))
                }
            }
        }
    }

    func testCrownWakeRejectsActionableUnlabeledOtherContainers() {
        for action in ["traits", "customActions", "tapTarget"] {
            let node = SdkViewNode(
                className: "XCUIElementType(1)",
                bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
                accessibilityTraits: action == "traits" ? ["button"] : [],
                accessibilityCustomActions: action == "customActions" ? ["Activate"] : [],
                isUserInteractionEnabled: true, hasTapTarget: action == "tapTarget",
                children: [SdkViewNode(
                    className: "XCUIElementType(48)", bounds: SdkBounds(left: 0, top: 0, right: 10, bottom: 10)
                )]
            )
            XCTAssertNil(watchCrownWakePoint(in: crownHierarchy(children: [node])), action)
        }
    }

    func testCrownWakeAllowsUnlabeledNonActionableOtherContainers() throws {
        for label in [nil, ""] as [String?] {
            for identifier in [nil, ""] as [String?] {
                for enabled in [false, true] {
                    let node = SdkViewNode(
                        className: "XCUIElementType(1)",
                        bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
                        accessibilityLabel: label, accessibilityIdentifier: identifier,
                        accessibilityTraits: enabled ? [] : ["button"],
                        accessibilityCustomActions: enabled ? [] : ["Activate"],
                        isUserInteractionEnabled: enabled, hasTapTarget: !enabled,
                        children: [SdkViewNode(
                            className: "XCUIElementType(48)",
                            bounds: SdkBounds(left: 0, top: 0, right: 10, bottom: 10)
                        )]
                    )
                    let point = try XCTUnwrap(watchCrownWakePoint(in: crownHierarchy(children: [node])))
                    XCTAssertEqual(point.dx, 0.5)
                    XCTAssertEqual(point.dy, 0.5)
                }
            }
        }
    }

    func testCrownWakeRejectsEnabledOtherLeaves() {
        let node = SdkViewNode(
            className: "XCUIElementType(1)", bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
            isUserInteractionEnabled: true
        )
        XCTAssertNil(watchCrownWakePoint(in: crownHierarchy(children: [node])))
    }

    func testCrownWakeAllowsUnlabeledNonInteractiveOtherLeaves() throws {
        // A leaf with no label, identifier, or interaction cannot activate a control, so leave it exempt.
        for children in [nil, []] as [[SdkViewNode]?] {
            let node = SdkViewNode(
                className: "XCUIElementType(1)", bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
                isUserInteractionEnabled: false, children: children
            )
            let point = try XCTUnwrap(watchCrownWakePoint(in: crownHierarchy(children: [node])))
            XCTAssertEqual(point.dx, 0.5)
            XCTAssertEqual(point.dy, 0.5)
        }
    }

    func testCrownWakeIgnoresEmptyDescendantFrames() throws {
        let point = try XCTUnwrap(watchCrownWakePoint(in: crownHierarchy(children: [SdkViewNode(
            className: "XCUIElementType(48)", bounds: SdkBounds(left: 50, top: 50, right: 50, bottom: 50)
        )])))
        XCTAssertEqual(point.dx, 0.5)
        XCTAssertEqual(point.dy, 0.5)
    }

    func testCrownWakeKeepsEightPointMarginFromPlainContent() throws {
        let point = try XCTUnwrap(watchCrownWakePoint(in: crownHierarchy(children: [SdkViewNode(
            className: "XCUIElementType(48)", bounds: SdkBounds(left: 40, top: 45, right: 42, bottom: 55),
            isUserInteractionEnabled: false
        )])))
        XCTAssertEqual(point.dx, 0.65)
        XCTAssertEqual(point.dy, 0.5)
    }

    func testCrownWakeFindsInteriorGapWithClearance() throws {
        let hierarchy = crownHierarchy(children: [SdkViewNode(
            className: "XCUIElementType(9)", bounds: SdkBounds(left: 30, top: 35, right: 60, bottom: 90)
        )])
        let point = try XCTUnwrap(watchCrownWakePoint(in: hierarchy))
        XCTAssertEqual(point.dx, 0.8)
        XCTAssertEqual(point.dy, 0.5)
    }

    func testCrownWakeRequiresReadableScreenAndRoot() {
        XCTAssertNil(watchCrownWakePoint(in: SdkViewHierarchy(
            screenScale: 1, screenWidth: 0, screenHeight: 100, root: nil
        )))
        XCTAssertNil(watchCrownWakePoint(in: SdkViewHierarchy(
            screenScale: 1, screenWidth: 100, screenHeight: 100, root: nil
        )))
        XCTAssertNil(watchCrownWakePoint(in: SdkViewHierarchy(
            screenScale: 1, screenWidth: 100, screenHeight: 100,
            root: SdkViewNode(className: "Window", bounds: SdkBounds(left: 10, top: 0, right: 110, bottom: 100))
        )))
    }

    func testCommandFailureCoordinatorScopesAndBoundsFailures() {
        let coordinator = WatchCommandFailureCoordinator()
        XCTAssertFalse(coordinator.recordDeflectedFailure("Outside gesture"))
        coordinator.begin()
        XCTAssertTrue(coordinator.recordDeflectedFailure("Tap failed"))
        XCTAssertTrue(coordinator.recordDeflectedFailure("Swipe failed"))
        XCTAssertEqual(coordinator.finish(), ["Tap failed", "Swipe failed"])
        XCTAssertFalse(coordinator.recordDeflectedFailure("After gesture"))
        XCTAssertEqual(coordinator.finish(), [])

        coordinator.begin()
        for _ in 0 ... WatchCommandFailureCoordinator.maxFailures {
            XCTAssertTrue(coordinator.recordDeflectedFailure("Failure"))
        }
        let failures = coordinator.finish()
        XCTAssertEqual(failures.count, WatchCommandFailureCoordinator.maxFailures + 1)
        XCTAssertEqual(failures.last, "Additional command failures truncated")

        coordinator.begin()
        XCTAssertTrue(coordinator.recordDeflectedFailure(String(repeating: "🐾", count: 4096)))
        let descriptions = coordinator.finish()
        XCTAssertLessThanOrEqual(
            descriptions.reduce(0) { $0 + $1.utf8.count },
            WatchCommandFailureCoordinator.maxDescriptionBytes
        )
        XCTAssertEqual(descriptions.last, "Additional command failures truncated")
        XCTAssertFalse(coordinator.recordDeflectedFailure("After truncated gesture"))
    }

    func testAllowlistContainsExactlySupportedCommands() {
        XCTAssertEqual(
            WatchCommandHandler.supportedCommands,
            ["hierarchy", "tap", "swipe", "home", "crown", "type", "face"]
        )
    }

    func testFaceOperationsAndDumpText() throws {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        for json in [
            #"{"type":"face","op":"tap","x":0,"y":1}"#,
            #"{"type":"face","op":"drag","fromX":0.5,"fromY":0.5,"toX":0.5,"toY":0.6}"#,
            #"{"type":"face","op":"swipe","direction":"up"}"#,
            #"{"type":"face","op":"swipe","direction":"down"}"#,
            #"{"type":"face","op":"swipe","direction":"left"}"#,
            #"{"type":"face","op":"swipe","direction":"right"}"#,
        ] {
            let response = handler.handle(Data(json.utf8))
            XCTAssertTrue(response.success)
            XCTAssertEqual(response.type, "face_result")
        }
        let response = handler.handle(Data(#"{"type":"face","op":"dump","requestId":"f"}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.type, "face_result")
        XCTAssertEqual(response.requestId, "f")
        let decoded = try JSONDecoder().decode(WatchResponse.self, from: JSONEncoder().encode(response))
        XCTAssertEqual(decoded.text, "clockface dump")
        XCTAssertEqual(source.calls, [
            "faceTap:0.0,1.0", "faceDrag:0.5,0.5,0.5,0.6",
            "faceSwipe:up", "faceSwipe:down", "faceSwipe:left", "faceSwipe:right", "faceDump",
        ])
    }

    func testFaceRejectsInvalidInputWithoutGestures() {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        for json in [
            #"{"type":"face"}"#,
            #"{"type":"face","op":"unknown"}"#,
            #"{"type":"face","op":"tap","x":0}"#,
            #"{"type":"face","op":"tap","x":-0.1,"y":0}"#,
            #"{"type":"face","op":"tap","x":0,"y":1.1}"#,
            #"{"type":"face","op":"tap","x":1e400,"y":0}"#,
            #"{"type":"face","op":"tap","x":"0","y":0}"#,
            #"{"type":"face","op":"drag","fromX":0,"fromY":0,"toX":1}"#,
            #"{"type":"face","op":"drag","fromX":0,"fromY":0,"toX":1,"toY":2}"#,
            #"{"type":"face","op":"swipe"}"#,
            #"{"type":"face","op":"swipe","direction":"diagonal"}"#,
        ] {
            let response = handler.handle(Data(json.utf8))
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.errorCode, "invalid_request")
        }
        XCTAssertEqual(source.calls, [])
    }

    func testEveryOtherCommandReturnsStructuredUnsupportedError() throws {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        for command in ["screenshot", "unknown", "request_screenshot", "press_home", ""] {
            // Unsupported commands are rejected before their parameters are decoded.
            let request = Data("{\"type\":\"\(command)\",\"requestId\":\"r1\",\"x\":\"invalid\"}".utf8)
            let response = handler.handle(request)
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.type, "error")
            XCTAssertEqual(response.requestId, "r1")
            XCTAssertEqual(response.errorCode, "unsupported_on_watchos")
            XCTAssertEqual(response.error, "\(command) is unsupported on watchOS")
            let encoded = try JSONEncoder().encode(response)
            let decoded = try JSONDecoder().decode(WatchResponse.self, from: encoded)
            XCTAssertEqual(decoded.errorCode, response.errorCode)
            XCTAssertEqual(decoded.error, response.error)
        }
        XCTAssertEqual(source.calls, [])
    }

    func testHandshakeReportsWatchOSAndSupportedCommands() throws {
        let data = try JSONEncoder().encode(WatchConnectedEvent(id: 7))
        let event = try JSONDecoder().decode(WatchConnectedEvent.self, from: data)
        XCTAssertEqual(event.type, "connected")
        XCTAssertEqual(event.id, 7)
        XCTAssertEqual(event.platform, "watchos")
        XCTAssertEqual(event.supportedCommands, ["hierarchy", "tap", "swipe", "home", "crown", "type", "face"])
        XCTAssertEqual(event.supportedFeatures, [])
    }

    func testSupportedCommandsUseInjectedSources() throws {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let hierarchy = handler.handle(Data(#"{"type":"hierarchy","requestId":"h"}"#.utf8))
        XCTAssertTrue(hierarchy.success)
        XCTAssertEqual(hierarchy.type, "hierarchy_update")
        XCTAssertEqual(hierarchy.requestId, "h")
        XCTAssertEqual(hierarchy.data?.root?.accessibilityLabel, "Counter")
        XCTAssertTrue(handler.handle(Data(#"{"type":"tap","x":12.5,"y":20}"#.utf8)).success)
        XCTAssertTrue(handler.handle(Data(#"{"type":"tap","identifier":"counter"}"#.utf8)).success)
        for direction in ["up", "down", "left", "right"] {
            XCTAssertTrue(handler.handle(Data("{\"type\":\"swipe\",\"direction\":\"\(direction)\"}".utf8)).success)
        }
        XCTAssertEqual(source.calls, ["hierarchy", "tap:12.5,20.0", "tap:counter", "up", "down", "left", "right"])
    }

    func testSwipeDistanceIsForwardedAndValidated() {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"swipe","direction":"up","distance":0.4}"#.utf8)).success)
        XCTAssertEqual(source.calls, ["up:0.4"])
        for distance in ["0", "-0.1", "1.5"] {
            let command = "{\"type\":\"swipe\",\"direction\":\"up\",\"distance\":\(distance)}"
            XCTAssertFalse(handler.handle(Data(command.utf8)).success)
        }
        XCTAssertEqual(source.calls, ["up:0.4"])
    }

    func testTypeReturnsResultAndUsesInjectedGesture() {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"type","requestId":"t","text":"Hello 🐾"}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.type, "type_result")
        XCTAssertEqual(response.requestId, "t")
        XCTAssertEqual(source.calls, ["type:Hello 🐾"])
    }

    func testTypeRejectsEmptyOrMissingTextWithoutGestures() {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        for json in [#"{"type":"type","text":""}"#, #"{"type":"type"}"#] {
            let response = handler.handle(Data(json.utf8))
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.errorCode, "invalid_request")
            XCTAssertEqual(response.error, "type requires non-empty text")
        }
        XCTAssertEqual(source.calls, [])
    }

    func testTypeFailureBecomesStructuredError() {
        let source = FakeWatchSource()
        source.shouldFail = true
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"type","text":"Hello"}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.errorCode, "command_failed")
        XCTAssertEqual(response.error, "No focused text field; tap the field first")
    }

    func testHomeReturnsResultAndUsesInjectedGesture() {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"home","requestId":"h"}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.type, "home_result")
        XCTAssertEqual(response.requestId, "h")
        XCTAssertEqual(source.calls, ["home"])
    }

    func testCrownDefaultsVelocityAndReturnsResult() {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","requestId":"c","delta":0.5}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.type, "crown_result")
        XCTAssertEqual(response.requestId, "c")
        XCTAssertEqual(source.calls, ["crown:0.5,1.0"])
    }

    func testCrownEffectComparesNodeTreeNotTimestamp() {
        func hierarchy(_ label: String, timestamp: Int64) -> SdkViewHierarchy {
            SdkViewHierarchy(
                timestamp: timestamp, screenScale: 1, screenWidth: 208, screenHeight: 248,
                root: SdkViewNode(
                    className: "Window", bounds: SdkBounds(left: 0, top: 0, right: 208, bottom: 248),
                    accessibilityLabel: label
                )
            )
        }
        XCTAssertFalse(watchCrownChangedHierarchy(
            before: hierarchy("crown 0.00", timestamp: 1), after: hierarchy("crown 0.00", timestamp: 2)
        ))
        XCTAssertTrue(watchCrownChangedHierarchy(
            before: hierarchy("crown 0.00", timestamp: 1), after: hierarchy("crown 8.71", timestamp: 2)
        ))
    }

    func testUnchangedHierarchyAfterCrownReturnsCommandFailed() throws {
        let source = ScriptedCrownSource(labels: Array(repeating: "crown 0", count: 6))
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","requestId":"c","delta":2}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.requestId, "c")
        XCTAssertEqual(response.errorCode, "command_failed")
        XCTAssertEqual(response.error, watchCrownUnchangedMessage(focused: crownValue("0")))
        XCTAssertTrue(response.error?.contains(#"The focused control's value stayed "0""#) == true)
        XCTAssertEqual(source.rotations, 2)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.events, [
            "snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 0", "tap",
            "snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 0",
        ])
    }

    func testCrownUnchangedMessageSeparatesStuckValueFromMissingFocus() {
        let stuck = watchCrownUnchangedMessage(focused: crownValue("10"))
        XCTAssertTrue(stuck.hasPrefix("rotateCrown changed nothing"))
        XCTAssertTrue(stuck.contains(#"value stayed "10""#))
        XCTAssertTrue(stuck.contains("too small to reach its next step"))
        XCTAssertFalse(stuck.contains("crown focus"))
        let unfocused = watchCrownUnchangedMessage(focused: nil)
        XCTAssertTrue(unfocused.hasPrefix("rotateCrown changed nothing"))
        XCTAssertTrue(unfocused.contains("No focused control exposes a readable value"))
        XCTAssertFalse(unfocused.contains("value stayed"))
    }

    func testWarmCrownValueChangeSucceedsWithoutWake() {
        let source = ScriptedCrownSource(labels: ["crown 0", "crown 0", "crown 8"])
        source.focusedValues = [crownValue("0"), crownValue("0"), crownValue("8")]
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","requestId":"c","delta":2}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.type, "crown_result")
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.events, ["snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 8"])
    }

    func testCrownRejectsTreeChangeWhenSameFocusedControlValueIsUnchanged() {
        for frame in [CGRect(x: 10, y: 10, width: 20, height: 20), CGRect(x: 10, y: 30, width: 20, height: 20)] {
            let source = ScriptedCrownSource(labels: [
                "before",
                "before",
                "shifted",
                "shifted",
                "shifted",
                "shifted",
                "shifted",
            ])
            source.focusedValues = [
                crownValue("0"), crownValue("0"), crownValue("0", frame: frame),
                crownValue("0", frame: frame), crownValue("0", frame: frame),
                crownValue("0", frame: frame), crownValue("0", frame: frame),
            ]
            let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
            let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.errorCode, "command_failed")
            XCTAssertTrue(response.error?.hasPrefix("rotateCrown changed nothing") == true)
        }
    }

    func testCrownAcceptsLaggingFocusedValueOnNextReadWithoutWakeOrRetry() {
        let source = ScriptedCrownSource(labels: ["before", "before", "scrolled", "scrolled"])
        source.focusedValues = [crownValue("0"), crownValue("0"), crownValue("0"), crownValue("2")]
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.events, [
            "snapshot:before", "snapshot:before", "rotate", "snapshot:scrolled", "snapshot:scrolled",
        ])
    }

    func testCrownRejectsFailedLaggingValueReadBeforeWake() {
        let source = ScriptedCrownSource(labels: ["before", "before", "scrolled"])
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.errorCode, "command_failed")
        XCTAssertTrue(response.error?.hasPrefix("rotateCrown changed nothing") == true)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.appliedDelta, 2)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.events, [
            "snapshot:before", "snapshot:before", "rotate", "snapshot:scrolled", "tap",
        ])
    }

    func testCrownRejectsFailedLaggingValueReadAfterRetry() {
        let source = ScriptedCrownSource(labels: [
            "before", "before", "before", "before", "before", "scrolled",
        ])
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.errorCode, "command_failed")
        XCTAssertTrue(response.error?.hasPrefix("rotateCrown changed nothing") == true)
        XCTAssertEqual(source.rotations, 2)
        XCTAssertEqual(source.appliedDelta, 4)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.events, [
            "snapshot:before", "snapshot:before", "rotate", "snapshot:before", "tap",
            "snapshot:before", "snapshot:before", "rotate", "snapshot:scrolled",
        ])
    }

    func testCrownLaggingValueReadIsBoundedBeforeWake() {
        let source = ScriptedCrownSource(labels: ["before", "before", "scrolled", "scrolled"])
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertFalse(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.events, [
            "snapshot:before", "snapshot:before", "rotate", "snapshot:scrolled", "snapshot:scrolled", "tap",
        ])
    }

    func testCrownAcceptsTreeChangeWithoutSameFocusedControl() {
        let afterValues: [WatchCrownValue?] = [
            nil, crownValue("0", identifier: "other"), crownValue("0", elementType: 34),
        ]
        for value in afterValues {
            let source = ScriptedCrownSource(labels: ["before", "before", "after"])
            source.focusedValues = [crownValue("0"), crownValue("0"), value]
            let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
            XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
            XCTAssertEqual(source.rotations, 1)
            XCTAssertEqual(source.taps, 0)
        }
    }

    func testCrownWakesColdFocusBeforeFirstRotationAndStabilizesAfterTouch() {
        let source = ScriptedCrownSource(labels: [
            "launching", "before", "before", "touch settling", "ready", "ready", "scrolled",
        ])
        source.exposesFocusedValue = false
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.appliedDelta, 2)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.wakePoints.first?.dx, 0.5)
        XCTAssertEqual(source.wakePoints.first?.dy, 0.5)
        XCTAssertEqual(source.events, [
            "snapshot:launching", "snapshot:before", "snapshot:before", "tap",
            "snapshot:touch settling", "snapshot:ready", "snapshot:ready", "rotate", "snapshot:scrolled",
        ])
    }

    func testCrownColdWakeFailureStopsBeforeRotating() {
        let source = ScriptedCrownSource(labels: ["before", "before"])
        source.exposesFocusedValue = false
        source.wakeFails = true
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.errorCode, "command_failed")
        XCTAssertEqual(response.error, "Wake failed")
        XCTAssertEqual(source.rotations, 0)
        XCTAssertEqual(source.appliedDelta, 0)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.events, ["snapshot:before", "snapshot:before", "tap"])
    }

    func testCrownVerifiesFocusedValueAcquiredByColdWake() {
        let source = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 5))
        source.focusedValues = [nil, nil, crownValue("0"), crownValue("0"), crownValue("2")]
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.appliedDelta, 2)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.events, [
            "snapshot:unchanged", "snapshot:unchanged", "tap", "snapshot:unchanged", "snapshot:unchanged",
            "rotate", "snapshot:unchanged",
        ])
    }

    func testCrownNeverProactivelyWakesReadableFocusedValue() {
        let source = ScriptedCrownSource(labels: ["before", "before", "scrolled"])
        source.focusedValues = [crownValue("0"), crownValue("0"), crownValue("2")]
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.events, ["snapshot:before", "snapshot:before", "rotate", "snapshot:scrolled"])
    }

    func testCrownStabilizesBaselineBeforeRotatingAndAfterTouch() {
        let source = ScriptedCrownSource(labels: [
            "launching", "crown 0", "crown 0", "crown 0",
            "touch settling", "crown 0", "crown 0", "crown 8",
        ])
        source.focusedValues = Array(repeating: crownValue("0"), count: 7) + [crownValue("8")]
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(source.rotations, 2)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.events, [
            "snapshot:launching", "snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 0", "tap",
            "snapshot:touch settling", "snapshot:crown 0", "snapshot:crown 0", "rotate",
            "snapshot:crown 8",
        ])
    }

    func testCrownRetriesUnchangedRotationAfterOneTouch() {
        let source = ScriptedCrownSource(labels: [
            "crown 0", "crown 0", "crown 0", "crown 0", "crown 0", "crown 8",
        ])
        source.focusedValues = Array(repeating: crownValue("0"), count: 5) + [crownValue("8")]
        source.dropsFirstRotation = true
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(source.rotations, 2)
        XCTAssertEqual(source.appliedDelta, 2)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.wakePoints.first?.dx, 0.5)
        XCTAssertEqual(source.wakePoints.first?.dy, 0.5)
        XCTAssertEqual(source.events, [
            "snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 0", "tap",
            "snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 8",
        ])
    }

    func testCrownDoesNotRepeatDeltaWhenItsEffectIsNotAccessible() {
        for valueReadFails in [false, true] {
            let source = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 6))
            source.exposesFocusedValue = false
            source.valueReadFails = valueReadFails
            let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
            let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.errorCode, "command_failed")
            XCTAssertEqual(response.error, watchCrownUnchangedMessage(focused: nil))
            XCTAssertEqual(source.rotations, 1)
            XCTAssertEqual(source.appliedDelta, 2)
            XCTAssertEqual(source.taps, 1)
            XCTAssertEqual(source.events, [
                "snapshot:unchanged", "snapshot:unchanged", "tap", "snapshot:unchanged", "snapshot:unchanged",
                "rotate", "snapshot:unchanged",
            ])
        }
    }

    func testCrownRecognizesFocusedValueChangeMissingFromWireHierarchy() {
        let source = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 3))
        source.focusedValues = [crownValue("0"), crownValue("0"), crownValue("2")]
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.appliedDelta, 2)
        XCTAssertEqual(source.taps, 0)
    }

    func testCrownDoesNotWakeOrRetryWhenControlsCoverScreen() {
        let source = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 6))
        source.exposesFocusedValue = false
        source.children = [SdkViewNode(
            className: "XCUIElementType(75)", bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100)
        )]
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.errorCode, "command_failed")
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.wakePoints.count, 0)
    }

    func testCrownDoesNotRetryWhenWakeChangesScreenOrFocus() {
        let screenChanged = ScriptedCrownSource(labels: ["before", "before", "before", "after", "after"])
        let focusChanged = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 5))
        focusChanged.focusedValues = [
            crownValue("0"), crownValue("0"), crownValue("0"),
            crownValue("0", identifier: "other"), crownValue("0", identifier: "other"),
        ]
        let valueChanged = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 5))
        valueChanged.focusedValues = [
            crownValue("0"),
            crownValue("0"),
            crownValue("0"),
            crownValue("2"),
            crownValue("2"),
        ]
        for source in [screenChanged, focusChanged, valueChanged] {
            let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
            let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.errorCode, "command_failed")
            XCTAssertEqual(source.rotations, 1)
            XCTAssertEqual(source.taps, 1)
        }
    }

    func testCrownDoesNotRetryWhenFocusedValueIsLostOrUnreadable() {
        let lost = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 3))
        lost.focusedValues = [crownValue("0"), crownValue("0"), nil]
        let unreadable = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 5))
        unreadable.valueReadFails = true
        for source in [lost, unreadable] {
            let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
            XCTAssertFalse(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
            XCTAssertEqual(source.rotations, 1)
            XCTAssertEqual(source.taps, 1)
        }
    }

    func testCrownDoesNotRetryWithoutPostWakeBaseline() {
        let source = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 3))
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertFalse(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 1)
    }

    func testCrownGestureFailuresStopWithoutAnotherRotation() {
        let wakeFailure = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 6))
        wakeFailure.wakeFails = true
        let rotateFailure = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 6))
        rotateFailure.rotationFails = true
        for (source, error, taps) in [(wakeFailure, "Wake failed", 1), (rotateFailure, "Rotation failed", 0)] {
            let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
            let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.errorCode, "command_failed")
            XCTAssertEqual(response.error, error)
            XCTAssertEqual(source.rotations, 1)
            XCTAssertEqual(source.taps, taps)
        }
    }

    func testCrownUnstableBaselineStopsAfterThreeSnapshotsWithoutRetry() {
        let source = ScriptedCrownSource(labels: ["launching", "settling", "crown 0", "crown 8"])
        source.exposesFocusedValue = false
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.events, [
            "snapshot:launching", "snapshot:settling", "snapshot:crown 0", "rotate",
        ])
    }

    func testCrownUnstableBaselineAcceptsLaggingFocusedValueOnNextReadWithoutWakeOrRetry() {
        let source = ScriptedCrownSource(labels: ["launching", "settling", "crown 0", "updated", "updated"])
        source.focusedValues = [
            crownValue("1"), crownValue("2"), crownValue("0"), crownValue("0"), crownValue("2"),
        ]
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":3}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.appliedDelta, 3)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.events, [
            "snapshot:launching", "snapshot:settling", "snapshot:crown 0", "rotate",
            "snapshot:updated", "snapshot:updated",
        ])
    }

    func testCrownUnstableBaselineRejectsUnchangedFocusedValueAfterRereadWithoutWakeOrRetry() {
        let source = ScriptedCrownSource(labels: ["launching", "settling", "crown 0", "updated", "updated"])
        source.focusedValues = [
            crownValue("1"), crownValue("2"), crownValue("0"), crownValue("0"), crownValue("0"),
        ]
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":3}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.errorCode, "command_failed")
        XCTAssertTrue(response.error?.hasPrefix("rotateCrown changed nothing") == true)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.appliedDelta, 3)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.events, [
            "snapshot:launching", "snapshot:settling", "snapshot:crown 0", "rotate",
            "snapshot:updated", "snapshot:updated",
        ])
    }

    func testCrownUnstableBaselineAcceptsChangedFocusedValueWithoutWakeOrRetry() {
        let source = ScriptedCrownSource(labels: ["launching", "settling", "crown 0", "updated"])
        source.focusedValues = [crownValue("1"), crownValue("2"), crownValue("0"), crownValue("1")]
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":3}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.appliedDelta, 3)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.events, [
            "snapshot:launching", "snapshot:settling", "snapshot:crown 0", "rotate", "snapshot:updated",
        ])
    }

    func testCrownDoesNotRetryWhenAfterSnapshotIsUnavailable() {
        let source = ScriptedCrownSource(labels: ["crown 0", "crown 0"])
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 0)
    }

    func testCrownVerificationSkippedWhenSnapshotsUnavailable() {
        for labels in [[], ["before"]] {
            let source = ScriptedCrownSource(labels: labels)
            source.exposesFocusedValue = false
            let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
            let response = handler.handle(Data(#"{"type":"crown","requestId":"c","delta":2}"#.utf8))
            XCTAssertTrue(response.success)
            XCTAssertEqual(source.rotations, 1)
            XCTAssertEqual(source.taps, 0)
        }
    }

    func testCrownUsesExplicitVelocity() {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":0.5,"velocity":2.0}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.type, "crown_result")
        XCTAssertEqual(source.calls, ["crown:0.5,2.0"])
    }

    func testInvalidCrownRequestsReturnErrorsWithoutGestures() {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        for json in [
            #"{"type":"crown"}"#,
            #"{"type":"crown","delta":1e400}"#,
            #"{"type":"crown","delta":0.5,"velocity":0}"#,
            #"{"type":"crown","delta":0.5,"velocity":-1}"#,
            #"{"type":"crown","delta":0.5,"velocity":1e400}"#,
        ] {
            let response = handler.handle(Data(json.utf8))
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.type, "error")
            XCTAssertEqual(response.errorCode, "invalid_request")
        }
        XCTAssertEqual(source.calls, [])
    }

    func testInvalidSupportedRequestsReturnErrorsWithoutGestures() {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        for json in [
            #"{"type":"tap"}"#,
            #"{"type":"tap","x":1}"#,
            #"{"type":"swipe","direction":"diagonal"}"#,
            "{",
        ] {
            let response = handler.handle(Data(json.utf8))
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.errorCode, "invalid_request")
        }
        XCTAssertEqual(source.calls, [])
    }

    func testSourceFailureBecomesStructuredError() {
        let source = FakeWatchSource()
        source.shouldFail = true
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"hierarchy","requestId":"h"}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.requestId, "h")
        XCTAssertEqual(response.errorCode, "command_failed")
        XCTAssertEqual(response.error, "Snapshot failed")
    }

    func testBackgroundAppReturnsTypedErrorWithoutHierarchy() throws {
        let source = FakeWatchSource()
        source.snapshotError = .appNotForeground
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"hierarchy","requestId":"h"}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.type, "error")
        XCTAssertEqual(response.requestId, "h")
        XCTAssertEqual(response.errorCode, "app_not_foreground")
        XCTAssertEqual(
            response.error,
            "The watch runner app is not in the foreground; open it to observe its hierarchy."
        )
        XCTAssertNil(response.data)
        let decoded = try JSONDecoder().decode(WatchResponse.self, from: JSONEncoder().encode(response))
        XCTAssertEqual(decoded.errorCode, "app_not_foreground")
        XCTAssertNil(decoded.data)
        XCTAssertEqual(source.calls, [])
    }
}

@MainActor
private final class FakeWatchSource: WatchSnapshotSource, WatchGesturePerformer {
    var calls: [String] = []
    var shouldFail = false
    var snapshotError: WatchCommandError?

    func faceTap(x: Double, y: Double) throws { calls.append("faceTap:\(x),\(y)") }
    func faceDrag(fromX: Double, fromY: Double, toX: Double, toY: Double) throws {
        calls.append("faceDrag:\(fromX),\(fromY),\(toX),\(toY)")
    }

    func faceSwipe(_ direction: WatchSwipeDirection) throws { calls.append("faceSwipe:\(direction.rawValue)") }
    func faceDump() throws -> String {
        calls.append("faceDump")
        return "clockface dump"
    }

    func snapshot() throws -> SdkViewHierarchy {
        if let snapshotError { throw snapshotError }
        if shouldFail { throw WatchCommandError.commandFailed("Snapshot failed") }
        calls.append("hierarchy")
        return SdkViewHierarchy(
            timestamp: 0, screenScale: 1, screenWidth: 100, screenHeight: 100,
            root: SdkViewNode(
                className: "XCUIElementType(9)", bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
                accessibilityLabel: "Counter"
            )
        )
    }

    func tap(x: Double, y: Double) throws {
        calls.append("tap:\(x),\(y)")
    }

    func tap(identifier: String) throws {
        calls.append("tap:\(identifier)")
    }

    func swipe(_ direction: WatchSwipeDirection, distance: Double?) throws {
        calls.append(distance.map { "\(direction.rawValue):\($0)" } ?? direction.rawValue)
    }

    func typeText(_ text: String) throws {
        if shouldFail { throw WatchCommandError.commandFailed("No focused text field; tap the field first") }
        calls.append("type:\(text)")
    }

    func home() throws {
        calls.append("home")
    }

    func rotateCrown(delta: Double, velocity: Double) throws {
        calls.append("crown:\(delta),\(velocity)")
    }
}

/// Drives the production crown verification through the handler with scripted snapshots.
@MainActor
private final class ScriptedCrownSource: WatchSnapshotSource, WatchGesturePerformer {
    private var labels: [String]
    var children: [SdkViewNode] = []
    var focusedValues: [WatchCrownValue?]?
    var exposesFocusedValue = true
    var valueReadFails = false
    var wakeFails = false
    var rotationFails = false
    var dropsFirstRotation = false
    private(set) var wakePoints: [CGVector] = []
    private(set) var appliedDelta = 0.0
    private(set) var rotations = 0
    private(set) var taps = 0
    private(set) var events: [String] = []

    init(labels: [String]) { self.labels = labels }

    func snapshot() throws -> SdkViewHierarchy {
        guard !labels.isEmpty else { throw WatchCommandError.commandFailed("Snapshot failed") }
        let label = labels.removeFirst()
        events.append("snapshot:\(label)")
        return SdkViewHierarchy(
            timestamp: Int64(labels.count), screenScale: 1, screenWidth: 100, screenHeight: 100,
            root: SdkViewNode(
                className: "Window", bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
                accessibilityLabel: label, isUserInteractionEnabled: false, children: children
            )
        )
    }

    func rotateCrown(delta: Double, velocity _: Double) throws {
        try watchVerifiedCrownRotation(snapshots: self, focusedValue: {
            if self.valueReadFails { throw WatchCommandError.commandFailed("Value unavailable") }
            if let values = self.focusedValues, !values.isEmpty {
                return self.focusedValues?.removeFirst()
            }
            return self.exposesFocusedValue ? crownValue("0") : nil
        }, wake: { point in
            self.taps += 1
            self.wakePoints.append(point)
            self.events.append("tap")
            if self.wakeFails { throw WatchCommandError.commandFailed("Wake failed") }
        }, rotate: {
            self.rotations += 1
            if !self.dropsFirstRotation || self.rotations > 1 { self.appliedDelta += delta }
            self.events.append("rotate")
            if self.rotationFails { throw WatchCommandError.commandFailed("Rotation failed") }
        })
    }

    func faceTap(x _: Double, y _: Double) throws {}
    func faceDrag(fromX _: Double, fromY _: Double, toX _: Double, toY _: Double) throws {}
    func faceSwipe(_: WatchSwipeDirection) throws {}
    func faceDump() throws -> String { "" }
    func tap(x _: Double, y _: Double) throws {}
    func tap(identifier _: String) throws {}
    func swipe(_: WatchSwipeDirection, distance _: Double?) throws {}
    func typeText(_: String) throws {}
    func home() throws {}
}

private func crownValue(
    _ value: String, identifier: String = "focused", elementType: UInt = 33,
    frame: CGRect = CGRect(x: 10, y: 10, width: 20, height: 20)
)
    -> WatchCrownValue
{
    WatchCrownValue(
        elementType: elementType, identifier: identifier, frame: frame, value: value
    )
}

private func crownHierarchy(children: [SdkViewNode]) -> SdkViewHierarchy {
    SdkViewHierarchy(
        timestamp: 0, screenScale: 1, screenWidth: 100, screenHeight: 100,
        root: SdkViewNode(
            className: "Window", bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100), children: children
        )
    )
}

private func capturedWatchHierarchy(_ name: String) throws -> SdkViewHierarchy {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // CtrlProxyWatchUITests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // control-proxy
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // repo root
        .appendingPathComponent("test/fixtures/watchos-xcuitest/\(name).json")
    let data = try Data(contentsOf: url)
    let decoder = JSONDecoder()
    if let hierarchy = try? decoder.decode(SdkViewHierarchy.self, from: data) {
        return hierarchy
    }
    return try XCTUnwrap(decoder.decode(WatchResponse.self, from: data).data)
}

private func capturedAlertTree(_ node: SdkViewNode, path: String = "root") throws -> WatchAlertTree<String> {
    let prefix = "XCUIElementType("
    XCTAssertTrue(node.className.hasPrefix(prefix) && node.className.hasSuffix(")"))
    let type = try XCTUnwrap(UInt(node.className.dropFirst(prefix.count).dropLast()))
    return try WatchAlertTree(
        element: path, elementType: type,
        frame: CGRect(
            x: CGFloat(node.bounds.left), y: CGFloat(node.bounds.top),
            width: CGFloat(node.bounds.right - node.bounds.left), height: CGFloat(node.bounds.bottom - node.bounds.top)
        ),
        label: node.accessibilityLabel ?? "", identifier: node.accessibilityIdentifier ?? "",
        children: (node.children ?? []).enumerated().map { index, child in
            try capturedAlertTree(child, path: "\(path).\(index)")
        }
    )
}

private func watchNodes(in node: SdkViewNode) -> [SdkViewNode] {
    [node] + (node.children ?? []).flatMap { watchNodes(in: $0) }
}
