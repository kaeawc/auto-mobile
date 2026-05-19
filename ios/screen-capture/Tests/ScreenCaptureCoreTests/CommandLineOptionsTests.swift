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
}
