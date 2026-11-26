import Foundation

/// The Indigo HID digitizer target for a car screen. SimulatorKit sends TVOut (screenType 1) and
/// Wireless (screenType 2) touches to the CarPlay HID service, target 1. Never compute
/// IndigoHIDTargetForScreen(id) for a car screen: it names a virtual service that does not exist,
/// and backboardd aborts on it (#18730).
public enum CarPlayHID {
    public static let carPlayServiceTarget: UInt32 = 1

    public static func target(screenType: UInt64) -> UInt32? {
        switch screenType {
        case 1, 2: carPlayServiceTarget
        default: nil
        }
    }
}

public enum CarPlayTouchPhase: String, Sendable {
    case down
    case up
}

/// Sends Indigo HID messages to the simulator that `SimulatorScreenBackend.selectBootedDevice`
/// selected.
public protocol CarPlayHIDBackend {
    /// Creates the CarPlay HID service; touches to target 1 are ignored without it.
    func createCarPlayService() throws
    /// A left-mouse event at x, y in the car screen's pixels, normalized by width and height.
    func sendTouch(_ phase: CarPlayTouchPhase, target: UInt32, x: Double, y: Double, width: Double, height: Double)
        throws
    /// A button event for a HID usage (`IndigoHIDMessageForHIDArbitrary`), pressed or released.
    func sendUsage(_ phase: CarPlayTouchPhase, target: UInt32, page: UInt32, usage: UInt32) throws
    /// One scroll event of `delta` lines on the vertical axis
    /// (`IndigoHIDMessageForScrollEventFromHIDEventRef`).
    func sendScroll(target: UInt32, delta: Double) throws
    func hold(milliseconds: Int)
}

/// The powered car screen a HID message may go to, and its target.
struct PoweredCarScreen {
    let device: SimulatorDevice
    let screen: SimulatorScreen
    let target: UInt32

    /// Refuses unless the TVOut car screen is a TVOut or Wireless screen type, powered on, on an
    /// iOS 26.x runtime. `action` names what was refused, e.g. "CarPlay taps".
    static func require(_ screens: any SimulatorScreenBackend, udid: String, action: String) throws -> Self {
        let device = try screens.selectBootedDevice(udid: udid)
        guard Int(device.runtimeVersion.split(separator: ".").first ?? "") == 26 else {
            throw CarPlayPowerError(
                .unsupportedRuntime,
                "\(action) need an iOS 26.x runtime (found \(device.runtimeVersion)); only its CarPlay HID service is verified."
            )
        }
        guard let screen = try screens.screens().first(where: { $0.name == CarPlayPowerController.carScreenName })
        else {
            throw CarPlayPowerError(
                .noCarPlayScreen,
                "No TVOut screen; use an iPhone simulator on an iOS 26.x runtime."
            )
        }
        guard let target = CarPlayHID.target(screenType: screen.screenType) else {
            throw CarPlayPowerError(
                .unsupportedScreenType,
                "TVOut reports screenType \(screen.screenType), not a CarPlay screen type (1 or 2); nothing was sent."
            )
        }
        guard screen.powerState == 1 else {
            throw CarPlayPowerError(
                .carPlayNotPowered,
                "The CarPlay screen is powered off; run carplay-power-helper power-on after booting, then retry."
            )
        }
        return PoweredCarScreen(device: device, screen: screen, target: target)
    }
}

/// JSON contract of `tap`: the point sent, in car-screen pixels, and the screen and target it went to.
public struct CarPlayTap: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let screenID: UInt32
    public let screenType: UInt64
    public let target: UInt32
    public let width: Double
    public let height: Double
}

public struct CarPlayTapResult: Codable, Equatable, Sendable {
    public let tapped: CarPlayTap
}

public struct CarPlayTapController {
    /// Time between touch down and up; a tap the spike verified on iOS 26.5.
    public static let holdMilliseconds = 80
    private let screens: any SimulatorScreenBackend
    private let hid: any CarPlayHIDBackend

    public init(screens: any SimulatorScreenBackend, hid: any CarPlayHIDBackend) {
        self.screens = screens
        self.hid = hid
    }

    /// Refuses, sending nothing, unless the TVOut car screen is a TVOut or Wireless screen type,
    /// powered on, on an iOS 26.x runtime, and x, y lie inside it.
    public func tap(udid: String, x: Double, y: Double) throws -> CarPlayTapResult {
        let car = try PoweredCarScreen.require(screens, udid: udid, action: "CarPlay taps")
        let screen = car.screen
        let target = car.target
        guard x.isFinite, y.isFinite, x >= 0, y >= 0, x < screen.width, y < screen.height else {
            throw CarPlayPowerError(
                .usage,
                "Tap point (\(x), \(y)) is outside the \(Int(screen.width))x\(Int(screen.height)) CarPlay screen."
            )
        }
        // CoreSimulator HID state does not survive a reboot; creating it again is harmless.
        try hid.createCarPlayService()
        try hid.sendTouch(.down, target: target, x: x, y: y, width: screen.width, height: screen.height)
        hid.hold(milliseconds: Self.holdMilliseconds)
        try hid.sendTouch(.up, target: target, x: x, y: y, width: screen.width, height: screen.height)
        return CarPlayTapResult(tapped: CarPlayTap(
            x: x, y: y, screenID: screen.id, screenType: screen.screenType, target: target,
            width: screen.width, height: screen.height
        ))
    }
}

/// Where SimulatorKit lives for a developer directory, in lookup order. Xcode 27 moved it to
/// `Contents/SharedFrameworks`; Xcode 26 keeps it under the developer directory (#19117).
public enum SimulatorKitLocation {
    public static func candidatePaths(developerDirectory: String) -> [String] {
        var resolved = (developerDirectory as NSString).resolvingSymlinksInPath
        // DEVELOPER_DIR may name the app bundle itself (`/Applications/Xcode.app`).
        if resolved.hasSuffix(".app") {
            resolved = (resolved as NSString).appendingPathComponent("Contents/Developer")
        }
        let developer = resolved as NSString
        return [
            developer.deletingLastPathComponent + "/SharedFrameworks/SimulatorKit.framework/SimulatorKit",
            developer.appendingPathComponent("Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"),
        ]
    }
}
