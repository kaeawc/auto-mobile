@testable import CarPlayPowerCore
import Foundation
import XCTest

private final class FakeScreenBackend: SimulatorScreenBackend {
    var calls: [String] = []
    var failure: CarPlayPowerError?
    var failureCallIndex = 0
    var runtimeMajor = 26
    var before: [SimulatorScreen] = [FakeScreenBackend.tvOut(power: 0, width: 720)]
    var after: [SimulatorScreen] = [FakeScreenBackend.tvOut(power: 1)]
    private var enumerations = 0

    static let wireless = SimulatorScreen(
        id: 3, name: "Wireless", screenType: 2, powerState: 1, width: 800, height: 480
    )

    static func tvOut(power: Int32, id: UInt32 = 2, width: Double = 800, height: Double = 480) -> SimulatorScreen {
        SimulatorScreen(id: id, name: "TVOut", screenType: 1, powerState: power, width: width, height: height)
    }

    private func record(_ call: String) throws {
        calls.append(call)
        if let failure, calls.count - 1 == failureCallIndex { throw failure }
    }

    func selectBootedDevice(udid: String) throws { try record("select:\(udid)") }

    func iOSRuntimeMajorVersion() throws -> Int {
        try record("runtime")
        return runtimeMajor
    }

    func writeStarkConfig(width: Int, height: Int) throws { try record("writeStarkConfig:\(width)x\(height)") }

    func screens() throws -> [SimulatorScreen] {
        try record("enumerate")
        enumerations += 1
        return enumerations == 1 ? before : after
    }

    func configureCarPlay(screenID: UInt32, width: Int, height: Int) throws {
        try record("configure:\(screenID):\(width)x\(height)")
    }

    func powerOn(screenID: UInt32) throws { try record("power:\(screenID)") }
}

final class CarPlayPowerTests: XCTestCase {
    private let powerOnCalls = [
        "select:d", "runtime", "writeStarkConfig:800x480", "enumerate", "configure:2:800x480", "power:2", "enumerate",
    ]

    func testConfiguresAndPowersTVOutInOrder() throws {
        let backend = FakeScreenBackend()
        backend.before = [FakeScreenBackend.wireless, FakeScreenBackend.tvOut(power: 0, id: 7, width: 720)]
        backend.after = [FakeScreenBackend.wireless, FakeScreenBackend.tvOut(power: 1, id: 7)]
        let result = try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)
        XCTAssertEqual(backend.calls, [
            "select:d", "runtime", "writeStarkConfig:800x480", "enumerate", "configure:7:800x480", "power:7",
            "enumerate",
        ])
        XCTAssertEqual(result.screens, backend.after)
        XCTAssertEqual(result.carPlay, CarPlayState(found: true, powerState: 1))
    }

    func testRefusesNewerRuntimesBeforeWritingConfig() {
        for major in [27, 28] {
            let backend = FakeScreenBackend()
            backend.runtimeMajor = major
            XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
                XCTAssertEqual(($0 as? CarPlayPowerError)?.code, .unsupportedRuntime)
            }
            XCTAssertEqual(backend.calls, ["select:d", "runtime"])
        }
    }

    func testOlderRuntimeProceedsThroughPowerOn() throws {
        let backend = FakeScreenBackend()
        backend.runtimeMajor = 18
        _ = try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)
        XCTAssertEqual(backend.calls, powerOnCalls)
    }

    func testStatusOnIOS27ReportsTVOutWithoutMutating() throws {
        let backend = FakeScreenBackend()
        backend.runtimeMajor = 27
        backend.before.insert(FakeScreenBackend.wireless, at: 0)
        let state = try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: false)
        XCTAssertEqual(backend.calls, ["select:d", "enumerate"])
        XCTAssertEqual(state.carPlay, CarPlayState(found: true, powerState: 0))
    }

    func testStatusWithoutTVOutEncodesNullPowerState() throws {
        let backend = FakeScreenBackend()
        backend.before = [FakeScreenBackend.wireless]
        let state = try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: false)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
        let carPlay = try XCTUnwrap(json["carPlay"] as? [String: Any])
        XCTAssertEqual(Set(carPlay.keys), ["found", "powerState"])
        XCTAssertEqual(carPlay["found"] as? Bool, false)
        XCTAssertTrue(carPlay["powerState"] is NSNull)
    }

    func testMissingTVOutStopsBeforeConfiguration() {
        let backend = FakeScreenBackend()
        backend.before = [FakeScreenBackend.wireless]
        XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
            XCTAssertEqual(($0 as? CarPlayPowerError)?.code, .noCarPlayScreen)
        }
        XCTAssertEqual(backend.calls, Array(powerOnCalls.prefix(4)))
    }

    func testRequiresSameTVOutScreenPoweredAtExpectedSize() {
        let unverifiedScreens: [[SimulatorScreen]] = [
            [FakeScreenBackend.tvOut(power: 0)],
            [FakeScreenBackend.tvOut(power: 1, width: 720)],
            [FakeScreenBackend.tvOut(power: 1, height: 400)],
            [FakeScreenBackend.tvOut(power: 1, id: 4)],
            [],
        ]
        for screens in unverifiedScreens {
            let backend = FakeScreenBackend()
            backend.after = screens
            XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
                XCTAssertEqual(($0 as? CarPlayPowerError)?.code, .powerOnFailed)
            }
            XCTAssertEqual(backend.calls, powerOnCalls)
        }
    }

    func testStopsAtEveryBackendFailure() {
        for index in powerOnCalls.indices {
            let backend = FakeScreenBackend()
            let failure = CarPlayPowerError(.powerOnFailed, "backend refused")
            backend.failure = failure
            backend.failureCallIndex = index
            XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
                XCTAssertEqual($0 as? CarPlayPowerError, failure)
            }
            XCTAssertEqual(backend.calls, Array(powerOnCalls.prefix(index + 1)))
        }
    }

    func testEveryErrorCodeEncodes() throws {
        for code in CarPlayErrorCode.allCases {
            let failure = CarPlayPowerError(code, "remedy")
            let data = try JSONEncoder().encode(CarPlayErrorResponse(error: failure))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: [String: String]])
            XCTAssertEqual(json, ["error": ["code": code.rawValue, "message": "remedy"]])
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
        let carPlay = try XCTUnwrap(json["carPlay"] as? [String: Any])
        XCTAssertEqual(Set(carPlay.keys), ["found", "powerState"])
        XCTAssertEqual(carPlay["found"] as? Bool, true)
        XCTAssertEqual(carPlay["powerState"] as? Int, 0)
    }
}
