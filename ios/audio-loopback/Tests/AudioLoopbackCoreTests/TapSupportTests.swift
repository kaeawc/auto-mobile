@testable import AudioLoopbackCore
import XCTest

final class TapSupportTests: XCTestCase {
    func testTapNeedsALaunchdPidAndABoundedDuration() throws {
        XCTAssertEqual(
            try LoopbackCommand.parse(["tap", "--launchd-pid", "4242", "--duration-ms", "500", "--mute"]),
            .tap(launchdPid: 4242, sampleRate: 48000, durationMs: 500, mute: true)
        )
        XCTAssertEqual(
            try LoopbackCommand.parse(["tap", "--until-stopped", "--launchd-pid", "7", "--sample-rate", "16000"]),
            .tap(launchdPid: 7, sampleRate: 16000, durationMs: nil, mute: false)
        )
        XCTAssertThrowsError(try LoopbackCommand.parse(["tap", "--duration-ms", "500"])) { error in
            XCTAssertEqual(error as? LoopbackCommand.ParseError, .missingValue(flag: "--launchd-pid"))
        }
        XCTAssertThrowsError(try LoopbackCommand.parse(["tap", "--launchd-pid", "1", "--duration-ms", "5"])) { error in
            XCTAssertEqual(error as? LoopbackCommand.ParseError, .invalidValue(flag: "--launchd-pid", value: "1"))
        }
        XCTAssertThrowsError(try LoopbackCommand.parse(["capture", "--mute", "--duration-ms", "5"])) { error in
            XCTAssertEqual(error as? LoopbackCommand.ParseError, .unknownArgument("--mute"))
        }
        let capturePid = ["capture", "--launchd-pid", "9", "--duration-ms", "5"]
        XCTAssertThrowsError(try LoopbackCommand.parse(capturePid)) { error in
            XCTAssertEqual(error as? LoopbackCommand.ParseError, .unknownArgument("--launchd-pid"))
        }
    }

    func testDescendantsCoverTheWholeSubtreeOnly() {
        // 100 is launchd_sim; 101 and 102 are its children, 103 a grandchild; 200 is another device.
        let parents: [Int32: Int32] = [100: 1, 101: 100, 102: 100, 103: 101, 200: 1, 201: 200, 1: 1]
        XCTAssertEqual(ProcessTree.descendants(of: 100, parents: parents), [101, 102, 103])
        XCTAssertEqual(ProcessTree.descendants(of: 200, parents: parents), [201])
        XCTAssertEqual(ProcessTree.descendants(of: 999, parents: parents), [])
    }

    func testResamplerMixesToMonoAtTheSameRate() {
        var resampler = MonoResampler(inputRate: 48000, outputRate: 48000)
        let stereo: [Float] = [0.2, 0.4, -0.5, -0.1]
        let mono = resampler.resample(stereo.withUnsafeBufferPointer { MonoMix.interleaved($0, channels: 2) })
        XCTAssertEqual(mono.count, 2)
        XCTAssertEqual(mono[0], 0.3, accuracy: 0.0001)
        XCTAssertEqual(mono[1], -0.3, accuracy: 0.0001)
    }

    func testResamplerHalvesTheRateAcrossBufferSplits() {
        let ramp = (0 ..< 12).map { Float($0) }
        var whole = MonoResampler(inputRate: 48000, outputRate: 24000)
        let expected = whole.resample(ramp)
        XCTAssertEqual(expected, [0, 2, 4, 6, 8, 10])
        var split = MonoResampler(inputRate: 48000, outputRate: 24000)
        let pieces = split.resample(Array(ramp[0 ..< 5])) + split.resample(Array(ramp[5 ..< 12]))
        XCTAssertEqual(pieces, expected)
    }

    func testResamplerInterpolatesWhenUpsampling() {
        var resampler = MonoResampler(inputRate: 16000, outputRate: 48000)
        let output = resampler.resample([0, 3]) + resampler.resample([6])
        XCTAssertEqual(output.count, 7)
        for (index, value) in output.enumerated() {
            XCTAssertEqual(value, Float(index), accuracy: 0.0001)
        }
    }

    func testEncodeClampsToSixteenBitFullScale() {
        let data = Pcm16Mono.encode([0, 1, -1, 2, 0.5])
        let samples = data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)).map { Int16(littleEndian: $0) } }
        XCTAssertEqual(samples, [0, 32767, -32767, 32767, 16383])
    }
}
