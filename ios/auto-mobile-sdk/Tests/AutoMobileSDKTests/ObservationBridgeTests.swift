import XCTest
@testable import AutoMobileSDK

private actor FakeObservationProvider: AutoMobileObservationProvider {
    private let snapshots: [AutoMobileObservationSnapshot]
    private var index = 0

    init(_ snapshots: [AutoMobileObservationSnapshot]) {
        self.snapshots = snapshots
    }

    func captureObservation() async -> AutoMobileObservationSnapshot {
        let snapshot = snapshots[min(index, snapshots.count - 1)]
        index += 1
        return snapshot
    }
}

private actor FakeActionExecutor: AutoMobileActionExecutor {
    private(set) var actions: [AutoMobileAction] = []
    private let result: AutoMobileActionResult

    init(result: AutoMobileActionResult = AutoMobileActionResult(status: .accepted)) {
        self.result = result
    }

    func execute(_ action: AutoMobileAction) async -> AutoMobileActionResult {
        actions.append(action)
        let result = self.result
        return result
    }
}

private actor ActionOrder {
    private(set) var values: [Int] = []
    func append(_ value: Int) {
        values.append(value)
    }
}

final class ObservationBridgeTests: XCTestCase {
    private func snapshot(_ identity: UInt64, nodeId: String = "button") -> AutoMobileObservationSnapshot {
        AutoMobileObservationSnapshot(
            captureIdentity: identity,
            orientation: .portrait,
            coordinateSpace: .screen,
            bounds: SdkBounds(left: 0, top: 0, right: 400, bottom: 800),
            root: AutoMobileObservationNode(
                id: "root",
                role: "window",
                bounds: SdkBounds(left: 0, top: 0, right: 400, bottom: 800),
                children: [
                    AutoMobileObservationNode(
                        id: nodeId,
                        role: "button",
                        label: "Continue",
                        bounds: SdkBounds(left: 10, top: 10, right: 100, bottom: 60)
                    ),
                ]
            ),
            focusedElementId: nil,
            capabilities: ["tap", "scroll"]
        )
    }

    func testStaleObservationFailsClosed() async {
        let provider = FakeObservationProvider([snapshot(1)])
        let executor = FakeActionExecutor()
        let bridge = AutoMobileObservationBridge(provider: provider, executor: executor)
        _ = await bridge.observe()

        let result = await bridge.perform(.tap(observationIdentity: 0, elementId: "button"))

        XCTAssertEqual(result.status, .rejected)
        XCTAssertEqual(result.reason, "stale_observation")
        let actions = await executor.actions
        XCTAssertTrue(actions.isEmpty)
    }

    func testSuccessfulActionReturnsNextObservationIdentity() async {
        let provider = FakeObservationProvider([snapshot(1), snapshot(2)])
        let executor = FakeActionExecutor()
        let bridge = AutoMobileObservationBridge(provider: provider, executor: executor)
        _ = await bridge.observe()

        let result = await bridge.perform(.tap(observationIdentity: 1, elementId: "button"))

        XCTAssertEqual(result.status, .accepted)
        XCTAssertEqual(result.nextObservationIdentity, 2)
        let actions = await executor.actions
        XCTAssertEqual(actions.count, 1)
    }

    func testUnknownElementAndUnsupportedActionAreStructuredRejections() async {
        let provider = FakeObservationProvider([snapshot(1)])
        let executor = FakeActionExecutor(
            result: AutoMobileActionResult(status: .rejected, reason: "unsupported_gesture")
        )
        let bridge = AutoMobileObservationBridge(provider: provider, executor: executor)
        _ = await bridge.observe()

        let unknown = await bridge.perform(.tap(observationIdentity: 1, elementId: "missing"))
        let unsupported = await bridge.perform(.swipe(
            observationIdentity: 1,
            start: SdkPoint(x: 0, y: 0),
            end: SdkPoint(x: 10, y: 10),
            durationMs: 100
        ))

        XCTAssertEqual(unknown.reason, "unknown_element")
        XCTAssertEqual(unsupported.reason, "unsupported_gesture")
        XCTAssertNil(unsupported.nextObservationIdentity)
    }

    func testDisabledElementIsRejectedBeforeHostExecution() async {
        let disabled = AutoMobileObservationSnapshot(
            captureIdentity: 1,
            coordinateSpace: .screen,
            bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
            root: AutoMobileObservationNode(
                id: "root",
                role: "window",
                bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
                children: [
                    AutoMobileObservationNode(
                        id: "disabled",
                        role: "button",
                        bounds: SdkBounds(left: 0, top: 0, right: 10, bottom: 10),
                        enabled: false
                    ),
                ]
            )
        )
        let provider = FakeObservationProvider([disabled])
        let executor = FakeActionExecutor()
        let bridge = AutoMobileObservationBridge(provider: provider, executor: executor)
        _ = await bridge.observe()

        let result = await bridge.perform(.tap(observationIdentity: 1, elementId: "disabled"))

        XCTAssertEqual(result.reason, "element_not_actionable")
        let actions = await executor.actions
        XCTAssertTrue(actions.isEmpty)
    }

    func testSerialQueuePreservesOrder() async {
        let order = ActionOrder()
        let queue = AutoMobileSerialActionQueue { action in
            if case let .back(identity) = action {
                await order.append(Int(identity))
            }
            return AutoMobileActionResult(status: .accepted)
        }

        _ = await queue.execute(.back(observationIdentity: 1))
        _ = await queue.execute(.back(observationIdentity: 2))

        let values = await order.values
        XCTAssertEqual(values, [1, 2])
    }
}
