@testable import CarPlayPowerCore
import Foundation
import XCTest

private final class FakeScreenBackend: SimulatorScreenBackend {
    var calls: [String] = []
    var failure: CarPlayPowerError?
    var failureStep: String?
    var before: [SimulatorScreen] = [FakeScreenBackend.screen(power: 0)]
    var after: [SimulatorScreen] = [FakeScreenBackend.screen(power: 1)]
    private var enumerations = 0

    static func screen(power: Int32, id: UInt32 = 3, type: UInt64 = 2) -> SimulatorScreen {
        SimulatorScreen(id: id, name: "Wireless", screenType: type, powerState: power, width: 720, height: 480)
    }

    private func record(_ call: String) throws {
        calls.append(call)
        if let failure, failureStep == nil || failureStep == call { throw failure }
    }

    func selectBootedDevice(udid: String) throws { try record("select:\(udid)") }
    func enableCarPlay() throws { try record("enable") }
    func settle() throws { try record("settle") }
    func screens() throws -> [SimulatorScreen] {
        try record("enumerate")
        enumerations += 1
        return enumerations == 1 ? before : after
    }

    func powerOn(screenID: UInt32) throws { try record("power:\(screenID)") }
}

final class CarPlayPowerTests: XCTestCase {
    func testEnableSettlePowerVerifyOrdering() throws {
        let backend = FakeScreenBackend()
        // Selection is by type, not the incidental id 3 in the reference capture.
        backend.before = [FakeScreenBackend.screen(power: 0, id: 7)]
        backend.after = [FakeScreenBackend.screen(power: 1, id: 7)]
        let result = try CarPlayPowerController(backend: backend).run(udid: "device", powerOn: true, enable: true)
        XCTAssertEqual(backend.calls, ["select:device", "enable", "settle", "enumerate", "power:7", "enumerate"])
        XCTAssertEqual(result.carPlay.powerState, 1)
        XCTAssertEqual(result.carPlay.enabled, true)
    }

    func testStatusDoesNotMutateAndEncodesNullUnknowns() throws {
        let backend = FakeScreenBackend()
        backend.before = []
        let state = try CarPlayPowerController(backend: backend).run(udid: "device", powerOn: false)
        XCTAssertEqual(backend.calls, ["select:device", "enumerate"])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
        let carPlay = try XCTUnwrap(json["carPlay"] as? [String: Any])
        XCTAssertEqual(carPlay["found"] as? Bool, false)
        XCTAssertTrue(carPlay["powerState"] is NSNull)
        XCTAssertTrue(carPlay["enabled"] is NSNull)
    }

    func testMissingCarPlayScreen() {
        let backend = FakeScreenBackend()
        backend.before = [FakeScreenBackend.screen(power: 0, type: 0)]
        XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
            XCTAssertEqual(($0 as? CarPlayPowerError)?.code, .noCarPlayScreen)
        }
        XCTAssertEqual(backend.calls, ["select:d", "enumerate"])
    }

    func testRequiresVerifiedPowerOnSameCarPlayScreen() {
        for screens in [[FakeScreenBackend.screen(power: 0)], [], [FakeScreenBackend.screen(power: 1, id: 4)]] {
            let backend = FakeScreenBackend()
            backend.after = screens
            XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
                XCTAssertEqual(($0 as? CarPlayPowerError)?.code, .powerOnFailed)
            }
            XCTAssertEqual(backend.calls, ["select:d", "enumerate", "power:3", "enumerate"])
        }
    }

    func testStopsAtFailedEnableEnumerationOrPowerCallback() {
        let expected = ["select:d", "enable", "settle", "enumerate", "power:3"]
        for step in ["enable", "settle", "enumerate", "power:3"] {
            let backend = FakeScreenBackend()
            let failure = CarPlayPowerError(.powerOnFailed, "backend refused")
            backend.failure = failure
            backend.failureStep = step
            XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(
                udid: "d", powerOn: true, enable: true
            )) {
                XCTAssertEqual($0 as? CarPlayPowerError, failure)
            }
            XCTAssertEqual(backend.calls, Array(expected.prefix(while: { $0 != step })) + [step])
        }
    }

    func testEveryErrorCodePropagatesAndEncodes() throws {
        for code in CarPlayErrorCode.allCases {
            let backend = FakeScreenBackend()
            let failure = CarPlayPowerError(code, "remedy")
            backend.failure = failure
            XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
                XCTAssertEqual($0 as? CarPlayPowerError, failure)
            }
            let data = try JSONEncoder().encode(CarPlayErrorResponse(error: failure))
            XCTAssertEqual(try JSONDecoder().decode(CarPlayErrorResponse.self, from: data).error, failure)
        }
    }

    func testScreenJSONShapeAndRoundTrip() throws {
        let state = try CarPlayPowerController(backend: FakeScreenBackend()).run(udid: "d", powerOn: false)
        let data = try JSONEncoder().encode(state)
        XCTAssertEqual(try JSONDecoder().decode(CarPlayPowerState.self, from: data), state)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["screens", "carPlay"])
        let screens = try XCTUnwrap(json["screens"] as? [[String: Any]])
        XCTAssertEqual(
            try Set(XCTUnwrap(screens.first).keys),
            ["id", "name", "screenType", "powerState", "width", "height"]
        )
    }
}
