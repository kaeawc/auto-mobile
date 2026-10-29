@testable import AutoMobileSDK
import AutoMobileSdkWire
import Foundation
import XCTest

#if DEBUG && !os(watchOS)
    private actor FixedProvider: AutoMobileObservationProvider {
        let snapshot: AutoMobileObservationSnapshot
        init(_ snapshot: AutoMobileObservationSnapshot) { self.snapshot = snapshot }
        func captureObservation() async -> AutoMobileObservationSnapshot { snapshot }
    }

    private actor CountingExecutor: AutoMobileActionExecutor {
        private(set) var calls = 0
        func execute(_: AutoMobileAction) async -> AutoMobileActionResult {
            calls += 1
            return AutoMobileActionResult(status: .accepted, durationMs: 3)
        }
    }

    /// #5159: the observation routes serve the registered bridge and fail closed with typed errors.
    final class SdkObservationRouteHandlerTests: XCTestCase {
        private let snapshot = AutoMobileObservationSnapshot(
            captureIdentity: 7,
            orientation: .portrait,
            coordinateSpace: .screen,
            bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 200),
            root: AutoMobileObservationNode(
                id: "root", role: "window", bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 200),
                children: [
                    AutoMobileObservationNode(
                        id: "submit", role: "button", label: "Submit",
                        bounds: SdkBounds(left: 10, top: 10, right: 90, bottom: 40)
                    ),
                    AutoMobileObservationNode(
                        id: "disabled", role: "button", bounds: SdkBounds(left: 10, top: 50, right: 90, bottom: 80),
                        enabled: false
                    ),
                ]
            )
        )

        private func handler(
            supportedActions: Set<AutoMobileActionKind> = Set(AutoMobileActionKind.allCases),
            executor: CountingExecutor = CountingExecutor()
        )
            -> SdkObservationRouteHandler
        {
            let registry = AutoMobileObservationRegistry()
            registry.register(
                AutoMobileObservationBridge(provider: FixedProvider(snapshot), executor: executor),
                supportedActions: supportedActions
            )
            return SdkObservationRouteHandler(registry: registry)
        }

        private func body(_ action: AutoMobileAction) throws -> Data {
            try JSONEncoder().encode(action)
        }

        private func result(_ response: SdkRouteResponse) throws -> AutoMobileActionResult {
            XCTAssertEqual(response.statusCode, 200)
            return try JSONDecoder().decode(AutoMobileActionResult.self, from: response.body)
        }

        func testSnapshotReturnsTheBridgeObservation() async throws {
            let response = await handler().observe()
            XCTAssertEqual(response.statusCode, 200)
            XCTAssertEqual(try JSONDecoder().decode(AutoMobileObservationSnapshot.self, from: response.body), snapshot)
        }

        func testMissingBridgeAnswers503() async {
            let unregistered = SdkObservationRouteHandler(registry: AutoMobileObservationRegistry())
            let snapshotResponse = await unregistered.observe()
            XCTAssertEqual(snapshotResponse.statusCode, 503)
            XCTAssertEqual(String(data: snapshotResponse.body, encoding: .utf8), #"{"error":"bridge_not_registered"}"#)
            let action = try? body(.back(observationIdentity: 7))
            let actionResponse = await unregistered.perform(body: action)
            XCTAssertEqual(actionResponse.statusCode, 503)
        }

        func testUndecodableActionAnswers400() async {
            let response = await handler().perform(body: Data(#"{"fly":{}}"#.utf8))
            XCTAssertEqual(response.statusCode, 400)
            let empty = await handler().perform(body: nil)
            XCTAssertEqual(empty.statusCode, 400)
        }

        func testAcceptedActionCarriesTheNextObservationIdentity() async throws {
            let executor = CountingExecutor()
            let routes = handler(executor: executor)
            _ = await routes.observe()
            let response = try await routes.perform(body: body(.tap(observationIdentity: 7, elementId: "submit")))
            let outcome = try result(response)
            XCTAssertEqual(outcome.status, .accepted)
            XCTAssertEqual(outcome.nextObservationIdentity, 7)
            let calls = await executor.calls
            XCTAssertEqual(calls, 1)
        }

        func testStaleAndUnactionableResultsPassThroughWithoutExecuting() async throws {
            let executor = CountingExecutor()
            let routes = handler(executor: executor)
            _ = await routes.observe()
            let stale = try await result(routes.perform(body: body(.tap(observationIdentity: 6, elementId: "submit"))))
            XCTAssertEqual(stale.reason, "stale_observation")
            let disabled = try await result(
                routes.perform(body: body(.tap(observationIdentity: 7, elementId: "disabled")))
            )
            XCTAssertEqual(disabled.reason, "element_not_actionable")
            let calls = await executor.calls
            XCTAssertEqual(calls, 0)
        }

        func testUndeclaredActionKindIsRejectedAsUnsupportedWithoutExecuting() async throws {
            let executor = CountingExecutor()
            let routes = handler(supportedActions: [.tap], executor: executor)
            let outcome = try await result(routes.perform(body: body(.back(observationIdentity: 7))))
            XCTAssertEqual(outcome.status, .rejected)
            XCTAssertEqual(outcome.reason, "unsupported_action")
            let calls = await executor.calls
            XCTAssertEqual(calls, 0)
        }
    }
#endif
