@testable import AutoMobileSDK
import AutoMobileSdkWire
import Foundation
import XCTest

private actor StubObservationProvider: AutoMobileObservationProvider {
    func captureObservation() async -> AutoMobileObservationSnapshot {
        AutoMobileObservationSnapshot(
            captureIdentity: 1,
            orientation: .portrait,
            coordinateSpace: .screen,
            bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
            root: nil,
            focusedElementId: nil,
            capabilities: []
        )
    }
}

private actor StubActionExecutor: AutoMobileActionExecutor {
    func execute(_: AutoMobileAction) async -> AutoMobileActionResult {
        AutoMobileActionResult(status: .accepted)
    }
}

/// #5159: discovery of the host's observation bridge, served in `/health`.
final class ObservationRegistryTests: XCTestCase {
    private func makeBridge() -> AutoMobileObservationBridge {
        AutoMobileObservationBridge(provider: StubObservationProvider(), executor: StubActionExecutor())
    }

    func testUnregisteredBridgeReportsNotRegistered() {
        let registry = AutoMobileObservationRegistry()
        XCTAssertEqual(registry.state, ObservationBridgeState(available: false, reason: "NOT_REGISTERED"))
        XCTAssertNil(registry.bridge)
    }

    func testRegisteredBridgeReportsEveryActionKindByDefault() {
        let registry = AutoMobileObservationRegistry()
        registry.register(makeBridge())
        XCTAssertTrue(registry.state.available)
        XCTAssertNil(registry.state.reason)
        XCTAssertEqual(registry.state.supportedActions, AutoMobileActionKind.allCases.map(\.rawValue).sorted())
        XCTAssertNotNil(registry.bridge)
    }

    func testRegisteredBridgeReportsOnlyDeclaredActionKinds() {
        let registry = AutoMobileObservationRegistry()
        registry.register(makeBridge(), supportedActions: [.tap, .insertText])
        XCTAssertEqual(registry.state.supportedActions, ["insertText", "tap"])
    }

    func testUnregisterReturnsToNotRegistered() {
        let registry = AutoMobileObservationRegistry()
        registry.register(makeBridge())
        registry.unregister()
        XCTAssertEqual(registry.state, .notRegistered)
    }

    func testActionKindMatchesEveryAction() {
        let point = SdkPoint(x: 1, y: 2)
        let kinds: [AutoMobileActionKind] = [
            AutoMobileAction.tap(observationIdentity: 1, elementId: "a"),
            .longPress(observationIdentity: 1, elementId: "a", durationMs: 1),
            .swipe(observationIdentity: 1, start: point, end: point, durationMs: 1),
            .drag(observationIdentity: 1, elementId: "a", end: point, durationMs: 1),
            .pinch(observationIdentity: 1, elementId: "a", scale: 2, durationMs: 1),
            .insertText(observationIdentity: 1, elementId: "a", text: "t"),
            .clearText(observationIdentity: 1, elementId: "a"),
            .back(observationIdentity: 1),
            .scroll(observationIdentity: 1, elementId: nil, delta: point),
        ].map(\.kind)
        XCTAssertEqual(kinds, AutoMobileActionKind.allCases)
    }

    func testStateWireShapeOmitsReasonWhenAvailable() throws {
        let data = try JSONEncoder().encode(ObservationBridgeState(available: true, supportedActions: ["tap"]))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["schemaVersion"] as? Int, 1)
        XCTAssertEqual(object["available"] as? Bool, true)
        XCTAssertNil(object["reason"])
        XCTAssertEqual(object["supportedActions"] as? [String], ["tap"])
    }

    #if DEBUG && !os(watchOS)
        private final class Tracker: SdkHierarchyServing {
            let bundleId: String? = "test.bundle"
            let isApplicationActive = true
            func getLatestHierarchy() -> SdkViewHierarchy? { nil }
            func walkNow() -> SdkViewHierarchy {
                SdkViewHierarchy(screenScale: 1, screenWidth: 0, screenHeight: 0, root: nil)
            }
        }

        func testHealthCarriesTheBridgeState() throws {
            let tracker = Tracker()
            let state = ObservationBridgeState(available: true, supportedActions: ["tap", "back"])
            let server = SdkHierarchyServer(tracker: tracker, observationBridgeState: { state })
            let payload = try XCTUnwrap(
                JSONSerialization.jsonObject(with: server.healthResponse().body) as? [String: Any]
            )
            let bridge = try XCTUnwrap(payload["observationBridge"] as? [String: Any])
            XCTAssertEqual(bridge["available"] as? Bool, true)
            XCTAssertEqual(bridge["supportedActions"] as? [String], ["back", "tap"])
        }
    #endif
}
