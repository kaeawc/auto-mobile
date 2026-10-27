@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeChannelsTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        _ = PrototypeChannelLimits.maxChannels
        if let data = try? Data(
            contentsOf: PrototypeSpecFixtures.directory
                .appendingPathComponent("valid/realtime-channels.json")
        ) {
            try? PrototypeSpecStrictValidator.validate(data: data, supportedCapabilities: [])
            _ = try? PrototypeBundleCapabilities.required(data)
            _ = try? JSONDecoder().decode(PrototypeSpec.self, from: data)
        }
    }

    func testRealtimeErrorsShard0() throws { try checkErrors(shard: 0) }
    func testRealtimeErrorsShard1() throws { try checkErrors(shard: 1) }
    func testRealtimeErrorsShard2() throws { try checkErrors(shard: 2) }
    func testRealtimeErrorsShard3() throws { try checkErrors(shard: 3) }
    func testRealtimeErrorsShard4() throws { try checkErrors(shard: 4) }
    func testRealtimeErrorsShard5() throws { try checkErrors(shard: 5) }
    func testRealtimeErrorsShard6() throws { try checkErrors(shard: 6) }
    func testRealtimeErrorsShard7() throws { try checkErrors(shard: 7) }
    func testRealtimeErrorsShard8() throws { try checkErrors(shard: 8) }
    func testRealtimeErrorsShard9() throws { try checkErrors(shard: 9) }
    func testRealtimeErrorsShard10() throws { try checkErrors(shard: 10) }
    func testRealtimeErrorsShard11() throws { try checkErrors(shard: 11) }
    func testRealtimeErrorsShard12() throws { try checkErrors(shard: 12) }
    func testRealtimeErrorsShard13() throws { try checkErrors(shard: 13) }
    func testRealtimeErrorsShard14() throws { try checkErrors(shard: 14) }
    func testRealtimeErrorsShard15() throws { try checkErrors(shard: 15) }
    func testRealtimeErrorsShard16() throws { try checkErrors(shard: 16) }
    func testRealtimeErrorsShard17() throws { try checkErrors(shard: 17) }
    func testRealtimeErrorsShard18() throws { try checkErrors(shard: 18) }
    func testRealtimeErrorsShard19() throws { try checkErrors(shard: 19) }
    func testRealtimeErrorsShard20() throws { try checkErrors(shard: 20) }
    func testRealtimeErrorsShard21() throws { try checkErrors(shard: 21) }
    func testRealtimeErrorsShard22() throws { try checkErrors(shard: 22) }
    func testRealtimeErrorsShard23() throws { try checkErrors(shard: 23) }
    func testRealtimeErrorsShard24() throws { try checkErrors(shard: 24) }
    func testRealtimeErrorsShard25() throws { try checkErrors(shard: 25) }
    func testRealtimeErrorsShard26() throws { try checkErrors(shard: 26) }
    func testRealtimeErrorsShard27() throws { try checkErrors(shard: 27) }
    func testRealtimeErrorsShard28() throws { try checkErrors(shard: 28) }
    func testRealtimeErrorsShard29() throws { try checkErrors(shard: 29) }
    func testRealtimeErrorsShard30() throws { try checkErrors(shard: 30) }
    func testRealtimeErrorsShard31() throws { try checkErrors(shard: 31) }

    private func checkErrors(shard: Int) throws {
        let directory = PrototypeSpecFixtures.directory.appendingPathComponent("invalid")
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter {
                $0.lastPathComponent.hasPrefix("realtime-") || $0.lastPathComponent
                    .hasPrefix("strict-gate-prototype_platform_realtime") ||
                    ($0.lastPathComponent.hasPrefix("strict-library-") && $0.lastPathComponent.contains("channel"))
            }
        XCTAssertFalse(files.isEmpty)
        for (index, file) in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }).enumerated()
            where index % 32 == shard
        {
            let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file)).objectFields ?? [:]
            let data = try JSONEncoder().encode(XCTUnwrap(fixture["spec"]))
            let supported = fixture["options"]?.objectFields?["supportedCapabilities"]
                .map { Set(PrototypeContractValidator.strings($0)) }
            do {
                try PrototypeSpecStrictValidator.validate(
                    data: data,
                    supportedCapabilities: supported,
                    library: fixture["options"]?.objectFields?["library"] == .bool(true)
                )
                XCTFail("Accepted \(file.lastPathComponent)")
            } catch let error as PrototypeLoadError {
                XCTAssertEqual(
                    error,
                    .invalidSpec(
                        path: fixture["expectedPath"]?.stringValue ?? "",
                        message: fixture["expectedMessage"]?.stringValue ?? ""
                    ),
                    file.lastPathComponent
                )
            }
        }
    }

    func testValidWebsocket() throws { try checkValid("realtime-channels") }
    func testValidSSE() throws { try checkValid("realtime-sse") }
    func testValidDataWrites() throws { try checkValid("realtime-data-writes") }
    func testValidOpaqueID() throws { try checkValid("realtime-opaque-looking-id") }
    func testValidBoundaries() throws { try checkValid("realtime-review-boundaries") }
    func testValidLegacyBindings() throws { try checkValid("realtime-review-legacy-bindings") }

    func testValidMenuBindings() throws { try checkValid("realtime-review-menu-bindings") }

    private func checkValid(_ name: String) throws {
        let data = try Data(
            contentsOf: PrototypeSpecFixtures.directory
                .appendingPathComponent("valid/\(name).json")
        )
        try PrototypeSpecStrictValidator.validate(data: data)
        if name.hasPrefix("realtime-review-") {
            let required = try Set(PrototypeBundleCapabilities.required(data))
            try PrototypeSpecStrictValidator.validate(data: data, supportedCapabilities: required, library: true)
            if name
                .hasSuffix("legacy-bindings")
            { XCTAssertFalse(required.contains("prototype_platform_realtime_v1"))
            }
        }
        let fields = try JSONDecoder().decode(JSONValue.self, from: data).objectFields ?? [:]
        XCTAssertEqual(
            try PrototypeBundleCapabilities.required(data),
            PrototypeStrictCapabilities.required(fields).sorted(),
            name
        )
        XCTAssertNoThrow(try JSONDecoder().decode(PrototypeSpec.self, from: data), name)
    }

    func testChannelBudgetsMirrorTheSharedContract() {
        XCTAssertEqual(PrototypeChannelLimits.maxChannels, 4)
        XCTAssertEqual(PrototypeChannelLimits.maxFrameBytes, 65536)
        XCTAssertEqual(PrototypeChannelLimits.maxSendBytes, 16384)
        XCTAssertEqual(PrototypeChannelLimits.maxChannelsOpen, 8)
        XCTAssertEqual(PrototypeChannelLimits.flushMs, 50)
    }
}
