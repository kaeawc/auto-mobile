import XCTest
@testable import ScreenCaptureCore

final class CommandLineOptionsTests: XCTestCase {
    func testParsesAudioForSimulatorCapture() throws {
        let options = try CommandLineOptions.parse([
            "screen-capture-helper", "--simulator-window", "42", "--audio"
        ])

        XCTAssertEqual(options.mode, .captureSimulator(windowID: 42, fps: 5, audio: true, encode: nil))
    }

    func testDefaultsToCaptureWithoutDeviceID() throws {
        let opts = try CommandLineOptions.parse(["screen-capture-helper"])
        XCTAssertEqual(opts.mode, .capture(deviceID: nil, encode: nil))
    }

    func testParsesDeviceID() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--device-id", "ABC123"
        ])
        XCTAssertEqual(opts.mode, .capture(deviceID: "ABC123", encode: nil))
    }

    func testParsesListDevices() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--list-devices"
        ])
        XCTAssertEqual(opts.mode, .listDevices)
    }

    func testParsesHelpFlag() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--help"
        ])
        XCTAssertEqual(opts.mode, .help)
    }

    func testMissingDeviceIDValueThrows() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper", "--device-id"
        ])) { error in
            XCTAssertEqual(
                error as? CommandLineOptions.ParseError,
                .missingValue(flag: "--device-id")
            )
        }
    }

    func testUnknownArgumentThrows() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper", "--bogus"
        ])) { error in
            XCTAssertEqual(
                error as? CommandLineOptions.ParseError,
                .unknownArgument("--bogus")
            )
        }
    }

    func testParsesListSimulators() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--list-simulators"
        ])
        XCTAssertEqual(opts.mode, .listSimulators)
    }

    func testParsesSimulatorWindowWithDefaultFPS() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--simulator-window", "98765"
        ])
        XCTAssertEqual(
            opts.mode,
            .captureSimulator(
                windowID: 98765,
                fps: CommandLineOptions.defaultSimulatorFPS,
                audio: false,
                encode: nil
            )
        )
    }

    func testParsesSimulatorFPSWithinRange() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper",
            "--simulator-window", "1",
            "--simulator-fps", "30",
        ])
        XCTAssertEqual(opts.mode, .captureSimulator(windowID: 1, fps: 30, audio: false, encode: nil))
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
            "screen-capture-helper", "--simulator-window", "not-a-number"
        ])) { error in
            XCTAssertEqual(
                error as? CommandLineOptions.ParseError,
                .invalidValue(flag: "--simulator-window", value: "not-a-number")
            )
        }
    }

    func testMissingSimulatorWindowValueThrows() {
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "screen-capture-helper", "--simulator-window"
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
