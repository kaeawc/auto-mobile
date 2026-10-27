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

    private func checkErrors(shard: Int) throws {
        let directory = PrototypeSpecFixtures.directory.appendingPathComponent("invalid")
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter {
                $0.lastPathComponent.hasPrefix("realtime-") || $0.lastPathComponent
                    .hasPrefix("strict-gate-prototype_platform_realtime")
            }
        XCTAssertFalse(files.isEmpty)
        for (index, file) in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }).enumerated()
            where index % 8 == shard
        {
            let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file)).objectFields ?? [:]
            let data = try JSONEncoder().encode(XCTUnwrap(fixture["spec"]))
            let supported = fixture["options"]?.objectFields?["supportedCapabilities"]
                .map { Set(PrototypeContractValidator.strings($0)) }
            do {
                try PrototypeSpecStrictValidator.validate(data: data, supportedCapabilities: supported)
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

    func testValidRealtimeSpecsPassBothValidationBoundaries() throws {
        for name in ["realtime-channels", "realtime-sse", "realtime-data-writes", "realtime-opaque-looking-id"] {
            let data = try Data(
                contentsOf: PrototypeSpecFixtures.directory
                    .appendingPathComponent("valid/\(name).json")
            )
            try PrototypeSpecStrictValidator.validate(data: data)
            let fields = try JSONDecoder().decode(JSONValue.self, from: data).objectFields ?? [:]
            XCTAssertEqual(
                try PrototypeBundleCapabilities.required(data),
                PrototypeStrictCapabilities.required(fields).sorted(),
                name
            )
            XCTAssertNoThrow(try JSONDecoder().decode(PrototypeSpec.self, from: data), name)
        }
    }

    func testChannelBudgetsMirrorTheSharedContract() {
        XCTAssertEqual(PrototypeChannelLimits.maxChannels, 4)
        XCTAssertEqual(PrototypeChannelLimits.maxFrameBytes, 65536)
        XCTAssertEqual(PrototypeChannelLimits.maxSendBytes, 16384)
        XCTAssertEqual(PrototypeChannelLimits.maxChannelsOpen, 8)
        XCTAssertEqual(PrototypeChannelLimits.flushMs, 50)
    }
}
