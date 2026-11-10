import Foundation

/// JSON contract: screens contain id/name/screenType/powerState/width/height. carPlay contains
/// found, nullable powerState, and nullable enabled (unknown unless enable succeeded this invocation).
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
    public let powerState: Int32?
    public let enabled: Bool?

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(found, forKey: .found)
        try container.encode(powerState, forKey: .powerState)
        try container.encode(enabled, forKey: .enabled)
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

/// Backend owns device validation and private objects; the controller is synchronous and serial.
public protocol SimulatorScreenBackend {
    func selectBootedDevice(udid: String) throws
    func enableCarPlay() throws
    func settle() throws
    func screens() throws -> [SimulatorScreen]
    func powerOn(screenID: UInt32) throws
}

public struct CarPlayPowerController {
    private let backend: any SimulatorScreenBackend
    public init(backend: any SimulatorScreenBackend) { self.backend = backend }

    public func run(udid: String, powerOn: Bool, enable: Bool = false) throws -> CarPlayPowerState {
        try backend.selectBootedDevice(udid: udid)
        if enable {
            try backend.enableCarPlay()
            try backend.settle()
        }
        var screens = try backend.screens()
        if powerOn {
            guard let screen = screens.first(where: { $0.screenType == 2 }) else {
                throw CarPlayPowerError(
                    .noCarPlayScreen,
                    "No CarPlay screen; retry power-on --enable with a supported iPhone simulator."
                )
            }
            try backend.powerOn(screenID: screen.id)
            screens = try backend.screens()
            guard screens.contains(where: { $0.id == screen.id && $0.screenType == 2 && $0.powerState == 1 }) else {
                throw CarPlayPowerError(
                    .powerOnFailed,
                    "CarPlay screen did not report powerState=1 after power-on; retry or check Xcode compatibility."
                )
            }
        }
        let carPlay = screens.first(where: { $0.screenType == 2 })
        return CarPlayPowerState(screens: screens, carPlay: CarPlayState(
            found: carPlay != nil, powerState: carPlay?.powerState, enabled: enable ? true : nil
        ))
    }
}
