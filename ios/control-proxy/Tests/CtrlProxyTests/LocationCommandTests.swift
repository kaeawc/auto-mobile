@testable import CtrlProxy
import Foundation
import XCTest

/// Records simulated-location calls (#14091).
@MainActor
private final class FakeLocationSimulator: LocationSimulating {
    enum Call: Equatable {
        case set(Double, Double, Double?, Double?)
        case clear
    }

    private(set) var calls: [Call] = []

    func setLocation(latitude: Double, longitude: Double, altitude: Double?, horizontalAccuracy: Double?) throws {
        calls.append(.set(latitude, longitude, altitude, horizontalAccuracy))
    }

    func clearLocation() throws {
        calls.append(.clear)
    }
}

@MainActor
final class LocationCommandTests: XCTestCase {
    private func handler(simulator: FakeLocationSimulator) -> CommandHandler {
        CommandHandler(
            elementLocator: FakeElementLocator(),
            gesturePerformer: FakeGesturePerformer(),
            perf: PerfProvider(),
            locationSimulator: simulator
        )
    }

    func testDecodesAndSetsAFix() async throws {
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"request_location","requestId":"r1","latitude":37.33,"longitude":-122.03,"altitude":12}"#.utf8
        ))
        let simulator = FakeLocationSimulator()
        let result = await handler(simulator: simulator).handle(request)
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.type, "location_result")
        XCTAssertEqual(response.requestId, "r1")
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(simulator.calls, [.set(37.33, -122.03, 12, nil)])
    }

    func testClearRestoresTheRealLocation() async throws {
        let simulator = FakeLocationSimulator()
        let result = await handler(simulator: simulator).handle(
            .location(RequestLocation(requestId: "r2", clear: true))
        )
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(simulator.calls, [.clear])
    }

    func testRejectsOutOfRangeCoordinatesWithoutSetting() async throws {
        let simulator = FakeLocationSimulator()
        let result = await handler(simulator: simulator).handle(
            .location(RequestLocation(requestId: "r3", latitude: 91, longitude: 0))
        )
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.type, "location_result")
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(simulator.calls, [])
    }

    func testRejectsAMissingLongitude() async throws {
        let simulator = FakeLocationSimulator()
        let result = await handler(simulator: simulator).handle(
            .location(RequestLocation(requestId: "r4", latitude: 10))
        )
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(simulator.calls, [])
    }
}
