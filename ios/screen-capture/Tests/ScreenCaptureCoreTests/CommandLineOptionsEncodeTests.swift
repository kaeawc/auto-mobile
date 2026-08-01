import XCTest
@testable import ScreenCaptureCore

/// Parsing tests for the `--encode h264` flag family (issue #4788). Without the
/// flag the mode carries `encode: nil` — the guarantee that the raw path is
/// unchanged starts here.
final class CommandLineOptionsEncodeTests: XCTestCase {
    private func parse(_ args: [String]) throws -> CommandLineOptions {
        try CommandLineOptions.parse(["screen-capture-helper"] + args)
    }

    func testEncodeH264WithVideoToolboxDefaultBitrate() throws {
        let opts = try parse(["--simulator-window", "7", "--encode", "h264"])
        XCTAssertEqual(
            opts.mode,
            .captureSimulator(windowID: 7, fps: 5, audio: false,
                              encode: .init(bitrate: .videoToolboxDefault))
        )
    }

    func testEncodeWithExplicitBitrate() throws {
        let opts = try parse(["--simulator-window", "7", "--encode", "h264", "--bitrate-bps", "2500000"])
        XCTAssertEqual(
            opts.mode,
            .captureSimulator(windowID: 7, fps: 5, audio: false,
                              encode: .init(bitrate: .explicitBps(2_500_000)))
        )
    }

    func testEncodeWithBitsPerPixel() throws {
        let opts = try parse(["--simulator-window", "7", "--encode", "h264", "--bits-per-pixel", "0.1"])
        XCTAssertEqual(
            opts.mode,
            .captureSimulator(windowID: 7, fps: 5, audio: false,
                              encode: .init(bitrate: .bitsPerPixel(0.1)))
        )
    }

    func testEncodeCarriesFpsAndAudio() throws {
        let opts = try parse([
            "--simulator-window", "7", "--simulator-fps", "15", "--audio", "--encode", "h264"
        ])
        XCTAssertEqual(
            opts.mode,
            .captureSimulator(windowID: 7, fps: 15, audio: true,
                              encode: .init(bitrate: .videoToolboxDefault))
        )
    }

    func testRejectsUnknownCodec() {
        XCTAssertThrowsError(try parse(["--simulator-window", "7", "--encode", "vp9"])) {
            XCTAssertEqual($0 as? CommandLineOptions.ParseError, .invalidValue(flag: "--encode", value: "vp9"))
        }
    }

    func testRejectsBitrateAndBitsPerPixelTogether() {
        XCTAssertThrowsError(try parse([
            "--simulator-window", "7", "--encode", "h264", "--bitrate-bps", "1000", "--bits-per-pixel", "0.1"
        ])) {
            guard case CommandLineOptions.ParseError.conflictingFlags = $0 else {
                return XCTFail("expected conflictingFlags, got \($0)")
            }
        }
    }

    func testRejectsBitrateWithoutEncode() {
        XCTAssertThrowsError(try parse(["--simulator-window", "7", "--bitrate-bps", "1000"])) {
            guard case CommandLineOptions.ParseError.conflictingFlags = $0 else {
                return XCTFail("expected conflictingFlags, got \($0)")
            }
        }
    }

    // MARK: - Physical-device encode path (issue #4790)

    func testEncodeWithoutSimulatorWindowIsDeviceCapture() throws {
        // `--encode h264` with no simulator window is the physical-device path, not
        // an error: it carries the encode settings onto the AVFoundation capture.
        let opts = try parse(["--encode", "h264"])
        XCTAssertEqual(
            opts.mode,
            .capture(deviceID: nil, encode: .init(bitrate: .videoToolboxDefault))
        )
    }

    func testDeviceEncodeWithDeviceIDAndExplicitBitrate() throws {
        let opts = try parse(["--device-id", "ABC123", "--encode", "h264", "--bitrate-bps", "3000000"])
        XCTAssertEqual(
            opts.mode,
            .capture(deviceID: "ABC123", encode: .init(bitrate: .explicitBps(3_000_000)))
        )
    }

    func testDeviceEncodeCarriesBitsPerPixelChoice() throws {
        // Parsing still records the choice; the Simulator-only gating happens in the
        // pure `H264EncodeMath.resolveAverageBitRateBps` layer, not at parse time.
        let opts = try parse(["--encode", "h264", "--bits-per-pixel", "0.1"])
        XCTAssertEqual(
            opts.mode,
            .capture(deviceID: nil, encode: .init(bitrate: .bitsPerPixel(0.1)))
        )
    }

    func testRejectsEncodeWithListDevices() {
        XCTAssertThrowsError(try parse(["--list-devices", "--encode", "h264"])) {
            guard case CommandLineOptions.ParseError.conflictingFlags = $0 else {
                return XCTFail("expected conflictingFlags, got \($0)")
            }
        }
    }

    func testRejectsEncodeWithListSimulators() {
        XCTAssertThrowsError(try parse(["--list-simulators", "--encode", "h264"])) {
            guard case CommandLineOptions.ParseError.conflictingFlags = $0 else {
                return XCTFail("expected conflictingFlags, got \($0)")
            }
        }
    }

    func testRejectsNonPositiveBitrate() {
        XCTAssertThrowsError(try parse(["--simulator-window", "7", "--encode", "h264", "--bitrate-bps", "0"])) {
            XCTAssertEqual($0 as? CommandLineOptions.ParseError, .invalidValue(flag: "--bitrate-bps", value: "0"))
        }
    }

    func testRejectsNonPositiveBitsPerPixel() {
        XCTAssertThrowsError(try parse([
            "--simulator-window", "7", "--encode", "h264", "--bits-per-pixel", "0"
        ])) {
            XCTAssertEqual(
                $0 as? CommandLineOptions.ParseError,
                .invalidValue(flag: "--bits-per-pixel", value: "0")
            )
        }
    }

    func testEncodeMissingCodecValueThrows() {
        XCTAssertThrowsError(try parse(["--simulator-window", "7", "--encode"])) {
            XCTAssertEqual($0 as? CommandLineOptions.ParseError, .missingValue(flag: "--encode"))
        }
    }
}
