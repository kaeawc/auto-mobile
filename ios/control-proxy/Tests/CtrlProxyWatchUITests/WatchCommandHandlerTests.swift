import AutoMobileSdkWire
import Foundation
import XCTest

@MainActor
final class WatchCommandHandlerTests: XCTestCase {
    func testSystemAlertsIgnoreEmptyAlerts() {
        let tree = WatchAlertTree(element: "root", children: [
            WatchAlertTree(element: "empty", isAlert: true),
            WatchAlertTree(element: "empty descendants", isAlert: true, children: [
                WatchAlertTree(element: "empty child"),
            ]),
            WatchAlertTree(element: "ordinary content", label: "App"),
        ])
        XCTAssertEqual(watchSystemAlerts(in: tree), [])
    }

    func testSystemAlertsKeepLabelsAndIdentifiersInOrder() {
        let tree = WatchAlertTree(element: "root", children: [
            WatchAlertTree(element: "permission", isAlert: true, label: "Allow"),
            WatchAlertTree(element: "empty", isAlert: true),
            WatchAlertTree(element: "notification", isAlert: true, identifier: "Invite"),
        ])
        XCTAssertEqual(watchSystemAlerts(in: tree), ["permission", "notification"])
    }

    func testSystemAlertsFindNestedContentWithoutDuplicatingAlerts() {
        let tree = WatchAlertTree(element: "root", children: [
            WatchAlertTree(element: "container", children: [
                WatchAlertTree(element: "alert", isAlert: true, children: [
                    WatchAlertTree(element: "table", children: [
                        WatchAlertTree(element: "text", label: "Join the meeting?"),
                        WatchAlertTree(element: "nested alert", isAlert: true, identifier: "Invite"),
                    ]),
                ]),
            ]),
        ])
        XCTAssertEqual(watchSystemAlerts(in: tree), ["alert"])
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
        XCTAssertTrue(response.error?.contains("retrying once after a neutral touch") == true)
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
            "touch settling", "crown 0 focused", "crown 0 focused", "crown 8",
        ])
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(source.rotations, 2)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.events, [
            "snapshot:launching", "snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 0", "tap",
            "snapshot:touch settling", "snapshot:crown 0 focused", "snapshot:crown 0 focused", "rotate",
            "snapshot:crown 8",
        ])
    }

    func testCrownRetriesUnchangedRotationAfterOneTouch() {
        let source = ScriptedCrownSource(labels: [
            "crown 0", "crown 0", "crown 0", "focused", "focused", "crown 8",
        ])
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8))
        XCTAssertTrue(response.success)
        XCTAssertEqual(source.rotations, 2)
        XCTAssertEqual(source.taps, 1)
        XCTAssertEqual(source.events, [
            "snapshot:crown 0", "snapshot:crown 0", "rotate", "snapshot:crown 0", "tap",
            "snapshot:focused", "snapshot:focused", "rotate", "snapshot:crown 8",
        ])
    }

    func testCrownBaselineStopsAfterThreeSnapshotsAndUsesLast() {
        let source = ScriptedCrownSource(labels: ["launching", "settling", "crown 0", "crown 8"])
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        XCTAssertTrue(handler.handle(Data(#"{"type":"crown","delta":2}"#.utf8)).success)
        XCTAssertEqual(source.rotations, 1)
        XCTAssertEqual(source.taps, 0)
        XCTAssertEqual(source.events, [
            "snapshot:launching", "snapshot:settling", "snapshot:crown 0", "rotate", "snapshot:crown 8",
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
                accessibilityLabel: label
            )
        )
    }

    func rotateCrown(delta _: Double, velocity _: Double) throws {
        try watchVerifiedCrownRotation(snapshots: self, wake: {
            self.taps += 1
            self.events.append("tap")
        }, rotate: {
            self.rotations += 1
            self.events.append("rotate")
        })
    }

    func tap(x _: Double, y _: Double) throws {}
    func tap(identifier _: String) throws {}
    func swipe(_: WatchSwipeDirection, distance _: Double?) throws {}
    func typeText(_: String) throws {}
    func home() throws {}
}
