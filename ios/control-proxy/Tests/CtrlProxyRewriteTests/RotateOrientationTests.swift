@testable import CtrlProxyRewrite
import XCTest

@MainActor
final class RotateOrientationTests: XCTestCase {
    private func assertRotation(
        from previous: String,
        to target: String,
        performed: Bool,
        value: Int,
        file: StaticString = #filePath,
        line: UInt = #line
    )
        async throws
    {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation(previous)
        let callsBeforeRequest = gestures.setOrientationCalls
        let timer = FakeProxyTimer(mode: .instant)
        let handler = CommandHandler(
            elementLocator: ScriptedRotateElementLocator(axes: [AppAxis.from(orientation: previous)]),
            gesturePerformer: gestures,
            perf: PerfProvider(),
            rotationTimer: timer
        )
        let result = await handler.handle(.rotate(RequestRotate(requestId: "rotate-test", orientation: target)))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertTrue(response.success, file: file, line: line)
        XCTAssertEqual(response.previousOrientation, previous, file: file, line: line)
        XCTAssertEqual(response.currentOrientation, performed ? target : previous, file: file, line: line)
        XCTAssertEqual(response.rotationPerformed, performed, file: file, line: line)
        XCTAssertEqual(response.value, value, file: file, line: line)
        XCTAssertEqual(gestures.getOrientation(), performed ? target : previous, file: file, line: line)
        XCTAssertEqual(gestures.setOrientationCalls - callsBeforeRequest, performed ? 1 : 0, file: file, line: line)
    }

    func testLandscapeLeftToRight() async throws {
        try await assertRotation(from: "landscape_left", to: "landscape_right", performed: true, value: 1)
    }

    func testSameAxisSupportedKeepsRequestedOrientation() async throws {
        try await assertRotation(from: "portrait", to: "portrait_upside_down", performed: true, value: 0)
    }

    func testSameAxisRotationSucceedsWhenOrientationUpdatesOnSecondRead() async throws {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation("landscape_left")
        gestures.orientationUpdateDelayReads = 1
        let timer = FakeProxyTimer(mode: .instant)
        let handler = CommandHandler(
            elementLocator: ScriptedRotateElementLocator(axes: [.landscape]),
            gesturePerformer: gestures,
            perf: PerfProvider(),
            rotationTimer: timer
        )
        let result = await handler.handle(.rotate(RequestRotate(
            requestId: "rotate-test", orientation: "landscape_right"
        )))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.previousOrientation, "landscape_left")
        XCTAssertEqual(response.currentOrientation, "landscape_right")
        XCTAssertEqual(response.value, 1)
        XCTAssertTrue(response.rotationPerformed)
        XCTAssertEqual(gestures.getOrientation(), "landscape_right")
        XCTAssertEqual(gestures.setOrientationCalls, 2)
        XCTAssertEqual(timer.now(), RotateDecision.pollIntervalMs)
    }

    func testSameAxisUnsupportedKeepsPreviousOrientation() async throws {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation("portrait")
        gestures.sameAxisRotationSupported = false
        let timer = FakeProxyTimer(mode: .instant)
        let handler = CommandHandler(
            elementLocator: ScriptedRotateElementLocator(axes: [.portrait]),
            gesturePerformer: gestures,
            perf: PerfProvider(),
            rotationTimer: timer
        )
        let result = await handler.handle(.rotate(RequestRotate(
            requestId: "rotate-test", orientation: "portrait_upside_down"
        )))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.error, "Rotation to portrait_upside_down is not supported on this display")
        XCTAssertEqual(response.previousOrientation, "portrait")
        XCTAssertEqual(response.currentOrientation, "portrait")
        XCTAssertEqual(response.value, 0)
        XCTAssertFalse(response.rotationPerformed)
        XCTAssertEqual(gestures.getOrientation(), "portrait")
        XCTAssertEqual(gestures.setOrientationCalls, 2)
        XCTAssertEqual(timer.now(), RotateDecision.timeoutMs)
    }

    func testLandscapeRightToLeft() async throws {
        try await assertRotation(from: "landscape_right", to: "landscape_left", performed: true, value: 1)
    }

    func testPortraitToUpsideDown() async throws {
        try await assertRotation(from: "portrait", to: "portrait_upside_down", performed: true, value: 0)
    }

    func testUpsideDownToPortrait() async throws {
        try await assertRotation(from: "portrait_upside_down", to: "portrait", performed: false, value: 0)
    }

    func testSameOrientationSkipsSetter() async throws {
        try await assertRotation(from: "landscape_left", to: "landscape_left", performed: false, value: 1)
    }

    func testUpsideDownNoOpKeepsExactOrientation() async throws {
        try await assertRotation(from: "portrait_upside_down", to: "portrait_upside_down", performed: false, value: 0)
    }

    func testUnsupportedDisplayKeepsPreviousOrientation() async throws {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation("unknown")
        gestures.rotationSupported = false
        let timer = FakeProxyTimer(mode: .instant)
        let handler = CommandHandler(
            elementLocator: ScriptedRotateElementLocator(axes: [.portrait]),
            gesturePerformer: gestures,
            perf: PerfProvider(),
            rotationTimer: timer
        )
        let result = await handler.handle(.rotate(RequestRotate(requestId: "rotate-test", orientation: "landscape")))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.error, "Rotation is not supported on this display (the screen size did not change)")
        XCTAssertEqual(response.previousOrientation, "portrait")
        XCTAssertEqual(response.currentOrientation, "portrait")
        XCTAssertEqual(timer.now(), RotateDecision.timeoutMs)
        XCTAssertFalse(response.rotationPerformed)
        let portraitResult = await handler.handle(.rotate(RequestRotate(
            requestId: "portrait-test",
            orientation: "portrait"
        )))
        let portraitResponse = try XCTUnwrap(portraitResult as? RotateResponse)
        XCTAssertTrue(portraitResponse.success)
        XCTAssertFalse(portraitResponse.rotationPerformed)
        XCTAssertEqual(gestures.setOrientationCalls, 2)
    }

    func testUnknownPortraitOnPortraitDisplayIsNoOp() async throws {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation("unknown")
        let timer = FakeProxyTimer(mode: .instant)
        let handler = CommandHandler(
            elementLocator: ScriptedRotateElementLocator(axes: [.portrait]),
            gesturePerformer: gestures,
            perf: PerfProvider(),
            rotationTimer: timer
        )
        let result = await handler.handle(.rotate(RequestRotate(requestId: "rotate-test", orientation: "portrait")))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertTrue(response.success)
        XCTAssertFalse(response.rotationPerformed)
        XCTAssertEqual(gestures.setOrientationCalls, 1)
    }

    func testFailedRotationReportsDisplayAxisWhenKnownOrientationIsStale() async throws {
        let gestures = RewriteFakeGesturePerformer()
        gestures.rotationSupported = false
        try gestures.setOrientation("landscape_left")
        let timer = FakeProxyTimer(mode: .instant)
        let handler = CommandHandler(
            elementLocator: ScriptedRotateElementLocator(axes: [.portrait]),
            gesturePerformer: gestures,
            perf: PerfProvider(),
            rotationTimer: timer
        )
        let result = await handler.handle(.rotate(RequestRotate(requestId: "rotate-test", orientation: "landscape")))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.previousOrientation, "portrait")
        XCTAssertEqual(response.currentOrientation, "portrait")
        XCTAssertFalse(response.rotationPerformed)
        XCTAssertEqual(gestures.getOrientation(), "landscape_left")
        XCTAssertEqual(gestures.setOrientationCalls, 2)
    }

    func testIssueFourCallSequenceUsesAppAxis() async throws {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation("unknown")
        let locator = ScriptedRotateElementLocator(axes: [
            .portrait, .portrait, .landscape,
            .landscape, .landscape, .portrait,
            .portrait,
            .portrait, .portrait, .landscape,
        ])
        let timer = FakeProxyTimer(mode: .instant)
        let handler = CommandHandler(
            elementLocator: locator,
            gesturePerformer: gestures,
            perf: PerfProvider(),
            rotationTimer: timer
        )
        let targets = ["landscape", "portrait", "portrait", "landscape"]
        let previous = ["portrait", "landscape_left", "portrait", "portrait"]
        let current = ["landscape_left", "portrait", "portrait", "landscape_left"]
        for index in targets.indices {
            let result = await handler.handle(.rotate(RequestRotate(
                requestId: "sequence-\(index)", orientation: targets[index]
            )))
            let response = try XCTUnwrap(result as? RotateResponse)
            XCTAssertTrue(response.success)
            XCTAssertEqual(response.previousOrientation, previous[index])
            XCTAssertEqual(response.currentOrientation, current[index])
            XCTAssertEqual(response.rotationPerformed, index != 2)
            XCTAssertEqual(response.value, targets[index] == "portrait" ? 0 : 1)
            XCTAssertEqual(gestures.setOrientationCalls, [2, 3, 3, 4][index])
            XCTAssertEqual(timer.now(), [100, 200, 200, 300][index])
            // Instant-mode time advances only on waits, so elapsed intervals count those waits.
            XCTAssertEqual(timer.now() / RotateDecision.pollIntervalMs, [1, 2, 2, 3][index])
        }
        XCTAssertEqual(locator.readCount, 10)
        XCTAssertLessThanOrEqual(timer.now(), 3 * RotateDecision.timeoutMs)
    }

    func testUnavailableAtDeadlineFallsBackToDevice() async throws {
        let gestures = RewriteFakeGesturePerformer()
        let locator = ScriptedRotateElementLocator(axes: [.portrait, nil])
        let timer = FakeProxyTimer(mode: .instant)
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: gestures, perf: PerfProvider(), rotationTimer: timer
        )
        let result = await handler.handle(.rotate(RequestRotate(
            requestId: "unavailable", orientation: "landscape"
        )))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertTrue(response.success)
        XCTAssertTrue(response.rotationPerformed)
        XCTAssertEqual(response.currentOrientation, "landscape_left")
        XCTAssertEqual(timer.now(), RotateDecision.timeoutMs)
        XCTAssertEqual(locator.readCount, 22)
        XCTAssertEqual(timer.now() / RotateDecision.pollIntervalMs, 20)
    }

    func testHierarchyErrorIsUnavailableAndUnknownStillSets() async throws {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation("unknown")
        let locator = ScriptedRotateElementLocator(axes: [nil])
        locator.throwOnRead = true
        let timer = FakeProxyTimer(mode: .instant)
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: gestures, perf: PerfProvider(), rotationTimer: timer
        )
        let result = await handler.handle(.rotate(RequestRotate(
            requestId: "error", orientation: "portrait"
        )))
        let response = try XCTUnwrap(result as? RotateResponse)
        XCTAssertTrue(response.success)
        XCTAssertTrue(response.rotationPerformed)
        XCTAssertEqual(response.previousOrientation, "unknown")
        XCTAssertEqual(gestures.setOrientationCalls, 2)
        XCTAssertEqual(timer.now(), 0)
    }

    func testRootBoundsFallbackAndInvalidScreenDimensions() async throws {
        let gestures = RewriteFakeGesturePerformer()
        try gestures.setOrientation("unknown")
        let root = RewriteFakeElementLocator.defaultHierarchy.hierarchy
        let hierarchies = [
            ViewHierarchy(updatedAt: 1, hierarchy: root),
            ViewHierarchy(updatedAt: 1, hierarchy: root, screenWidth: 0, screenHeight: 812),
            ViewHierarchy(updatedAt: 1, hierarchy: root, screenWidth: 402, screenHeight: 402),
            ViewHierarchy(updatedAt: 1),
        ]
        for (index, hierarchy) in hierarchies.enumerated() {
            try gestures.setOrientation("unknown")
            let timer = FakeProxyTimer(mode: .instant)
            let handler = CommandHandler(
                elementLocator: ScriptedRotateElementLocator(hierarchies: [hierarchy]),
                gesturePerformer: gestures, perf: PerfProvider(), rotationTimer: timer
            )
            let result = await handler.handle(.rotate(RequestRotate(requestId: "dimensions", orientation: "portrait")))
            let response = try XCTUnwrap(result as? RotateResponse)
            XCTAssertTrue(response.success)
            XCTAssertEqual(response.rotationPerformed, index != 0)
            XCTAssertEqual(timer.now(), 0)
        }
    }
}

@MainActor
private final class ScriptedRotateElementLocator: ElementLocating {
    var foregroundBundleId: String?
    var readCount = 0
    var throwOnRead = false
    private let hierarchies: [ViewHierarchy]

    init(hierarchies: [ViewHierarchy]) { self.hierarchies = hierarchies }

    convenience init(axes: [AppAxis?]) {
        self.init(hierarchies: axes.map { axis in
            guard let axis else { return ViewHierarchy(updatedAt: 1) }
            return ViewHierarchy(
                updatedAt: 1,
                screenWidth: axis == .portrait ? 402 : 874,
                screenHeight: axis == .portrait ? 874 : 402
            )
        })
    }

    func getViewHierarchy(disableAllFiltering: Bool) throws -> ViewHierarchy {
        XCTAssertFalse(disableAllFiltering)
        let index = min(readCount, hierarchies.count - 1)
        readCount += 1
        if throwOnRead { throw CommandError.invalidParameter("hierarchy", "unavailable") }
        return hierarchies[index]
    }

    func findElement(byResourceId _: String) -> Any? { nil }
    func findElement(byText _: String) -> Any? { nil }
    func findElement(byText _: String, bounds _: ElementBounds) -> Any? { nil }
    func trackObservedBundleId(_: String) {}
    func switchForegroundApp(bundleId: String) { foregroundBundleId = bundleId }
    func getAppState(bundleId _: String) -> ObservedAppState { .notRunning }
    func awaitAppState(bundleId _: String, expectedState _: AppStateExpectation) -> Bool { true }
    func refreshForegroundBundleId() -> String? { foregroundBundleId }
}
