import XCTest
@testable import ScreenCaptureCore

final class CommandLineOptionsTests: XCTestCase {
    func testDefaultsToCaptureWithoutDeviceID() throws {
        let opts = try CommandLineOptions.parse(["screen-capture-helper"])
        XCTAssertEqual(opts.mode, .capture(deviceID: nil))
    }

    func testParsesDeviceID() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--device-id", "ABC123"
        ])
        XCTAssertEqual(opts.mode, .capture(deviceID: "ABC123"))
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

    func testParsesSimulatorWindow() throws {
        let opts = try CommandLineOptions.parse([
            "screen-capture-helper", "--simulator-window", "98765"
        ])
        XCTAssertEqual(opts.mode, .captureSimulator(windowID: 98765))
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
