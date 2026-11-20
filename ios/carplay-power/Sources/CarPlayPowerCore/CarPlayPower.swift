import Foundation

/// JSON contract: screens contain id/name/screenType/powerState/width/height. carPlay describes the
/// TVOut screen that becomes the car display: found, nullable screenID and nullable powerState.
public struct SimulatorScreen: Codable, Equatable, Sendable {
    public let id: UInt32
    public let name: String
    public let screenType: UInt64
    public let powerState: Int32
    public let width: Double
    public let height: Double

    public init(id: UInt32, name: String, screenType: UInt64, powerState: Int32, width: Double, height: Double) {
        self.id = id
        self.name = name
        self.screenType = screenType
        self.powerState = powerState
        self.width = width
        self.height = height
    }
}

public struct CarPlayState: Codable, Equatable, Sendable {
    public let found: Bool
    public let screenID: UInt32?
    public let powerState: Int32?

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(found, forKey: .found)
        try container.encode(screenID, forKey: .screenID)
        try container.encode(powerState, forKey: .powerState)
    }
}

public struct CarPlayPowerState: Codable, Equatable, Sendable {
    public let screens: [SimulatorScreen]
    public let carPlay: CarPlayState
}

public enum CarPlayErrorCode: String, Codable, Sendable, CaseIterable {
    case deviceNotFound = "device-not-found"
    case deviceNotBooted = "device-not-booted"
    case privateAPIUnavailable = "private-api-unavailable"
    case unsupportedRuntime = "unsupported-runtime"
    case noCarPlayScreen = "no-carplay-screen"
    case powerOnFailed = "power-on-failed"
    case usage
}

public struct CarPlayPowerError: Error, Codable, Equatable, Sendable {
    public let code: CarPlayErrorCode
    public let message: String

    public init(_ code: CarPlayErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

public struct CarPlayErrorResponse: Codable {
    public let error: CarPlayPowerError
    public init(error: CarPlayPowerError) { self.error = error }
}

public struct SimulatorDevice: Equatable, Sendable {
    /// Runtime version such as "26.5".
    public let runtimeVersion: String
    /// The simulator's data directory (SimDevice.dataPath).
    public let dataPath: String

    public init(runtimeVersion: String, dataPath: String) {
        self.runtimeVersion = runtimeVersion
        self.dataPath = dataPath
    }
}

/// The StarkConfig that backboardd reads to make TVOut a car display. 800x480 at 2x: a larger
/// pixel size renders the CarPlay UI at 1x into the top-left corner.
public enum StarkConfig {
    public static let width = 800.0
    public static let height = 480.0

    public static func plist() throws -> Data {
        let config: [String: Any] = [
            "width": Int(width), "height": Int(height), "scale": 2, "stark": true,
            "hasTouchScreen": true, "hasTouchScreenLofi": false, "hasHomeButton": false,
            "hasBackButton": false, "hasWheel": false, "hasWheelBump": false, "protocols": [String](),
        ]
        return try PropertyListSerialization.data(fromPropertyList: config, format: .xml, options: 0)
    }

    public static func path(dataPath: String) -> String {
        (dataPath as NSString).appendingPathComponent(
            "Library/Application Support/Simulator/extended_display.plist"
        )
    }
}

/// Backend owns device validation and private objects; the controller is synchronous and serial.
public protocol SimulatorScreenBackend {
    func selectBootedDevice(udid: String) throws -> SimulatorDevice
    func screens() throws -> [SimulatorScreen]
    func writeFile(_ data: Data, path: String) throws
    func setCarPlayMode(screenID: UInt32, width: Double, height: Double) throws
}

public struct CarPlayPowerController {
    /// CarPlay renders on the TVOut screen, not on the Wireless one.
    public static let carScreenName = "TVOut"
    private let backend: any SimulatorScreenBackend
    public init(backend: any SimulatorScreenBackend) { self.backend = backend }

    public func run(udid: String, powerOn: Bool) throws -> CarPlayPowerState {
        let device = try backend.selectBootedDevice(udid: udid)
        if powerOn { try Self.requireSupportedRuntime(device.runtimeVersion) }
        var screens = try backend.screens()
        if powerOn {
            guard let screen = screens.first(where: { $0.name == Self.carScreenName }) else {
                throw CarPlayPowerError(
                    .noCarPlayScreen,
                    "No TVOut screen; use an iPhone simulator on an iOS 26.x runtime."
                )
            }
            // CoreSimulator resets this file to {"stark":0} on every boot, so write it each time.
            try backend.writeFile(StarkConfig.plist(), path: StarkConfig.path(dataPath: device.dataPath))
            try backend.setCarPlayMode(screenID: screen.id, width: StarkConfig.width, height: StarkConfig.height)
            screens = try backend.screens()
            guard screens.contains(where: { $0.id == screen.id && $0.powerState == 1 }) else {
                throw CarPlayPowerError(
                    .powerOnFailed,
                    "TVOut did not report powerState=1 after the CarPlay mode change; reboot the simulator and retry."
                )
            }
        }
        let carPlay = screens.first(where: { $0.name == Self.carScreenName })
        return CarPlayPowerState(screens: screens, carPlay: CarPlayState(
            found: carPlay != nil, screenID: carPlay?.id, powerState: carPlay?.powerState
        ))
    }

    static func requireSupportedRuntime(_ version: String) throws {
        guard let major = Int(version.split(separator: ".").first ?? ""), major < 27 else {
            throw CarPlayPowerError(
                .unsupportedRuntime,
                "Headless CarPlay needs an iOS 26.x runtime (found \(version)). Apple does not support CarPlay on the iOS 27 Simulator; use an Xcode 26.x iOS 26 simulator."
            )
        }
    }
}
