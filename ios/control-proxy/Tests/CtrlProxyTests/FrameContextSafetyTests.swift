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

        let response = commandHandler.handle(.requestScreenshot(RequestEnvelope(requestId: "capture"))) as? ScreenshotResponse

        XCTAssertNil(response?.frameContext)
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
        ]

        for request in requests {
            fakeElementLocator.setHierarchy(screenA)
            fakeElementLocator.onHierarchyRead = { [fakeElementLocator] in
                fakeElementLocator?.setHierarchy(screenB)
                fakeElementLocator?.onHierarchyRead = nil
            }
            let response = commandHandler.handle(request) as? WebSocketResponse
            XCTAssertEqual(response?.success, false)
        }

        XCTAssertTrue(fakeGesturePerformer.getTapHistory().isEmpty)
        XCTAssertTrue(fakeGesturePerformer.getSwipeHistory().isEmpty)
        XCTAssertTrue(fakeGesturePerformer.getDragHistory().isEmpty)
    }

    private func makeHierarchy(text: String) -> ViewHierarchy {
        ViewHierarchy(
            packageName: "com.example.app",
            hierarchy: UIElementInfo(text: text)
        )
    }
}
