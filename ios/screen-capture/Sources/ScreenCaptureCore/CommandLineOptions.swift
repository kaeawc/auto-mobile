import Foundation

/// Parsed CLI arguments for the screen-capture helper.
public struct CommandLineOptions: Equatable {
    public enum Mode: Equatable {
        case listDevices
        case capture(deviceID: String?)
        case listSimulators
        case captureSimulator(windowID: UInt32, fps: Int, audio: Bool)
        case help
    }

    public let mode: Mode

    public init(mode: Mode) {
        self.mode = mode
    }

    public enum ParseError: Error, Equatable {
        case missingValue(flag: String)
        case unknownArgument(String)
        case invalidValue(flag: String, value: String)
        case conflictingFlags(String)
    }

    public static let defaultSimulatorFPS = 5
    public static let minSimulatorFPS = 5
    public static let maxSimulatorFPS = 60

    public static func parse(_ arguments: [String]) throws -> CommandLineOptions {
        var iterator = arguments.makeIterator()
        _ = iterator.next()

        var listDevices = false
        var deviceID: String?
        var listSimulators = false
        var simulatorWindowID: UInt32?
        var simulatorFPS: Int?
        var audio = false
        var help = false

        while let arg = iterator.next() {
            switch arg {
            case "--list-devices":
                listDevices = true
            case "--device-id":
                guard let value = iterator.next() else {
                    throw ParseError.missingValue(flag: arg)
                }
                deviceID = value
            case "--list-simulators":
                listSimulators = true
            case "--simulator-window":
                guard let value = iterator.next() else {
                    throw ParseError.missingValue(flag: arg)
                }
                guard let parsed = UInt32(value) else {
                    throw ParseError.invalidValue(flag: arg, value: value)
                }
                simulatorWindowID = parsed
            case "--simulator-fps":
                guard let value = iterator.next() else {
                    throw ParseError.missingValue(flag: arg)
                }
                guard
                    let parsed = Int(value),
                    parsed >= minSimulatorFPS,
                    parsed <= maxSimulatorFPS
                else {
                    throw ParseError.invalidValue(flag: arg, value: value)
                }
                simulatorFPS = parsed
            case "--audio":
                audio = true
            case "-h", "--help":
                help = true
            default:
                throw ParseError.unknownArgument(arg)
            }
        }

        if help {
            return CommandLineOptions(mode: .help)
        }

        let modeFlagCount = [
            listDevices,
            listSimulators,
            simulatorWindowID != nil,
            deviceID != nil,
        ].filter { $0 }.count
        if modeFlagCount > 1 {
            throw ParseError.conflictingFlags(
                "choose one of --list-devices, --device-id, --list-simulators, --simulator-window"
            )
        }

        if simulatorFPS != nil && simulatorWindowID == nil {
            throw ParseError.conflictingFlags(
                "--simulator-fps requires --simulator-window"
            )
        }
        if audio && simulatorWindowID == nil {
            throw ParseError.conflictingFlags("--audio requires --simulator-window")
        }

        if listDevices {
            return CommandLineOptions(mode: .listDevices)
        }
        if listSimulators {
            return CommandLineOptions(mode: .listSimulators)
        }
        if let windowID = simulatorWindowID {
            return CommandLineOptions(
                mode: .captureSimulator(
                    windowID: windowID,
                    fps: simulatorFPS ?? defaultSimulatorFPS,
                    audio: audio
                )
            )
        }
        return CommandLineOptions(mode: .capture(deviceID: deviceID))
    }

    public static let helpText = """
    screen-capture-helper — AutoMobile iOS screen-capture helper

    USAGE:
        screen-capture-helper [--device-id <id>]
        screen-capture-helper --list-devices
        screen-capture-helper --simulator-window <windowID> [--simulator-fps <n>] [--audio]
        screen-capture-helper --list-simulators

    DEVICE OPTIONS (USB-connected iOS devices via AVFoundation):
        --list-devices          Emit discovered devices as JSON to stdout and exit.
        --device-id <id>        uniqueID of the device to capture. If omitted,
                                the first muxed external device is used.

    SIMULATOR OPTIONS (macOS iOS Simulator windows via ScreenCaptureKit):
        --list-simulators       Emit discovered simulator windows as JSON.
        --simulator-window <n>  CGWindowID of the simulator window to capture.
        --simulator-fps <n>     Target frame rate (5-60, default 5). Higher
                                values waste CPU for typical MCP workloads.
        --audio                 Capture Simulator window audio as 8 kHz mono PCM16LE.

        -h, --help              Show this help.

    Frames are written to stdout: 16-byte little-endian header
    (width, height, bytesPerRow, timestampMs) followed by
    height * bytesPerRow bytes of BGRA pixel data.
    """
}
