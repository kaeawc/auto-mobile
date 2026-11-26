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

    func readFile(path: String) throws -> Data? {
        try record("read")
        return written[path]
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

    func testPowerOnWithHeadUnitInputsDeclaresTheButtonsAndKnob() throws {
        let backend = FakeScreenBackend()
        _ = try CarPlayPowerController(backend: backend).run(udid: "device", powerOn: true, headUnitInputs: true)
        let plist = try XCTUnwrap(backend.written[StarkConfig.path(dataPath: "/sim/data")])
        let config = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any]
        )
        for key in ["hasHomeButton", "hasBackButton", "hasWheel", "hasWheelBump", "hasTouchScreen", "stark"] {
            XCTAssertEqual(config[key] as? Bool, true, key)
        }
        XCTAssertEqual(config["hasTouchScreenLofi"] as? Bool, false)
        XCTAssertEqual(StarkConfig.declaredHardware(plist), Set(StarkHardware.allCases))
    }

    func testDeclaredHardwareIsEmptyForTouchOnlyBootAndMissingConfigs() throws {
        try XCTAssertEqual(StarkConfig.declaredHardware(StarkConfig.plist()), [])
        let bootReset = try PropertyListSerialization.data(fromPropertyList: ["stark": 0], format: .xml, options: 0)
        XCTAssertEqual(StarkConfig.declaredHardware(bootReset), [])
        XCTAssertEqual(StarkConfig.declaredHardware(Data("not a plist".utf8)), [])
        XCTAssertEqual(StarkConfig.declaredHardware(nil), [])
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

    func sendUsage(_ phase: CarPlayTouchPhase, target: UInt32, page: UInt32, usage: UInt32) throws {
        try record("usage-\(phase):\(target):0x\(String(page, radix: 16)):0x\(String(usage, radix: 16))")
    }

    func sendScroll(target: UInt32, delta: Double) throws {
        try record("scroll:\(target):\(Int(delta))")
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

    private func assertRefused(
        _ name: String,
        _ code: CarPlayErrorCode,
        point: CGPoint = CGPoint(x: 1, y: 1),
        configure: (FakeScreenBackend) -> Void = { _ in }
    ) {
        let screens = poweredScreens()
        configure(screens)
        let hid = FakeHIDBackend()
        XCTAssertThrowsError(try controller(screens, hid).tap(udid: "d", x: point.x, y: point.y), name) {
            XCTAssertEqual(($0 as? CarPlayPowerError)?.code, code, name)
        }
        XCTAssertEqual(hid.calls, [], name)
    }

    func testRefusesWithoutSendingAnything() {
        for version in ["27.0", "18.6"] {
            assertRefused("iOS \(version)", .unsupportedRuntime) {
                $0.device = SimulatorDevice(runtimeVersion: version, dataPath: "/d")
            }
        }
        assertRefused("no TVOut", .noCarPlayScreen) { $0.before = [FakeScreenBackend.lcd, FakeScreenBackend.wireless] }
        assertRefused("powered off", .carPlayNotPowered) { $0.before = [FakeScreenBackend.tvOut(power: 0)] }
        assertRefused("external display type", .unsupportedScreenType) {
            $0.before = [SimulatorScreen(id: 2, name: "TVOut", screenType: 3, powerState: 1, width: 800, height: 480)]
        }
        for point in [CGPoint(x: 800, y: 1), CGPoint(x: 1, y: -1), CGPoint(x: Double.nan, y: 1)] {
            assertRefused("point \(point)", .usage, point: point)
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

final class CarPlayInputTests: XCTestCase {
    private func poweredScreens(headUnitInputs: Bool = true) throws -> FakeScreenBackend {
        let screens = FakeScreenBackend()
        screens.before = [FakeScreenBackend.lcd, FakeScreenBackend.tvOut(power: 1)]
        screens.written[StarkConfig.path(dataPath: "/sim/data")] = try StarkConfig.plist(headUnitInputs: headUnitInputs)
        return screens
    }

    func testEachInputsMessageAndHardware() {
        let expected: [CarPlayInput: (CarPlayInputMessage, StarkHardware?)] = [
            .back: (.usage(page: 0x0C, usage: 0x224), .backButton),
            .home: (.usage(page: 0x0C, usage: 0x223), .homeButton),
            .siri: (.usage(page: 0x0C, usage: 0xCF), nil),
            .knobSelect: (.usage(page: 0x0C, usage: 0x41), .wheel),
            .knobUp: (.usage(page: 0x0C, usage: 0x42), .wheelBump),
            .knobDown: (.usage(page: 0x0C, usage: 0x43), .wheelBump),
            .knobLeft: (.usage(page: 0x0C, usage: 0x44), .wheelBump),
            .knobRight: (.usage(page: 0x0C, usage: 0x45), .wheelBump),
            .knobClockwise: (.scroll(delta: -1), .wheel),
            .knobCounterclockwise: (.scroll(delta: 1), .wheel),
        ]
        XCTAssertEqual(Set(expected.keys), Set(CarPlayInput.allCases))
        for (input, (message, hardware)) in expected {
            XCTAssertEqual(input.message, message, input.rawValue)
            XCTAssertEqual(input.hardware, hardware, input.rawValue)
        }
        XCTAssertEqual(
            CarPlayInput.allCases.map(\.rawValue),
            [
                "back", "home", "siri", "knob-select", "knob-up", "knob-down", "knob-left", "knob-right", "knob-cw",
                "knob-ccw",
            ]
        )
    }

    func testBackPressesAndReleasesTheUsageOnTheCarPlayService() throws {
        let backend = try poweredScreens()
        let hid = FakeHIDBackend()
        let result = try CarPlayInputController(screens: backend, hid: hid).send(udid: "d", input: .back)
        XCTAssertEqual(backend.calls, ["select:d", "enumerate", "read"])
        XCTAssertEqual(hid.calls, ["create", "usage-down:1:0xc:0x224", "hold:80", "usage-up:1:0xc:0x224"])
        XCTAssertEqual(result.sent, CarPlayInputSent(
            input: "back", count: 1, screenID: 2, screenType: 1, target: 1, usagePage: 12, usage: 0x224,
            scrollDelta: nil
        ))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any])
        let sent = try XCTUnwrap(json["sent"] as? [String: Any])
        XCTAssertEqual(Set(sent.keys), ["input", "count", "screenID", "screenType", "target", "usagePage", "usage"])
    }

    func testKnobRotationSendsOneScrollPerDetent() throws {
        let hid = FakeHIDBackend()
        let result = try CarPlayInputController(screens: poweredScreens(), hid: hid)
            .send(udid: "d", input: .knobClockwise, count: 3)
        XCTAssertEqual(hid.calls, ["create", "scroll:1:-1", "hold:50", "scroll:1:-1", "hold:50", "scroll:1:-1"])
        XCTAssertEqual(result.sent.scrollDelta, -1)
        XCTAssertNil(result.sent.usage)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any])
        XCTAssertEqual(
            try Set(XCTUnwrap(json["sent"] as? [String: Any]).keys),
            ["input", "count", "screenID", "screenType", "target", "scrollDelta"]
        )
    }

    func testSiriNeedsNoStarkConfigHardware() throws {
        let backend = try poweredScreens(headUnitInputs: false)
        let hid = FakeHIDBackend()
        _ = try CarPlayInputController(screens: backend, hid: hid).send(udid: "d", input: .siri)
        XCTAssertEqual(backend.calls, ["select:d", "enumerate"])
        XCTAssertEqual(hid.calls, ["create", "usage-down:1:0xc:0xcf", "hold:80", "usage-up:1:0xc:0xcf"])
    }

    private func assertRefused(
        _ name: String,
        _ code: CarPlayErrorCode,
        input: CarPlayInput = .knobSelect,
        count: Int = 1,
        screens: FakeScreenBackend
    ) {
        let hid = FakeHIDBackend()
        XCTAssertThrowsError(
            try CarPlayInputController(screens: screens, hid: hid).send(udid: "d", input: input, count: count),
            name
        ) {
            XCTAssertEqual(($0 as? CarPlayPowerError)?.code, code, name)
        }
        XCTAssertEqual(hid.calls, [], name)
    }

    func testRefusesWithoutSendingAnything() throws {
        for input in CarPlayInput.allCases where input.hardware != nil {
            try assertRefused(
                "touch-only \(input)", .headUnitInputsDisabled, input: input,
                screens: poweredScreens(headUnitInputs: false)
            )
        }
        let unpowered = try poweredScreens()
        unpowered.written = [:]
        assertRefused("no StarkConfig", .headUnitInputsDisabled, screens: unpowered)
        let ios27 = try poweredScreens()
        ios27.device = SimulatorDevice(runtimeVersion: "27.0", dataPath: "/sim/data")
        assertRefused("iOS 27", .unsupportedRuntime, screens: ios27)
        let off = try poweredScreens()
        off.before = [FakeScreenBackend.tvOut(power: 0)]
        assertRefused("powered off", .carPlayNotPowered, screens: off)
        let counts: [(CarPlayInput, Int)] = [
            (.back, 2), (.knobSelect, 0), (.knobClockwise, 0), (.knobCounterclockwise, 51),
        ]
        for (input, count) in counts {
            let backend = try poweredScreens()
            assertRefused("\(input) x\(count)", .usage, input: input, count: count, screens: backend)
            XCTAssertEqual(backend.calls, [], "count is checked before the simulator is touched")
        }
    }

    func testStopsAtTheFailedHIDStep() throws {
        for step in ["create", "usage-down:1:0xc:0x41", "usage-up:1:0xc:0x41"] {
            let hid = FakeHIDBackend()
            let failure = CarPlayPowerError(.hidFailed, "simulator refused")
            hid.failure = failure
            hid.failureStep = step
            XCTAssertThrowsError(
                try CarPlayInputController(screens: poweredScreens(), hid: hid).send(udid: "d", input: .knobSelect)
            ) {
                XCTAssertEqual($0 as? CarPlayPowerError, failure)
            }
            XCTAssertEqual(hid.calls.last, step)
        }
    }
}

final class SimulatorKitLocationTests: XCTestCase {
    func testXcode27SharedFrameworksComeBeforeTheXcode26Path() {
        let xcode = "/nonexistent-simkit/Xcode-27.2.0.app/Contents"
        XCTAssertEqual(
            SimulatorKitLocation.candidatePaths(developerDirectory: "\(xcode)/Developer"),
            [
                "\(xcode)/SharedFrameworks/SimulatorKit.framework/SimulatorKit",
                "\(xcode)/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
            ]
        )
    }

    func testATrailingSlashResolvesTheSamePaths() {
        let xcode = "/nonexistent-simkit/Xcode.app/Contents"
        XCTAssertEqual(
            SimulatorKitLocation.candidatePaths(developerDirectory: "\(xcode)/Developer/"),
            [
                "\(xcode)/SharedFrameworks/SimulatorKit.framework/SimulatorKit",
                "\(xcode)/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
            ]
        )
    }

    func testAnAppBundlePathNormalizesToItsDeveloperDirectory() {
        let app = "/nonexistent-simkit/Xcode.app"
        let expected = [
            "\(app)/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit",
            "\(app)/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
        ]
        XCTAssertEqual(SimulatorKitLocation.candidatePaths(developerDirectory: app), expected)
        XCTAssertEqual(SimulatorKitLocation.candidatePaths(developerDirectory: app + "/"), expected)
    }

    func testASymlinkedDeveloperDirectoryResolvesToTheRealParent() throws {
        let fileManager = FileManager.default
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("simkit-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(at: root) }
        let developer = root.appendingPathComponent("Xcode.app/Contents/Developer")
        try fileManager.createDirectory(at: developer, withIntermediateDirectories: true)
        let link = root.appendingPathComponent("link")
        try fileManager.createSymbolicLink(at: link, withDestinationURL: developer)

        let realDeveloper = (developer.path as NSString).resolvingSymlinksInPath
        let contents = (realDeveloper as NSString).deletingLastPathComponent
        XCTAssertEqual(
            SimulatorKitLocation.candidatePaths(developerDirectory: link.path),
            [
                "\(contents)/SharedFrameworks/SimulatorKit.framework/SimulatorKit",
                "\(realDeveloper)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
            ]
        )
    }
}
