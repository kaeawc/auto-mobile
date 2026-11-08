import AutoMobileSdkWire
import Foundation
import XCTest

@MainActor
final class WatchCommandHandlerTests: XCTestCase {
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
            className: "XCUIElementType(1)",
            bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100), hasTapTarget: true
        )])))
        XCTAssertNil(watchCrownWakePoint(in: crownHierarchy(children: [SdkViewNode(
            className: "XCUIElementType(48)",
            bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100), accessibilityLabel: "Custom tappable text"
        )])))
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
        let coordinator = WatchXCUISource.CommandFailureCoordinator()
        XCTAssertFalse(coordinator.recordDeflectedFailure("Outside gesture"))
        coordinator.begin()
        XCTAssertTrue(coordinator.recordDeflectedFailure("Tap failed"))
        XCTAssertTrue(coordinator.recordDeflectedFailure("Swipe failed"))
        XCTAssertEqual(coordinator.finish(), ["Tap failed", "Swipe failed"])
        XCTAssertFalse(coordinator.recordDeflectedFailure("After gesture"))
        XCTAssertEqual(coordinator.finish(), [])

        coordinator.begin()
        for _ in 0 ... WatchXCUISource.CommandFailureCoordinator.maxFailures {
            XCTAssertTrue(coordinator.recordDeflectedFailure("Failure"))
        }
        let failures = coordinator.finish()
        XCTAssertEqual(failures.count, WatchXCUISource.CommandFailureCoordinator.maxFailures + 1)
        XCTAssertEqual(failures.last, "Additional command failures truncated")

        coordinator.begin()
        XCTAssertTrue(coordinator.recordDeflectedFailure(String(repeating: "🐾", count: 4096)))
        let descriptions = coordinator.finish()
        XCTAssertLessThanOrEqual(
            descriptions.reduce(0) { $0 + $1.utf8.count },
            WatchXCUISource.CommandFailureCoordinator.maxDescriptionBytes
        )
        XCTAssertEqual(descriptions.last, "Additional command failures truncated")
        XCTAssertFalse(coordinator.recordDeflectedFailure("After truncated gesture"))
    }

    func testAllowlistContainsExactlySupportedCommands() {
        XCTAssertEqual(WatchCommandHandler.supportedCommands, ["hierarchy", "tap", "swipe", "home", "crown", "type"])
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
        XCTAssertEqual(event.supportedCommands, ["hierarchy", "tap", "swipe", "home", "crown", "type"])
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
        XCTAssertTrue(response.error?.contains("changed nothing") == true)
        XCTAssertEqual(source.rotations, 2)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.events, [
            "snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 0", "tap",
            "snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 0",
        ])
    }

    func testChangedHierarchyAfterCrownSucceeds() {
        let source = ScriptedCrownSource(labels: ["crown 0", "crown 0", "crown 8"])
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","requestId":"c","delta":2}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.type, "crown_result")
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.events, ["snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 8"])
    }

    func testCrownStabilizesBaselineBeforeRotatingAndAfterTouch() {
        let source = ScriptedCrownSource(labels: [
            "launching", "crown 0", "crown 0", "crown 0",
            "touch settling", "crown 0", "crown 0", "crown 8",
        ])
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
        let source = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 6))
        source.exposesFocusedValue = false
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.errorCode, "command_failed")
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.appliedDelta, 2)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(
            source.events,
            ["snapshot:unchanged", "snapshot:unchanged", "rotate", "snapshot:unchanged", "tap"]
        )
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
        let unreadable = ScriptedCrownSource(labels: Array(repeating: "unchanged", count: 3))
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
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.events, [
            "snapshot:launching", "snapshot:settling", "snapshot:crown 0", "rotate",
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
        let source = ScriptedCrownSource(labels: [])
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","requestId":"c","delta":2}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 0)
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

    func tap(x _: Double, y _: Double) throws {}
    func tap(identifier _: String) throws {}
    func swipe(_: WatchSwipeDirection, distance _: Double?) throws {}
    func typeText(_: String) throws {}
    func home() throws {}
}

private func crownValue(_ value: String, identifier: String = "focused") -> WatchCrownValue {
    WatchCrownValue(
        elementType: 33, identifier: identifier, frame: CGRect(x: 10, y: 10, width: 20, height: 20), value: value
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
