@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRemoteImagesTests: XCTestCase {
    private struct Fixture: Decodable {
        let name: String
        let valid: Bool
        let spec: JSONValue
    }

    override class func setUp() {
        super.setUp()
        let warm =
            Data(
                #"{"id":"warm","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"warm"}}"#
                    .utf8
            )
        try? PrototypeSpecStrictValidator.validate(data: warm)
    }

    func testSharedContract() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("test/fixtures/prototype-spec/remote-images.json")
        let cases = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: url))
        for fixture in cases {
            let data = try JSONEncoder().encode(fixture.spec)
            if fixture.valid {
                XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data), fixture.name)
                let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: data)
                if fixture.name == "accessory-https" {
                    let capabilities: Set<String> = [
                        "prototype_platform_namespace_v1",
                        PrototypeRemoteImages.capability,
                    ]
                    XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(
                        data: data,
                        supportedCapabilities: capabilities
                    ))
                    XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
                        data: data,
                        supportedCapabilities: capabilities.subtracting([PrototypeRemoteImages.capability])
                    )) { error in
                        XCTAssertTrue(String(describing: error).contains(PrototypeRemoteImages.capability))
                    }
                }
                if fixture.name == "static" {
                    var assets: Set<String> = []
                    decoded.root.collectAssets(into: &assets)
                    XCTAssertEqual(assets, ["loading"])
                    XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
                        data: data,
                        supportedCapabilities: Set(PrototypeAgentProtocol.advertisedCapabilities())
                    ))
                }
            } else {
                XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data), fixture.name)
            }
        }
    }

    func testScreenNamedValueRequiresRemoteCapability() throws {
        for names in [["value"], ["value", "other"], ["screens"]] {
            let image: JSONValue = .object(["type": .string("image"), "url": .string("https://example.com/a")])
            let spec: [String: JSONValue] = ["root": .object([
                "type": .string("stack"), "id": .string("nav"), "start": .string(names[0]),
                "screens": .object(Dictionary(uniqueKeysWithValues: names.map { ($0, image) })),
            ])]
            XCTAssertTrue(PrototypeStrictCapabilities.required(spec).contains(PrototypeRemoteImages.capability))
        }
        let literal: [String: JSONValue] = ["root": .object([
            "type": .string("text"), "text": .string("safe"), "onTap": .array([.object([
                "type": .string("emit"), "name": .string("safe"),
                "payload": .object(["value": .object(["type": .string("image"),
                                                      "url": .string("https://example.com/a")])]),
            ])]),
        ])]
        XCTAssertFalse(PrototypeStrictCapabilities.required(literal).contains(PrototypeRemoteImages.capability))
    }

    func testBindingSpanOrder() {
        XCTAssertEqual(PrototypeDataText.stateKeys("{data:/photos/{cover}"), [])
        XCTAssertEqual(PrototypeDataText.stateKeys("{platform:/device/{cover}"), [])
        XCTAssertEqual(PrototypeDataText.stateKeys("{data:/photos/a}{cover}"), ["cover"])
        XCTAssertEqual(PrototypePlatformValidator.placeholders("{data:/photos/{platform:/device/os}"), [])
        XCTAssertEqual(PrototypePlatformValidator.placeholders("{data:/photos/a}{platform:/device/os}"), ["/device/os"])
    }

    func testRemoteImagesAreNotAdvertised() {
        struct OS: OSVersionProvider { let majorVersion: Int }
        for version in [17, 18, 26] {
            XCTAssertFalse(
                PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: version))
                    .contains(PrototypeRemoteImages.capability)
            )
        }
        XCTAssertFalse(AutoMobilePrototypeCapabilities.supported.contains(PrototypeRemoteImages.capability))
    }

    func testCanonicalLimits() throws {
        let contract = try JSONDecoder().decode(JSONValue.self, from: Data(prototypeSpecContractData.utf8))
        let limits = try XCTUnwrap(contract.objectFields?["limits"]?.objectFields)
        let expected = [
            "MAX_PROTOTYPE_REMOTE_IMAGE_URL_LENGTH": PrototypeRemoteImages.maxURLLength,
            "MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES": PrototypeRemoteImages.maxDownloadBytes,
            "PROTOTYPE_REMOTE_IMAGE_ANDROID_HEAP_DIVISOR": PrototypeRemoteImages.androidHeapDivisor,
            "MAX_PROTOTYPE_REMOTE_IMAGE_IOS_MEMORY_BYTES": PrototypeRemoteImages.maxIOSMemoryBytes,
            "MAX_PROTOTYPE_REMOTE_IMAGE_DISK_BYTES": PrototypeRemoteImages.maxDiskBytes,
            "MAX_PROTOTYPE_REMOTE_IMAGE_LOADS": PrototypeRemoteImages.maxLoads,
        ]
        for (name, value) in expected {
            XCTAssertEqual(limits[name], .number(Double(value)), name)
        }
    }
}
