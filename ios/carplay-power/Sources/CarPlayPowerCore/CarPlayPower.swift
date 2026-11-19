import Foundation

/// An enumerated simulator screen. Width and height are measured in pixels.
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

/// Reports whether TVOut was found and its power state, which is null when absent.
public struct CarPlayState: Codable, Equatable, Sendable {
    public let found: Bool
    public let powerState: Int32?

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(found, forKey: .found)
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

/// Owns simulator device validation, display configuration, and private screen objects.
public protocol SimulatorScreenBackend {
    func selectBootedDevice(udid: String) throws
    func iOSRuntimeMajorVersion() throws -> Int
    func writeStarkConfig(width: Int, height: Int) throws
    func screens() throws -> [SimulatorScreen]
    func configureCarPlay(screenID: UInt32, width: Int, height: Int) throws
    func powerOn(screenID: UInt32) throws
}

/// Runs status and power-on synchronously. Power-on reapplies the boot-reset CarPlay
/// configuration, then configures and powers TVOut and verifies the resulting display.
public struct CarPlayPowerController {
    private let backend: any SimulatorScreenBackend
    public init(backend: any SimulatorScreenBackend) { self.backend = backend }

    public func run(udid: String, powerOn: Bool) throws -> CarPlayPowerState {
        try backend.selectBootedDevice(udid: udid)
        let width = 800
        let height = 480
        if powerOn {
            guard try backend.iOSRuntimeMajorVersion() < 27 else {
                throw CarPlayPowerError(
                    .unsupportedRuntime,
                    "CarPlay power-on supports iOS 26.x simulators only. Use an iOS 26.x runtime because CarPlay is unsupported in iOS 27 simulators and can crash in CARSession (Apple known issue 179494052)."
                )
            }
            try backend.writeStarkConfig(width: width, height: height)
        }
        var screens = try backend.screens()
        var carPlay = screens.first(where: { $0.screenType == 1 })
        if powerOn {
            guard let screen = carPlay else {
                throw CarPlayPowerError(
                    .noCarPlayScreen,
                    "No TVOut screen was found. Boot a supported iPhone simulator and retry power-on."
                )
            }
            try backend.configureCarPlay(screenID: screen.id, width: width, height: height)
            try backend.powerOn(screenID: screen.id)
            screens = try backend.screens()
            guard let verified = screens.first(where: { $0.id == screen.id && $0.screenType == 1 }),
                  verified.powerState == 1, verified.width == Double(width), verified.height == Double(height)
            else {
                throw CarPlayPowerError(
                    .powerOnFailed,
                    "TVOut screen \(screen.id) must report powerState=1 and \(width)x\(height) pixels after power-on. Retry or check Xcode compatibility."
                )
            }
            carPlay = verified
        }
        return CarPlayPowerState(screens: screens, carPlay: CarPlayState(
            found: carPlay != nil, powerState: carPlay?.powerState
        ))
    }
}
