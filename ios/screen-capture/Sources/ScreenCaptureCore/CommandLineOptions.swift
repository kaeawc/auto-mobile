import Foundation

/// Parsed CLI arguments for the screen-capture helper.
public struct CommandLineOptions: Equatable {
    public enum Mode: Equatable {
        case listDevices
        case capture(deviceID: String?)
        case help
    }

    public let mode: Mode

    public init(mode: Mode) {
        self.mode = mode
    }

    public enum ParseError: Error, Equatable {
        case missingValue(flag: String)
        case unknownArgument(String)
    }

    public static func parse(_ arguments: [String]) throws -> CommandLineOptions {
        var iterator = arguments.makeIterator()
        _ = iterator.next()

        var listDevices = false
        var deviceID: String?
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
            case "-h", "--help":
                help = true
            default:
                throw ParseError.unknownArgument(arg)
            }
        }

        if help {
            return CommandLineOptions(mode: .help)
        }
        if listDevices {
            return CommandLineOptions(mode: .listDevices)
        }
        return CommandLineOptions(mode: .capture(deviceID: deviceID))
    }

    public static let helpText = """
    screen-capture-helper — AutoMobile iOS device capture helper

    USAGE:
        screen-capture-helper [--device-id <id>]
        screen-capture-helper --list-devices

    OPTIONS:
        --list-devices       Emit discovered devices as JSON to stdout and exit.
        --device-id <id>     uniqueID of the device to capture. If omitted, the
                             first muxed external device is used.
        -h, --help           Show this help.

    Frames are written to stdout: 16-byte little-endian header
    (width, height, bytesPerRow, timestampMs) followed by
    height * bytesPerRow bytes of BGRA pixel data.
    """
}
