@testable import CtrlProxy
import XCTest

final class FrameContextSafetyTests: XCTestCase {
    private var fakeElementLocator: FakeElementLocator!
    private var fakeGesturePerformer: FakeGesturePerformer!
    private var frameContext: FrameContext!
    private var commandHandler: CommandHandler!

    override func setUp() {
        super.setUp()
        fakeElementLocator = FakeElementLocator()
        fakeGesturePerformer = FakeGesturePerformer()
        frameContext = FrameContext()
        commandHandler = CommandHandler.createForTesting(
            elementLocator: fakeElementLocator,
            gesturePerformer: fakeGesturePerformer,
            perfProvider: PerfProvider.createForTesting(timeProvider: FakeTimeProvider(initialTime: 0)),
            frameContext: frameContext
        )
    }

    func testContextsFromSeparateProcessesCannotMatch() {
        let hierarchy = makeHierarchy(text: "A")
        let restartedProcess = FrameContext()

        XCTAssertNotEqual(
            frameContext.context(for: hierarchy),
            restartedProcess.context(for: hierarchy)
        )
    }

    func testScreenshotContextIsAbsentAfterABATransitionDuringCapture() {
        let screenA = makeHierarchy(text: "A")
        let screenB = makeHierarchy(text: "B")
        fakeElementLocator.setHierarchy(screenA)
        fakeGesturePerformer.onScreenshot = { [frameContext] in
            frameContext?.recordTransition(to: screenB)
            frameContext?.recordTransition(to: screenA)
        }

        // Correlation is opt-in via a supplied frameContext; the ABA transition during capture
        // still makes the before/after contexts disagree, so the paired context is withheld.
        let response = commandHandler.handle(
            .requestScreenshot(RequestEnvelope(requestId: "capture", frameContext: "correlate"))
        ) as? ScreenshotResponse

        XCTAssertNil(response?.frameContext)
    }

    func testScreenshotWithoutRequestedContextSkipsExtractionAndReturnsNilContext() {
        let screenA = makeHierarchy(text: "A")
        fakeElementLocator.setHierarchy(screenA)

        let response = commandHandler
            .handle(.requestScreenshot(RequestEnvelope(requestId: "capture"))) as? ScreenshotResponse

        XCTAssertNotNil(response?.data)
        XCTAssertNil(response?.frameContext)
        // Opt-out means neither the before nor the after hierarchy is walked.
        XCTAssertEqual(fakeElementLocator.hierarchyRequestCount, 0)
    }

    func testScreenshotWithRequestedContextPairsStableScreen() {
        let screenA = makeHierarchy(text: "A")
        fakeElementLocator.setHierarchy(screenA)

        let response = commandHandler.handle(
            .requestScreenshot(RequestEnvelope(requestId: "capture", frameContext: "correlate"))
        ) as? ScreenshotResponse

        // No transition during capture, so the before/after contexts agree and one is returned.
        XCTAssertNotNil(response?.frameContext)
        XCTAssertEqual(response?.frameContext, frameContext.context(for: screenA))
    }

    func testContextlessGesturePerformsNoHierarchyExtraction() {
        fakeElementLocator.setHierarchy(makeHierarchy(text: "A"))

        let response = commandHandler.handle(.tapCoordinates(RequestTapCoordinates(
            requestId: "tap",
            x: 10,
            y: 20,
            frameContext: nil
        ))) as? WebSocketResponse

        XCTAssertEqual(response?.success, true)
        XCTAssertEqual(fakeGesturePerformer.getTapHistory().count, 1)
        // No expected context means no staleness check, so the hierarchy is never extracted.
        XCTAssertEqual(fakeElementLocator.hierarchyRequestCount, 0)
    }

    func testContextBearingGesturePerformsExactlyOneHierarchyExtraction() {
        let screenA = makeHierarchy(text: "A")
        let expected = frameContext.context(for: screenA)
        fakeElementLocator.setHierarchy(screenA)

        let response = commandHandler.handle(.tapCoordinates(RequestTapCoordinates(
            requestId: "tap",
            x: 10,
            y: 20,
            frameContext: expected
        ))) as? WebSocketResponse

        XCTAssertEqual(response?.success, true)
        XCTAssertEqual(fakeGesturePerformer.getTapHistory().count, 1)
        // The redundant pre-check is gone: the dispatch boundary extracts the hierarchy once.
        XCTAssertEqual(fakeElementLocator.hierarchyRequestCount, 1)
    }

    func testContextBearingGesturesRevalidateAtDispatchBoundary() {
        let screenA = makeHierarchy(text: "A")
        let screenB = makeHierarchy(text: "B")
        let expected = frameContext.context(for: screenA)
        let requests: [WebSocketRequest] = [
            .tapCoordinates(RequestTapCoordinates(
                requestId: "tap",
                x: 10,
                y: 20,
                frameContext: expected
            )),
            .swipe(RequestSwipe(
                requestId: "swipe",
                x1: 10,
                y1: 20,
                x2: 30,
                y2: 40,
                frameContext: expected
            )),
            .drag(RequestDrag(
                requestId: "drag",
                x1: 10,
                y1: 20,
                x2: 30,
                y2: 40,
                frameContext: expected
            )),
            .appendText(RequestAppendText(
                requestId: "append",
                text: "a",
                frameContext: expected
            )),
            .pressButton(RequestPressButton(
                requestId: "button",
                action: "volume_up",
                frameContext: expected
            )),
            .pressHome(RequestEnvelope(
                requestId: "home",
                frameContext: expected
            )),
            .pressBack(RequestEnvelope(
                requestId: "back",
                frameContext: expected
            )),
            .recentApps(RequestEnvelope(
                requestId: "recent",
                frameContext: expected
            )),
        ]

        for request in requests {
            // `expected` was computed from screen A, but the screen has since transitioned to B.
            // The single dispatch-boundary extraction now sees B, so the hash mismatch rejects
            // the stale context and the gesture never executes.
            fakeElementLocator.setHierarchy(screenB)
            let response = commandHandler.handle(request) as? WebSocketResponse
            XCTAssertEqual(response?.success, false)
        }

        XCTAssertTrue(fakeGesturePerformer.getTapHistory().isEmpty)
        XCTAssertTrue(fakeGesturePerformer.getSwipeHistory().isEmpty)
        XCTAssertTrue(fakeGesturePerformer.getDragHistory().isEmpty)
        XCTAssertTrue(fakeGesturePerformer.getAppendTextHistory().isEmpty)
        XCTAssertTrue(fakeGesturePerformer.getPressButtonHistory().isEmpty)
        XCTAssertEqual(fakeGesturePerformer.getPressHomeCallCount(), 0)
        XCTAssertEqual(fakeGesturePerformer.getPressBackCallCount(), 0)
        XCTAssertEqual(fakeGesturePerformer.getOpenRecentAppsCallCount(), 0)
    }

    func testTransitionQueuedBeforeGestureExecutionRejectsStaleContext() {
        let screenA = makeHierarchy(text: "A")
        let screenB = makeHierarchy(text: "B")
        let executor = TestFrameContextMainExecutor()
        let frameContext = FrameContext(epoch: UUID(), mainThreadExecutor: executor)
        let expected = frameContext.context(for: screenA)
        var operationCalled = false

        executor.enqueue {
            frameContext.recordTransition(to: screenB)
        }

        XCTAssertThrowsError(
            try frameContext.performIfCurrent(
                expected: expected,
                hierarchy: screenA
            ) {
                operationCalled = true
            }
        )
        XCTAssertFalse(operationCalled)
        executor.drain()
    }

    func testTransitionContextKeepsItsOriginalGenerationAfterDelayedBroadcast() {
        let screenA = makeHierarchy(text: "A")
        let screenB = makeHierarchy(text: "B")
        let delayedBroadcastContext = frameContext.recordTransition(to: screenA)

        frameContext.recordTransition(to: screenB)
        frameContext.recordTransition(to: screenA)

        XCTAssertNotEqual(delayedBroadcastContext, frameContext.context(for: screenA))
    }

    private func makeHierarchy(text: String) -> ViewHierarchy {
        ViewHierarchy(
            packageName: "com.example.app",
            hierarchy: UIElementInfo(text: text)
        )
    }
}

private final class TestFrameContextMainExecutor: FrameContextMainExecuting {
    private let queue = DispatchQueue(label: "FrameContextSafetyTests.main")
    private let key = DispatchSpecificKey<UUID>()
    private let identifier = UUID()

    init() {
        queue.setSpecific(key: key, value: identifier)
    }

    func perform<T>(_ operation: () throws -> T) throws -> T {
        if DispatchQueue.getSpecific(key: key) == identifier {
            return try operation()
        }

        var result: Result<T, Error>?
        withoutActuallyEscaping(operation) { operation in
            queue.sync {
                result = Result { try operation() }
            }
        }
        guard let result else {
            preconditionFailure("Frame-context executor did not return a result")
        }
        return try result.get()
    }

    func enqueue(_ operation: @escaping () -> Void) {
        queue.async(execute: operation)
    }

    func drain() {
        queue.sync {}
    }
}
