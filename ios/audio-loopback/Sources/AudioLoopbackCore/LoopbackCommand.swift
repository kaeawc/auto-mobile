import Foundation

/// One helper invocation. Audio on the wire is 16-bit signed little-endian mono PCM at `sampleRate`,
/// on stdin for `play` and on stdout for `capture`.
public enum LoopbackCommand: Equatable {
    /// Play stdin into the loopback device the host's default input reads from, until stdin ends.
    case play(sampleRate: Int)
    /// Record from the loopback device the host's default output writes to: `durationMs`, or with nil
    /// (`--until-stopped`) until stdin closes.
    case capture(sampleRate: Int, durationMs: Int?)
    /// Record one iOS Simulator's output with a Core Audio process tap over the processes descending
    /// from its `launchd_sim` (#19046): no loopback driver, and no other simulator's audio. With `mute`
    /// the device is silent on the host while the tap runs.
    case tap(launchdPid: Int32, sampleRate: Int, durationMs: Int?, mute: Bool)

    public static let defaultSampleRate = 48000
    public static let maxSampleRate = 48000
    public static let minSampleRate = 8000
    /// Matches the daemon's capture bound with headroom; a longer capture is refused.
    public static let maxCaptureDurationMs = 60000

    public enum ParseError: Error, Equatable {
        case missingCommand
        case unknownCommand(String)
        case unknownArgument(String)
        case missingValue(flag: String)
        case invalidValue(flag: String, value: String)
    }

    /// Parses arguments without the executable name.
    public static func parse(_ arguments: [String]) throws -> LoopbackCommand {
        guard let command = arguments.first else {
            throw ParseError.missingCommand
        }
        guard ["play", "capture", "tap"].contains(command) else {
            throw ParseError.unknownCommand(command)
        }
        var options = Options(command: command)
        var iterator = arguments.dropFirst().makeIterator()
        while let flag = iterator.next() {
            try options.apply(flag, &iterator)
        }
        if command == "play" {
            return .play(sampleRate: options.sampleRate)
        }
        let bound = try captureBound(durationMs: options.durationMs, untilStopped: options.untilStopped)
        guard command == "tap" else {
            return .capture(sampleRate: options.sampleRate, durationMs: bound)
        }
        guard let launchdPid = options.launchdPid else {
            throw ParseError.missingValue(flag: "--launchd-pid")
        }
        return .tap(launchdPid: launchdPid, sampleRate: options.sampleRate, durationMs: bound, mute: options.mute)
    }

    /// The flags seen so far; each command accepts only its own.
    private struct Options {
        let command: String
        var sampleRate = defaultSampleRate
        var durationMs: Int?
        var launchdPid: Int32?
        var untilStopped = false
        var mute = false

        mutating func apply(_ flag: String, _ iterator: inout IndexingIterator<ArraySlice<String>>) throws {
            let records = command != "play"
            if flag == "--until-stopped", records {
                untilStopped = true
                return
            }
            if flag == "--mute", command == "tap" {
                mute = true
                return
            }
            guard let value = iterator.next() else {
                throw ParseError.missingValue(flag: flag)
            }
            switch flag {
            case "--sample-rate":
                sampleRate = try integer(flag, value, in: minSampleRate ... maxSampleRate)
            case "--duration-ms" where records:
                durationMs = try integer(flag, value, in: 1 ... maxCaptureDurationMs)
            case "--launchd-pid" where command == "tap":
                launchdPid = try Int32(integer(flag, value, in: 2 ... Int(Int32.max)))
            default:
                throw ParseError.unknownArgument(flag)
            }
        }
    }

    /// A recording runs for `--duration-ms` or, with `--until-stopped`, until stdin closes; never both.
    private static func captureBound(durationMs: Int?, untilStopped: Bool) throws -> Int? {
        if untilStopped {
            guard durationMs == nil else {
                throw ParseError.unknownArgument("--duration-ms")
            }
            return nil
        }
        guard let durationMs else {
            throw ParseError.missingValue(flag: "--duration-ms")
        }
        return durationMs
    }

    private static func integer(_ flag: String, _ value: String, in range: ClosedRange<Int>) throws -> Int {
        guard let parsed = Int(value), range.contains(parsed) else {
            throw ParseError.invalidValue(flag: flag, value: value)
        }
        return parsed
    }
}

/// Why the helper could not run. The raw value is the stable code the daemon maps to a tool error.
public enum LoopbackFailure: String, Equatable, Sendable {
    /// The command line was malformed.
    case usage
    /// The host's default input is missing or is not a loopback device, so nothing can feed it.
    case noLoopbackInput = "no_loopback_input"
    /// The host's default output is missing or is not a loopback device, so it cannot be read back.
    case noLoopbackOutput = "no_loopback_output"
    /// CoreAudio refused to open or start the device; the message carries the OSStatus.
    case audioFailed = "audio_failed"
    /// The `--launchd-pid` process is not running, so the simulator is not booted.
    case noSimulator = "no_simulator"
}

/// The stderr lines the daemon reads. One marker per line, so the daemon can match a prefix.
public enum LoopbackMarker {
    public static let readyPrefix = "audio-loopback-ready:"
    public static let errorPrefix = "audio-loopback-error:"

    /// Written once the device is open, before any audio is needed.
    public static func ready(deviceName: String) -> String {
        "\(readyPrefix) \(singleLine(deviceName))"
    }

    public static func error(_ failure: LoopbackFailure, _ message: String) -> String {
        "\(errorPrefix) \(failure.rawValue) \(singleLine(message))"
    }

    private static func singleLine(_ text: String) -> String {
        text.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
    }
}

/// Frames in a byte count of 16-bit mono PCM.
public enum Pcm16Mono {
    public static let bytesPerFrame = 2

    public static func frames(inBytes bytes: Int) -> Int {
        bytes / bytesPerFrame
    }

    /// Bytes for `durationMs` at `sampleRate`, rounded down to whole frames.
    public static func bytes(durationMs: Int, sampleRate: Int) -> Int {
        (durationMs * sampleRate / 1000) * bytesPerFrame
    }
}

/// Whether a device carries its output back into its input. Having both directions is not enough: a
/// USB headset has both but routes neither into the other. Matches the daemon's capability check.
public enum LoopbackDeviceRule {
    /// Loopback drivers that report a non-virtual transport but exist to read the output back.
    static let loopbackNames = ["blackhole", "loopback", "soundflower", "vb-cable", "vbcable", "background music"]

    public static func isLoopback(isVirtualTransport: Bool, name: String) -> Bool {
        if isVirtualTransport {
            return true
        }
        let lowered = name.lowercased()
        return loopbackNames.contains { lowered.contains($0) }
    }
}
