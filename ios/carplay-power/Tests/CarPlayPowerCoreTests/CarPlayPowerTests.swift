@testable import CarPlayPowerCore
import Foundation
import XCTest

private final class FakeScreenBackend: SimulatorScreenBackend {
    var calls: [String] = []
    var failure: CarPlayPowerError?
    var failureStep: String?
    var device = SimulatorDevice(runtimeVersion: "26.5", dataPath: "/sim/data")
    var before: [SimulatorScreen] = [FakeScreenBackend.lcd, FakeScreenBackend.tvOut(power: 0)]
    var after: [SimulatorScreen] = [FakeScreenBackend.lcd, FakeScreenBackend.tvOut(power: 1)]
    var written: [String: Data] = [:]
    private var enumerations = 0

    static let lcd = SimulatorScreen(id: 1, name: "LCD", screenType: 0, powerState: 1, width: 1206, height: 2622)
    static let wireless = SimulatorScreen(
        id: 3,
        name: "Wireless",
        screenType: 2,
        powerState: 0,
        width: 720,
        height: 480
    )

    // Measured on an iOS 26.5 iPhone simulator: TVOut is id 2, type 1, 720x480 until the mode change.
    static func tvOut(power: Int32, id: UInt32 = 2) -> SimulatorScreen {
        SimulatorScreen(
            id: id, name: "TVOut", screenType: 1, powerState: power,
            width: power == 1 ? 800 : 720, height: 480
        )
    }

    private func record(_ call: String) throws {
        calls.append(call)
        if let failure, failureStep == nil || failureStep == call { throw failure }
    }

    func selectBootedDevice(udid: String) throws -> SimulatorDevice {
        try record("select:\(udid)")
        return device
    }

    func screens() throws -> [SimulatorScreen] {
        try record("enumerate")
        enumerations += 1
        return enumerations == 1 ? before : after
    }

    func writeFile(_ data: Data, path: String) throws {
        try record("write")
        written[path] = data
    }

    func setCarPlayMode(screenID: UInt32, width: Double, height: Double) throws {
        try record("mode:\(screenID):\(Int(width))x\(Int(height))")
    }
}

final class CarPlayPowerTests: XCTestCase {
    func testPowerOnWritesStarkConfigThenSetsTVOutModeAndVerifies() throws {
        let backend = FakeScreenBackend()
        // Selection is by the TVOut name, not the incidental id 2 or the Wireless screen.
        backend.before = [FakeScreenBackend.wireless, FakeScreenBackend.tvOut(power: 0, id: 7)]
        backend.after = [FakeScreenBackend.wireless, FakeScreenBackend.tvOut(power: 1, id: 7)]
        let result = try CarPlayPowerController(backend: backend).run(udid: "device", powerOn: true)
        XCTAssertEqual(backend.calls, ["select:device", "enumerate", "write", "mode:7:800x480", "enumerate"])
        XCTAssertEqual(result.carPlay, CarPlayState(found: true, screenID: 7, powerState: 1))
        let path = "/sim/data/Library/Application Support/Simulator/extended_display.plist"
        let plist = try XCTUnwrap(backend.written[path])
        let config = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any]
        )
        XCTAssertEqual(config["stark"] as? Bool, true)
        XCTAssertEqual(config["hasTouchScreen"] as? Bool, true)
        XCTAssertEqual(config["width"] as? Int, 800)
        XCTAssertEqual(config["height"] as? Int, 480)
        XCTAssertEqual(config["scale"] as? Int, 2)
        for key in ["hasTouchScreenLofi", "hasHomeButton", "hasBackButton", "hasWheel", "hasWheelBump"] {
            XCTAssertEqual(config[key] as? Bool, false, key)
        }
        XCTAssertEqual((config["protocols"] as? [Any])?.count, 0)
    }

    func testRefusesIOS27RuntimesBeforeTouchingScreens() {
        for version in ["27.0", "27.1", "28.0", "unknown"] {
            let backend = FakeScreenBackend()
            backend.device = SimulatorDevice(runtimeVersion: version, dataPath: "/d")
            XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
                let error = $0 as? CarPlayPowerError
                XCTAssertEqual(error?.code, .unsupportedRuntime)
                XCTAssertTrue(error?.message.contains("found \(version)") == true)
            }
            XCTAssertEqual(backend.calls, ["select:d"])
        }
    }

    func testStatusDoesNotMutateAndWorksOnAnyRuntime() throws {
        let backend = FakeScreenBackend()
        backend.device = SimulatorDevice(runtimeVersion: "27.0", dataPath: "/d")
        let state = try CarPlayPowerController(backend: backend).run(udid: "device", powerOn: false)
        XCTAssertEqual(backend.calls, ["select:device", "enumerate"])
        XCTAssertEqual(state.carPlay, CarPlayState(found: true, screenID: 2, powerState: 0))
    }

    func testStatusEncodesNullUnknownsWithoutTVOut() throws {
        let backend = FakeScreenBackend()
        backend.before = [FakeScreenBackend.lcd, FakeScreenBackend.wireless]
        let state = try CarPlayPowerController(backend: backend).run(udid: "device", powerOn: false)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
        let carPlay = try XCTUnwrap(json["carPlay"] as? [String: Any])
        XCTAssertEqual(Set(carPlay.keys), ["found", "screenID", "powerState"])
        XCTAssertEqual(carPlay["found"] as? Bool, false)
        XCTAssertTrue(carPlay["screenID"] is NSNull)
        XCTAssertTrue(carPlay["powerState"] is NSNull)
    }

    func testMissingTVOutScreen() {
        let backend = FakeScreenBackend()
        backend.before = [FakeScreenBackend.lcd, FakeScreenBackend.wireless]
        XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
            XCTAssertEqual(($0 as? CarPlayPowerError)?.code, .noCarPlayScreen)
        }
        XCTAssertEqual(backend.calls, ["select:d", "enumerate"])
    }

    func testRequiresVerifiedPowerOnSameTVOutScreen() {
        for screens in [[FakeScreenBackend.tvOut(power: 0)], [], [FakeScreenBackend.tvOut(power: 1, id: 4)]] {
            let backend = FakeScreenBackend()
            backend.after = screens
            XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
                XCTAssertEqual(($0 as? CarPlayPowerError)?.code, .powerOnFailed)
            }
            XCTAssertEqual(backend.calls, ["select:d", "enumerate", "write", "mode:2:800x480", "enumerate"])
        }
    }

    func testStopsAtTheFailedStep() {
        let expected = ["select:d", "enumerate", "write", "mode:2:800x480"]
        for step in expected {
            let backend = FakeScreenBackend()
            let failure = CarPlayPowerError(.powerOnFailed, "backend refused")
            backend.failure = failure
            backend.failureStep = step
            XCTAssertThrowsError(try CarPlayPowerController(backend: backend).run(udid: "d", powerOn: true)) {
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

private final class FakeHIDBackend: CarPlayHIDBackend {
    var calls: [String] = []
    var failure: CarPlayPowerError?
    var failureStep: String?

    private func record(_ call: String) throws {
        calls.append(call)
        if let failure, failureStep == call { throw failure }
    }

    func createCarPlayService() throws {
        try record("create")
    }

    func sendTouch(_ phase: CarPlayTouchPhase, target: UInt32, x: Double, y: Double, width: Double, height: Double)
        throws
    {
        try record("\(phase):\(target):\(Int(x)),\(Int(y)):\(Int(width))x\(Int(height))")
    }

    func hold(milliseconds: Int) {
        calls.append("hold:\(milliseconds)")
    }
}

final class CarPlayTapTests: XCTestCase {
    private func controller(_ screens: FakeScreenBackend, _ hid: FakeHIDBackend) -> CarPlayTapController {
        CarPlayTapController(screens: screens, hid: hid)
    }

    private func poweredScreens() -> FakeScreenBackend {
        let screens = FakeScreenBackend()
        screens.before = [FakeScreenBackend.lcd, FakeScreenBackend.wireless, FakeScreenBackend.tvOut(power: 1)]
        return screens
    }

    func testCarScreenTypesUseTheCarPlayServiceTargetAndOthersHaveNone() {
        XCTAssertEqual(CarPlayHID.target(screenType: 1), 1)
        XCTAssertEqual(CarPlayHID.target(screenType: 2), 1)
        for screenType: UInt64 in [0, 3, 4, 5] {
            XCTAssertNil(CarPlayHID.target(screenType: screenType), "screenType \(screenType)")
        }
    }

    func testTapCreatesTheServiceThenSendsDownAndUpToTargetOneInCarPixels() throws {
        let screens = poweredScreens()
        let hid = FakeHIDBackend()
        let result = try controller(screens, hid).tap(udid: "d", x: 558, y: 80)
        XCTAssertEqual(screens.calls, ["select:d", "enumerate"])
        XCTAssertEqual(hid.calls, ["create", "down:1:558,80:800x480", "hold:80", "up:1:558,80:800x480"])
        XCTAssertEqual(result.tapped, CarPlayTap(
            x: 558, y: 80, screenID: 2, screenType: 1, target: 1, width: 800, height: 480
        ))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any])
        let tapped = try XCTUnwrap(json["tapped"] as? [String: Any])
        XCTAssertEqual(Set(tapped.keys), ["x", "y", "screenID", "screenType", "target", "width", "height"])
    }

    func testRefusesWithoutSendingAnything() {
        let cases: [(String, (FakeScreenBackend) -> Void, Double, Double, CarPlayErrorCode)] = [
            ("iOS 27", { $0.device = SimulatorDevice(runtimeVersion: "27.0", dataPath: "/d") }, 1, 1, .unsupportedRuntime),
            ("iOS 18", { $0.device = SimulatorDevice(runtimeVersion: "18.6", dataPath: "/d") }, 1, 1, .unsupportedRuntime),
            ("no TVOut", { $0.before = [FakeScreenBackend.lcd, FakeScreenBackend.wireless] }, 1, 1, .noCarPlayScreen),
            ("powered off", { $0.before = [FakeScreenBackend.tvOut(power: 0)] }, 1, 1, .carPlayNotPowered),
            ("external display type", {
                $0.before = [SimulatorScreen(id: 2, name: "TVOut", screenType: 3, powerState: 1, width: 800, height: 480)]
            }, 1, 1, .unsupportedScreenType),
            ("x at width", { _ in }, 800, 1, .usage),
            ("negative y", { _ in }, 1, -1, .usage),
            ("NaN", { _ in }, .nan, 1, .usage),
        ]
        for (name, configure, x, y, code) in cases {
            let screens = poweredScreens()
            configure(screens)
            let hid = FakeHIDBackend()
            XCTAssertThrowsError(try controller(screens, hid).tap(udid: "d", x: x, y: y), name) {
                XCTAssertEqual(($0 as? CarPlayPowerError)?.code, code, name)
            }
            XCTAssertEqual(hid.calls, [], name)
        }
    }

    func testStopsAtTheFailedHIDStep() {
        let steps = ["create", "down:1:10,10:800x480", "up:1:10,10:800x480"]
        for step in steps {
            let hid = FakeHIDBackend()
            let failure = CarPlayPowerError(.hidFailed, "simulator refused")
            hid.failure = failure
            hid.failureStep = step
            XCTAssertThrowsError(try controller(poweredScreens(), hid).tap(udid: "d", x: 10, y: 10)) {
                XCTAssertEqual($0 as? CarPlayPowerError, failure)
            }
            XCTAssertEqual(hid.calls.last, step)
        }
    }
}
