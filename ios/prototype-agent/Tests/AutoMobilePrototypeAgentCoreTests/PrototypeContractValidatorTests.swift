@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeContractValidatorTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        // Compile the shared contract and condition patterns outside individual test timing.
        let data =
            Data(
                "{\"id\":\"warm\",\"window\":{\"placement\":{\"type\":\"fullscreen\"}},\"root\":{\"type\":\"text\",\"text\":\"warm\"}}"
                    .utf8
            )
        try? PrototypeSpecStrictValidator.validate(data: data)
        _ = try? JSONDecoder().decode(PrototypeSpec.self, from: data)
    }

    func testOnAppearSharedFixtures() throws {
        for name in ["on-appear.json", "on-appear-repeat.json"] {
            let data = try Data(contentsOf: fixtures.appendingPathComponent("valid/\(name)"))
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data))
            XCTAssertNoThrow(try JSONDecoder().decode(PrototypeSpec.self, from: data))
        }
        for name in [
            "on-appear-empty.json",
            "on-appear-too-many.json",
            "on-appear-unconditional-child.json",
            "on-appear-unknown-action.json",
            "on-appear-reserved-request-event.json",
            "strict-gate-on-appear-prototype_timers_v1.json",
        ] {
            let value = try JSONDecoder().decode(
                JSONValue.self,
                from: Data(contentsOf: fixtures.appendingPathComponent("invalid/\(name)"))
            )
            let fields = try XCTUnwrap(value.objectFields)
            let data = try JSONEncoder().encode(fields["spec"])
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
                data: data,
                supportedCapabilities: name.hasPrefix("strict") ? [] : nil
            )) { error in
                guard case let PrototypeLoadError.invalidSpec(path, _) = error
                else { return XCTFail("Unexpected error: \(error)") }
                XCTAssertEqual(path, fields["expectedPath"]?.stringValue)
            }
        }
    }

    func testSecureLibraryPolicyPreservesNonlibraryAndOpaqueLiterals() throws {
        let unbound = fixtures.appendingPathComponent("valid/strict-library-secure-unbound.json")
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: Data(contentsOf: unbound), library: true))
        for url in try files("invalid") where url.lastPathComponent.hasPrefix("strict-library-secure-") {
            let fixture = try JSONDecoder().decode(InvalidFixture.self, from: Data(contentsOf: url))
            let data = try JSONEncoder().encode(XCTUnwrap(fixture.spec))
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data), url.lastPathComponent)
            // Message parity with TS and Kotlin: request sinks, action payloads and storage differ.
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data, library: true)) { error in
                XCTAssertEqual(
                    error as? PrototypeLoadError,
                    .invalidSpec(path: fixture.expectedPath, message: fixture.expectedMessage ?? ""),
                    url.lastPathComponent
                )
            }
        }
    }

    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec")
    }

    private func files(_ directory: String) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(
            at: fixtures.appendingPathComponent(directory),
            includingPropertiesForKeys: nil
        )
        .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private struct Inventory: Decodable {
        let valid: [String]
        let invalid: [String]
        let validCapabilities: [String: [String]]
    }

    func testCorpusInventory() throws {
        let inventory = try JSONDecoder().decode(
            Inventory.self,
            from: Data(contentsOf: fixtures.appendingPathComponent("corpus.json"))
        )
        XCTAssertEqual(try files("valid").map(\.lastPathComponent), inventory.valid)
        XCTAssertEqual(try files("invalid").map(\.lastPathComponent), inventory.invalid)
        for url in try files("valid") {
            let value = try JSONDecoder().decode(
                JSONValue.self,
                from: PrototypeStrictJSON.prepare(Data(contentsOf: url))
            )
            XCTAssertEqual(
                PrototypeStrictCapabilities.required(value.objectFields ?? [:]).sorted(),
                inventory.validCapabilities[url.lastPathComponent],
                url.lastPathComponent
            )
        }
    }

    func testValidFixtures() throws {
        let hostAnchors: Set<String> = [
            "doc-example-3.json",
            "exact-selector-depth.json",
            "floating-element-anchor.json",
        ]
        let inventory = try JSONDecoder().decode(
            Inventory.self,
            from: Data(contentsOf: fixtures.appendingPathComponent("corpus.json"))
        )
        let supported = Array(Set(inventory.validCapabilities.values.flatMap { $0 }))
        let valid = try files("valid")
        XCTAssertTrue(hostAnchors.isSubset(of: Set(valid.map(\.lastPathComponent))))
        XCTAssertFalse(valid.isEmpty)
        for url in valid {
            let data = try Data(contentsOf: url)
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data), url.lastPathComponent)
            if hostAnchors.contains(url.lastPathComponent) {
                XCTAssertThrowsError(try PrototypeEmbeddedSpec.load(data: data, supported: supported)) { error in
                    XCTAssertEqual(
                        error as? PrototypeLoadError,
                        .invalidSpec(
                            path: "root.anchor",
                            message: "Element anchors must be resolved to bounds by the host"
                        )
                    )
                }
            } else {
                XCTAssertNoThrow(
                    try PrototypeEmbeddedSpec.load(data: data, supported: supported),
                    url.lastPathComponent
                )
            }
        }
        print("Validated \(valid.count) valid fixtures; \(hostAnchors.count) retain host-anchor diagnostics")
    }

    private struct InvalidFixture: Decodable {
        let spec: JSONValue?
        let rawJson: String?
        let rawBytesBase64: String?
        let options: Options?

        struct Options: Decodable {
            let supportedCapabilities: Set<String>?
            let library: Bool?
        }

        let expectedPath: String
        let expectedMessage: String?
    }

    func testInvalidFixtures() throws {
        let invalid = try files("invalid")
        XCTAssertFalse(invalid.isEmpty)
        for url in invalid {
            let fixture = try JSONDecoder().decode(InvalidFixture.self, from: Data(contentsOf: url))
            let data: Data
            if let base64 = fixture.rawBytesBase64 { data = try XCTUnwrap(Data(base64Encoded: base64)) }
            else if let raw = fixture.rawJson { data = Data(raw.utf8) }
            else { data = try JSONEncoder().encode(XCTUnwrap(fixture.spec)) }
            do {
                try PrototypeSpecStrictValidator.validate(
                    data: data,
                    supportedCapabilities: fixture.options?.supportedCapabilities,
                    library: fixture.options?.library ?? false
                )
                XCTFail("ACCEPTED \(url.lastPathComponent)")
            } catch let PrototypeLoadError.invalidSpec(path, _) {
                XCTAssertEqual(path, fixture.expectedPath, url.lastPathComponent)
            }
        }
        print("Checked \(invalid.count) invalid fixtures; 0 exemptions")
    }

    func testHostRequestsWithoutLibrary() throws {
        for url in try files("invalid") where url.lastPathComponent.hasPrefix("strict-library-via-host") {
            let fixture = try JSONDecoder().decode(InvalidFixture.self, from: Data(contentsOf: url))
            let data = try JSONEncoder().encode(XCTUnwrap(fixture.spec))
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: data, library: true)) { error in
                XCTAssertEqual(
                    error as? PrototypeLoadError,
                    .invalidSpec(path: fixture.expectedPath, message: fixture.expectedMessage ?? "")
                )
            }
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: data), url.lastPathComponent)
            XCTAssertNoThrow(
                try PrototypeSpecStrictValidator.validate(data: data, library: false),
                url.lastPathComponent
            )
        }
    }

    func testLibraryAcceptsDeviceAndDefaultRequestsWithOpaqueHostShapedJSON() throws {
        for via in ["", #", "via":"device""#] {
            let input = #"""
            {"id":"safe","window":{"placement":{"type":"fullscreen"}},
              "data":{"opaque":{"type":"request","via":"host"}},
              "root":{"type":"button","label":"Load","onTap":[
                {"type":"request","method":"POST","url":"https://example.com"\#(via),
                  "body":{"value":{"type":"request","via":"host"}},
                  "onSuccess":[{"type":"emit","name":"done","payload":{"type":"request","via":"host"}}]}
              ]}}
            """#
            XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: Data(input.utf8), library: true))
        }
    }

    private func assertInvalid(_ json: String, path: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try PrototypeLoadError.validate(spec: Data(json.utf8)), file: file, line: line) { error in
            guard case let PrototypeLoadError.invalidSpec(actual, _) = error else {
                return XCTFail("Expected invalidSpec, got \(error)", file: file, line: line)
            }
            XCTAssertEqual(actual, path, file: file, line: line)
        }
    }

    func testDataDiagnosticPreservesPunctuationInKeys() {
        assertInvalid(
            #"{"id":"x","window":{"placement":{"type":"fullscreen"}},"root":{"type":"spacer"},"data":{"a: b":null}}"#,
            path: #"data["a: b"]"#
        )
    }

    func testUniqueStringsCompareExactUTF16() throws {
        let distinct =
            #"{"id":"x","window":{"placement":{"type":"fullscreen"}},"root":{"type":"spacer"},"storage":{"version":1,"keys":["/data/é","/data/e\u0301"]}}"#
        XCTAssertNoThrow(try PrototypeContractValidator.validate(data: Data(distinct.utf8)))
        let duplicate = distinct.replacingOccurrences(of: #"e\u0301"#, with: "é")
        assertInvalid(duplicate, path: "storage.keys[1]")
    }

    func testUnknownWidgetShowsLoadError() {
        assertInvalid(
            #"{"id":"x","window":{"placement":{"type":"fullscreen"}},"root":{"type":"futureWidget"}}"#,
            path: "root.type"
        )
    }

    func testUnknownTopLevelFieldShowsLoadError() {
        assertInvalid(
            #"{"id":"x","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"ok"},"extra":true}"#,
            path: "extra"
        )
    }

    func testMalformedStorageShowsLoadError() {
        assertInvalid(
            #"{"id":"x","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"ok"},"storage":{"keys":"bad"}}"#,
            path: "storage.keys"
        )
    }
}
