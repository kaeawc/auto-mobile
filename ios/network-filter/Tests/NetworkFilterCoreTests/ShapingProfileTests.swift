// swiftlint:disable force_unwrapping
import Foundation
@testable import NetworkFilterCore
import XCTest

final class ShapingProfileTests: XCTestCase {
    func testOddRoundTripDelaySplitsAndRatesConvert() throws {
        let resolution = try ShapingProfile.resolve(ShapingRequest(
            delayMilliseconds: 5, downloadKilobitsPerSecond: 8, uploadKilobitsPerSecond: 16
        )).get()
        XCTAssertEqual(resolution.profile.outboundDelayMilliseconds, 3)
        XCTAssertEqual(resolution.profile.inboundDelayMilliseconds, 2)
        XCTAssertEqual(resolution.profile.inboundBytesPerSecond, 1000)
        XCTAssertEqual(resolution.profile.outboundBytesPerSecond, 2000)
        XCTAssertEqual(resolution.applied, [.latency, .downloadBandwidth, .uploadBandwidth])
    }

    func testZeroRatesAreUnlimitedAndLossIsUnapplied() throws {
        let resolution = try ShapingProfile.resolve(ShapingRequest(delayMilliseconds: 1, packetLossPercent: 50)).get()
        XCTAssertNil(resolution.profile.inboundBytesPerSecond)
        XCTAssertNil(resolution.profile.outboundBytesPerSecond)
        XCTAssertEqual(resolution.applied, [.latency])
        XCTAssertEqual(resolution.unapplied, [.packetLoss])
        XCTAssertTrue(resolution.profile.shapes(.outbound))
        XCTAssertFalse(resolution.profile.shapes(.inbound))
    }

    func testNothingApplicableIsRejected() {
        XCTAssertEqual(ShapingProfile.resolve(ShapingRequest()), .failure(.nothingToApply(unapplied: [])))
        XCTAssertEqual(
            ShapingProfile.resolve(ShapingRequest(packetLossPercent: 1)),
            .failure(.nothingToApply(unapplied: [.packetLoss]))
        )
    }

    func testEachOutOfRangeComponentIsRejected() {
        XCTAssertEqual(ShapingProfile.resolve(ShapingRequest(delayMilliseconds: 4001)), .failure(.outOfRange(.latency)))
        for rate: UInt64 in [1, 7, 1_000_001, .max] {
            XCTAssertEqual(
                ShapingProfile.resolve(ShapingRequest(downloadKilobitsPerSecond: rate)),
                .failure(.outOfRange(.downloadBandwidth))
            )
            XCTAssertEqual(
                ShapingProfile.resolve(ShapingRequest(uploadKilobitsPerSecond: rate)),
                .failure(.outOfRange(.uploadBandwidth))
            )
        }
        XCTAssertEqual(
            ShapingProfile.resolve(ShapingRequest(packetLossPercent: 101)),
            .failure(.outOfRange(.packetLoss))
        )
        XCTAssertNil(ShapingProfile(outboundDelayMilliseconds: 2001))
        XCTAssertNil(ShapingProfile(inboundDelayMilliseconds: 2001))
        for rate: UInt64 in [0, 999, 125_000_001, .max] {
            XCTAssertNil(ShapingProfile(outboundBytesPerSecond: rate))
            XCTAssertNil(ShapingProfile(inboundBytesPerSecond: rate))
        }
        XCTAssertNil(ShapingProfile())
    }

    func testCodableRoundTrip() throws {
        let profile = ShapingProfile(outboundDelayMilliseconds: 2000, inboundBytesPerSecond: 125_000_000)!
        XCTAssertEqual(try JSONDecoder().decode(ShapingProfile.self, from: JSONEncoder().encode(profile)), profile)
    }

    func testDecodingInvalidProfileThrows() {
        for json in [
            #"{"outboundDelayMilliseconds":2001,"inboundDelayMilliseconds":0}"#,
            #"{"outboundDelayMilliseconds":0,"inboundDelayMilliseconds":0,"inboundBytesPerSecond":999}"#,
            #"{"outboundDelayMilliseconds":0,"inboundDelayMilliseconds":0}"#,
        ] {
            XCTAssertThrowsError(try JSONDecoder().decode(ShapingProfile.self, from: Data(json.utf8)))
        }
    }

    func testFractionalLossIsReportedAndInvalidFloatingValuesAreRejected() throws {
        let resolution = try ShapingProfile.resolve(ShapingRequest(delayMilliseconds: 1, packetLossPercent: 0.5)).get()
        XCTAssertEqual(resolution.unapplied, [.packetLoss])
        let encoded = try JSONEncoder().encode(resolution.profile)
        let json = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        XCTAssertFalse(json.contains("packetLoss"))
        for loss: Double in [-1, .infinity, -.infinity, .nan] {
            XCTAssertEqual(
                ShapingProfile.resolve(ShapingRequest(packetLossPercent: loss)),
                .failure(.outOfRange(.packetLoss))
            )
        }
    }

    func testMaximumRequestValuesResolveWithinProfileLimits() throws {
        let resolution = try ShapingProfile.resolve(ShapingRequest(
            delayMilliseconds: 4000, downloadKilobitsPerSecond: 1_000_000,
            uploadKilobitsPerSecond: 1_000_000, packetLossPercent: 100
        )).get()
        XCTAssertEqual(resolution.profile.outboundDelayMilliseconds, 2000)
        XCTAssertEqual(resolution.profile.inboundDelayMilliseconds, 2000)
        XCTAssertEqual(resolution.profile.outboundBytesPerSecond, 125_000_000)
        XCTAssertEqual(resolution.profile.inboundBytesPerSecond, 125_000_000)
        XCTAssertEqual(resolution.unapplied, [.packetLoss])
        XCTAssertEqual(ShapingProfile.resolve(ShapingRequest(delayMilliseconds: .max)), .failure(.outOfRange(.latency)))
    }
}
