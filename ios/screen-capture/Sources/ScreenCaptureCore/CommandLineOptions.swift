import Foundation

/// Parsed CLI arguments for the screen-capture helper.
public struct CommandLineOptions: Equatable {
    /// In-helper H.264 encode settings (issue #4788). Absent means the default
    /// raw-BGRA path with zero behavior change. The bitrate *policy* stays in the
    /// TypeScript supervisor (which flag it passes); the helper only carries the
    /// choice and does the pixel-dimension arithmetic it alone knows pre-encode.
    public struct EncodeSettings: Equatable {
        public enum Bitrate: Equatable {
            /// `--bitrate-bps <n>`: operator override, used verbatim.
            case explicitBps(Int)
            /// `--bits-per-pixel <x>`: bitrate computed from delivered pixels x fps.
            case bitsPerPixel(Double)
            /// Neither flag: let VideoToolbox pick (physical-device path, #4375).
            case videoToolboxDefault
        }

        public let bitrate: Bitrate

        public init(bitrate: Bitrate) {
            self.bitrate = bitrate
        }
    }

    public enum Mode: Equatable {
        case listDevices
        /// Physical USB-connected iOS device capture (AVFoundation). `encode` is
        /// absent on the raw-BGRA path and present under `--encode h264` (#4790).
        case capture(deviceID: String?, encode: EncodeSettings?)
        case listSimulators
        case captureSimulator(windowID: UInt32, fps: Int, audio: Bool, encode: EncodeSettings?)
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
        var encodeRequested = false
        var bitrateBps: Int?
        var bitsPerPixel: Double?

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
            case "--encode":
                guard let value = iterator.next() else {
                    throw ParseError.missingValue(flag: arg)
                }
                // Only H.264 exists today; reject anything else so a typo fails
                // loudly instead of silently taking the raw path.
                guard value == "h264" else {
                    throw ParseError.invalidValue(flag: arg, value: value)
                }
                encodeRequested = true
            case "--bitrate-bps":
                guard let value = iterator.next() else {
                    throw ParseError.missingValue(flag: arg)
                }
                guard let parsed = Int(value), parsed > 0 else {
                    throw ParseError.invalidValue(flag: arg, value: value)
                }
                bitrateBps = parsed
            case "--bits-per-pixel":
                guard let value = iterator.next() else {
                    throw ParseError.missingValue(flag: arg)
                }
                guard let parsed = Double(value), parsed > 0, parsed.isFinite else {
                    throw ParseError.invalidValue(flag: arg, value: value)
                }
                bitsPerPixel = parsed
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

        if bitrateBps != nil && bitsPerPixel != nil {
            throw ParseError.conflictingFlags("--bitrate-bps and --bits-per-pixel are mutually exclusive")
        }
        if (bitrateBps != nil || bitsPerPixel != nil) && !encodeRequested {
            throw ParseError.conflictingFlags("--bitrate-bps/--bits-per-pixel require --encode h264")
        }
        // In-helper encoding is wired for both the Simulator (ScreenCaptureKit) and
        // the physical-device (AVFoundation) capture paths (issues #4788 / #4790).
        // It is only meaningful for a capture mode, so reject it on the discovery
        // (`--list-*`) modes.
        if encodeRequested && (listDevices || listSimulators) {
            throw ParseError.conflictingFlags("--encode requires a capture mode, not --list-devices/--list-simulators")
        }

        var encodeSettings: EncodeSettings?
        if encodeRequested {
            let bitrate: EncodeSettings.Bitrate
            if let bps = bitrateBps {
                bitrate = .explicitBps(bps)
            } else if let bpp = bitsPerPixel {
                bitrate = .bitsPerPixel(bpp)
            } else {
                bitrate = .videoToolboxDefault
            }
            encodeSettings = EncodeSettings(bitrate: bitrate)
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
                    audio: audio,
                    encode: encodeSettings
                )
            )
        }
        return CommandLineOptions(mode: .capture(deviceID: deviceID, encode: encodeSettings))
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

    ENCODE OPTIONS (in-helper H.264; works with --simulator-window or a device):
        --encode h264           Encode H.264 (Baseline 4.2) in-process instead of
                                streaming raw BGRA. Captures 420v (NV12) and emits
                                Annex-B encoded-video records. Default: raw BGRA.
        --bitrate-bps <n>       Operator override for the average bitrate (bps).
                                Honored for both the Simulator and device paths.
        --bits-per-pixel <x>    Compute the bitrate from the delivered pixel
                                dimensions x fps x <x> (Simulator default 0.1).
                                Simulator-only: on a physical device this budget is
                                skipped and VideoToolbox picks its own default,
                                because the 0.1 figure was measured from Simulator
                                screen content. Mutually exclusive with
                                --bitrate-bps; omit both to let VideoToolbox choose.

        -h, --help              Show this help.

    Frames are written to stdout: 16-byte little-endian header
    (width, height, bytesPerRow, timestampMs) followed by
    height * bytesPerRow bytes of BGRA pixel data.
    """
}
