@testable import AudioLoopbackCore
import XCTest

final class LoopbackCommandTests: XCTestCase {
    func testPlayDefaultsToFortyEightKilohertz() throws {
        XCTAssertEqual(try LoopbackCommand.parse(["play"]), .play(sampleRate: 48000))
        XCTAssertEqual(
            try LoopbackCommand.parse(["play", "--sample-rate", "16000"]),
            .play(sampleRate: 16000)
        )
    }

    func testCaptureNeedsABoundedDuration() throws {
        XCTAssertEqual(
            try LoopbackCommand.parse(["capture", "--duration-ms", "1500", "--sample-rate", "44100"]),
            .capture(sampleRate: 44100, durationMs: 1500)
        )
        XCTAssertThrowsError(try LoopbackCommand.parse(["capture"])) { error in
            XCTAssertEqual(error as? LoopbackCommand.ParseError, .missingValue(flag: "--duration-ms"))
        }
        XCTAssertThrowsError(try LoopbackCommand.parse(["capture", "--duration-ms", "60001"])) { error in
            XCTAssertEqual(
                error as? LoopbackCommand.ParseError,
                .invalidValue(flag: "--duration-ms", value: "60001")
            )
        }
    }

    func testRejectsMalformedArguments() {
        XCTAssertThrowsError(try LoopbackCommand.parse([])) { error in
            XCTAssertEqual(error as? LoopbackCommand.ParseError, .missingCommand)
        }
        XCTAssertThrowsError(try LoopbackCommand.parse(["record"])) { error in
            XCTAssertEqual(error as? LoopbackCommand.ParseError, .unknownCommand("record"))
        }
        XCTAssertThrowsError(try LoopbackCommand.parse(["play", "--duration-ms", "10"])) { error in
            XCTAssertEqual(error as? LoopbackCommand.ParseError, .unknownArgument("--duration-ms"))
        }
        XCTAssertThrowsError(try LoopbackCommand.parse(["play", "--sample-rate"])) { error in
            XCTAssertEqual(error as? LoopbackCommand.ParseError, .missingValue(flag: "--sample-rate"))
        }
        XCTAssertThrowsError(try LoopbackCommand.parse(["play", "--sample-rate", "96000"])) { error in
            XCTAssertEqual(
                error as? LoopbackCommand.ParseError,
                .invalidValue(flag: "--sample-rate", value: "96000")
            )
        }
    }

    func testMarkersAreSingleLinesWithStableCodes() {
        XCTAssertEqual(LoopbackMarker.ready(deviceName: "BlackHole\n2ch"), "audio-loopback-ready: BlackHole 2ch")
        XCTAssertEqual(
            LoopbackMarker.error(.noLoopbackInput, "no device"),
            "audio-loopback-error: no_loopback_input no device"
        )
    }

    func testPcmFrameArithmetic() {
        XCTAssertEqual(Pcm16Mono.frames(inBytes: 9), 4)
        XCTAssertEqual(Pcm16Mono.bytes(durationMs: 1500, sampleRate: 16000), 48000)
    }

    func testOnlyVirtualOrKnownLoopbackDevicesCount() {
        XCTAssertTrue(LoopbackDeviceRule.isLoopback(isVirtualTransport: true, name: "Some Virtual Device"))
        XCTAssertTrue(LoopbackDeviceRule.isLoopback(isVirtualTransport: false, name: "BlackHole 2ch"))
        XCTAssertFalse(LoopbackDeviceRule.isLoopback(isVirtualTransport: false, name: "USB Headset"))
        XCTAssertFalse(LoopbackDeviceRule.isLoopback(isVirtualTransport: false, name: "MacBook Pro Microphone"))
    }
}
