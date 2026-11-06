@testable import ScreenCaptureCore
import XCTest

final class CommandLineOptionsTests: XCTestCase {
    func testHelpTextDescribesFrameHeader() {
        let helpText = CommandLineOptions.helpText

        XCTAssertTrue(helpText.contains("\(FrameProtocol.headerSize)-byte"))
        XCTAssertFalse(helpText.contains("16-byte"))
        XCTAssertTrue(helpText.contains("magic"))
        XCTAssertTrue(helpText.contains("CRC-32"))
    }

    func testParsesAudioForSimulatorCapture() throws {
        let options = try CommandLineOptions.parse([
            "screen-capture-helper", "--simulator-window", "42", "--audio", "--encode", "h264",
        ])

        XCTAssertEqual(
            options.mode,
            .captureSimulator(windowID: 42, fps: 5, audio: true, encode: .init(bitrate: .videoToolboxDefault))
        )
    }

    func testDefaultsToCaptureWithoutDeviceID() throws {
        let opts = try CommandLineOptions.parse(["screen-capture-helper", "--encode", "h264"])
        XCTAssertEqual(opts.mode, .capture(deviceID: nil, encode: .init(bitrate: .videoToolboxDefault)))
    }

    func testCaptureWithoutEncodeIsRejectedBecauseRawStreamingWasRemoved() {
        for arguments in [
            ["screen-capture-helper"],
            ["screen-capture-helper", "--device-id", "ABC123"],
            ["screen-capture-helper", "--simulator-window", "7"],
        ] {
            XCTAssertThrowsError(try CommandLineOptions.parse(arguments)) { error in
                XCTAssertEqual(
                    error as? CommandLineOptions.ParseError,
                    .conflictingFlags("capture requires --encode h264")
                )
            }
        }
    }

    func testParsesDeviceID() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--device-id", "ABC123", "--encode", "h264",
        ])
        XCTAssertEqual(opts.mode, .capture(deviceID: "ABC123", encode: .init(bitrate: .videoToolboxDefault)))
    }

    func testParsesListDevices() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--list-devices",
        ])
        XCTAssertEqual(opts.mode, .listDevices)
    }

    func testParsesHelpFlag() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--help",
        ])
        XCTAssertEqual(opts.mode, .help)
    }

    func testMissingDeviceIDValueThrows() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper", "--device-id",
        ])) { error in
            XCTAssertEqual(
                error as? CommandLineOptions.ParseError,
                .missingValue(flag: "--device-id")
            )
        }
    }

    func testUnknownArgumentThrows() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper", "--bogus",
        ])) { error in
            XCTAssertEqual(
                error as? CommandLineOptions.ParseError,
                .unknownArgument("--bogus")
            )
        }
    }

    func testParsesListSimulators() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--list-simulators",
        ])
        XCTAssertEqual(opts.mode, .listSimulators)
    }

    func testParsesSimulatorWindowWithDefaultFPS() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--simulator-window", "98765", "--encode", "h264",
        ])
        XCTAssertEqual(
            opts.mode,
            .captureSimulator(
                windowID: 98765,
                fps: CommandLineOptions.defaultSimulatorFPS,
                audio: false,
                encode: .init(bitrate: .videoToolboxDefault)
            )
        )
    }

    func testParsesSimulatorFPSWithinRange() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper",
            "--simulator-window", "1",
            "--simulator-fps", "30",
            "--encode", "h264",
        ])
        XCTAssertEqual(
            opts.mode,
            .captureSimulator(windowID: 1, fps: 30, audio: false, encode: .init(bitrate: .videoToolboxDefault))
        )
    }

    func testRejectsSimulatorFPSBelowRange() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper",
            "--simulator-window", "1",
            "--simulator-fps", "4",
        ])) { error in
            XCTAssertEqual(
                error as? CommandLineOptions.ParseError,
                .invalidValue(flag: "--simulator-fps", value: "4")
            )
        }
    }

    func testRejectsSimulatorFPSAboveRange() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper",
            "--simulator-window", "1",
            "--simulator-fps", "61",
        ])) { error in
            XCTAssertEqual(
                error as? CommandLineOptions.ParseError,
                .invalidValue(flag: "--simulator-fps", value: "61")
            )
        }
    }

    func testRejectsSimulatorFPSWithoutWindow() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper", "--simulator-fps", "15",
        ])) { error in
            guard case CommandLineOptions.ParseError.conflictingFlags = error else {
                XCTFail("expected conflictingFlags, got \(error)")
                return
            }
        }
    }

    func testDefaultSimulatorFPSConstantIs5() {
        XCTAssertEqual(CommandLineOptions.defaultSimulatorFPS, 5)
        XCTAssertEqual(CommandLineOptions.minSimulatorFPS, 5)
        XCTAssertEqual(CommandLineOptions.maxSimulatorFPS, 60)
    }

    func testInvalidSimulatorWindowValueThrows() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper", "--simulator-window", "not-a-number",
        ])) { error in
            XCTAssertEqual(
                error as? CommandLineOptions.ParseError,
                .invalidValue(flag: "--simulator-window", value: "not-a-number")
            )
        }
    }

    func testMissingSimulatorWindowValueThrows() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper", "--simulator-window",
        ])) { error in
            XCTAssertEqual(
                error as? CommandLineOptions.ParseError,
                .missingValue(flag: "--simulator-window")
            )
        }
    }

    func testConflictingDeviceAndSimulatorFlagsThrow() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper",
            "--device-id", "abc",
            "--simulator-window", "1",
        ])) { error in
            guard case CommandLineOptions.ParseError.conflictingFlags = error else {
                XCTFail("expected conflictingFlags, got \(error)")
                return
            }
        }
    }

    func testConflictingListFlagsThrow() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper",
            "--list-devices",
            "--list-simulators",
        ])) { error in
            guard case CommandLineOptions.ParseError.conflictingFlags = error else {
                XCTFail("expected conflictingFlags, got \(error)")
                return
            }
        }
    }
}
