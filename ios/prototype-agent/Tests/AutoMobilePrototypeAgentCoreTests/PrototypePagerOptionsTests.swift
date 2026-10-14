@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypePagerOptionsTests: XCTestCase {
    private var validFixtures: [(name: String, data: Data, root: JSONValue)] = []
    private var invalidFixtures: [(name: String, fixture: PrototypeSpecFixtures.Invalid)] = []

    /// Discover fixtures outside the timed assertions; only pager specs are decoded in the test.
    override func setUpWithError() throws {
        try super.setUpWithError()
        let directory = PrototypeSpecFixtures.directory.appendingPathComponent("valid")
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        validFixtures = try files.compactMap { file in
            let data = try Data(contentsOf: file)
            let json = try JSONDecoder().decode(JSONValue.self, from: data)
            guard case let .object(spec) = json, let root = spec["root"], containsOptions(root) else { return nil }
            return (file.lastPathComponent, data, root)
        }
        let invalidDirectory = PrototypeSpecFixtures.directory.appendingPathComponent("invalid")
        invalidFixtures = try FileManager.default.contentsOfDirectory(atPath: invalidDirectory.path)
            .filter { $0.hasPrefix("pager-") && $0.hasSuffix(".json") }.sorted()
            .map { try ($0, PrototypeSpecFixtures.invalid(String($0.dropLast(5)))) }
    }

    private func node(_ options: String = "") throws -> PrototypeNode {
        try JSONDecoder().decode(
            PrototypeNode.self, from: Data(#"{"type":"pager"\#(options)}"#.utf8)
        )
    }

    func testCapabilityIsAdvertised() {
        XCTAssertEqual(PrototypeAgentProtocol.pagerOptionsCapability, "prototype_pager_options_v1")
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.pagerOptionsCapability))
    }

    func testEverySharedValidFixtureWithPagerOptionsDecodesItsFields() throws {
        for fixture in validFixtures {
            let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: fixture.data)
            try assertOptions(fixture.root, decoded.root)
        }
        XCTAssertTrue(validFixtures.contains { $0.name == "pager-options.json" })
    }

    private func containsOptions(_ value: JSONValue) -> Bool {
        guard case let .object(node) = value else { return false }
        if node["type"] == .string("pager"),
           ["axis", "pageSpacing", "peek", "pageSize"].contains(where: { node[$0] != nil })
        {
            return true
        }
        if case let .array(children)? = node["children"], children.contains(where: containsOptions) { return true }
        return node["child"].map(containsOptions) ?? false
    }

    private func assertOptions(_ value: JSONValue, _ decoded: PrototypeNode) throws {
        guard case let .object(node) = value else { return XCTFail("Expected node") }
        if node["type"] == .string("pager") {
            XCTAssertEqual(decoded.axis, node["axis"]?.stringValue)
            XCTAssertEqual(decoded.pageSpacing, node["pageSpacing"]?.numberValue)
            if case let .object(peek)? = node["peek"] {
                XCTAssertNotNil(decoded.peek)
                XCTAssertEqual(decoded.peek?.start, peek["start"]?.numberValue)
                XCTAssertEqual(decoded.peek?.end, peek["end"]?.numberValue)
            } else { XCTAssertNil(decoded.peek) }
            if case let .object(size)? = node["pageSize"] {
                XCTAssertEqual(decoded.pageSize, try .fixed(XCTUnwrap(size["dp"]?.numberValue)))
            } else if node["pageSize"] == .string("fill") {
                XCTAssertEqual(decoded.pageSize, .fill)
            } else { XCTAssertNil(decoded.pageSize) }
        }
        if case let .array(children)? = node["children"] {
            let decodedChildren = decoded.children ?? []
            XCTAssertEqual(decodedChildren.count, children.count)
            for (authored, child) in zip(children, decodedChildren) {
                try assertOptions(authored, child)
            }
        }
        if let child = node["child"] { try assertOptions(child, XCTUnwrap(decoded.child)) }
    }

    func testEverySharedInvalidPagerFixtureFailsWithItsPathAndMessage() throws {
        XCTAssertEqual(invalidFixtures.count, 8)
        for (filename, fixture) in invalidFixtures {
            XCTAssertThrowsError(try fixture.decode(), filename) { error in
                guard case let DecodingError.dataCorrupted(context) = error else {
                    return XCTFail("\(filename): \(error)")
                }
                XCTAssertEqual(
                    context.debugDescription,
                    "\(fixture.expectedPath): \(fixture.expectedMessage ?? "Invalid enum value")", filename
                )
            }
        }
    }

    func testLayoutPinsLegacyAndExplicitNoOpOptions() throws {
        let legacy = try PrototypePagerLayout(node: node())
        XCTAssertTrue(legacy.legacy)
        XCTAssertFalse(legacy.vertical)
        XCTAssertEqual(legacy.spacing, 0)
        XCTAssertEqual(legacy.start, 0)
        XCTAssertEqual(legacy.end, 0)
        XCTAssertEqual(legacy.pageSize, .fill)
        for options in [
            #", "axis":"horizontal""#, #", "pageSpacing":0"#, #", "peek":{}"#, #", "pageSize":"fill""#,
            #", "peek":{"start":0}"#, #", "peek":{"end":0}"#, #", "peek":{"start":0,"end":0}"#,
            #", "axis":"horizontal", "pageSpacing":0, "peek":{"start":0,"end":0}, "pageSize":"fill""#,
        ] {
            XCTAssertEqual(try PrototypePagerLayout(node: node(options)), legacy, options)
        }
    }

    func testLayoutResolvesBothAxesMarginsAndFixedSize() throws {
        for axis in ["horizontal", "vertical"] {
            let layout = try PrototypePagerLayout(node: node(
                #", "axis":"\#(axis)", "pageSpacing":8, "peek":{"start":12,"end":24}, "pageSize":{"dp":180}"#
            ))
            XCTAssertFalse(layout.legacy)
            XCTAssertEqual(layout.vertical, axis == "vertical")
            XCTAssertEqual(layout.spacing, 8)
            XCTAssertEqual(layout.start, 12)
            XCTAssertEqual(layout.end, 24)
            XCTAssertEqual(layout.pageSize, .fixed(180))
        }
        let partial = try PrototypePagerLayout(node: node(#", "peek":{"end":7}"#))
        XCTAssertEqual(partial.start, 0)
        XCTAssertEqual(partial.end, 7)
    }

    func testMaxPagerDpPendingContractWideMaximaAndStrictShapes() throws {
        XCTAssertEqual(PrototypePagerOptions.maxPagerDp, 10000)
        let invalid = [
            (#", "pageSpacing":null"#, "root.pageSpacing: Invalid number value"),
            (#", "peek":{"end":10001}"#, "root.peek.end: Invalid number value"),
            (#", "pageSize":{"dp":0.0000001}"#, "root.pageSize.dp: Invalid number value"),
            (#", "pageSize":{"dp":10001}"#, "root.pageSize.dp: Invalid number value"),
            (#", "pageSize":{"dp":1,"extra":0}"#, "root.pageSize.extra: Unknown property"),
            (#", "pageSize":{}"#, "root.pageSize.dp: Required"),
        ]
        for (options, message) in invalid {
            let json = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"type":"pager"\#(options)}"#.utf8))
            XCTAssertThrowsError(try PrototypePagerOptions.validate(json)) { error in
                guard case let DecodingError.dataCorrupted(context) = error else { return XCTFail("\(error)") }
                XCTAssertEqual(context.debugDescription, message)
            }
        }
        let infinite = JSONValue.object(["type": .string("pager"), "pageSpacing": .number(.infinity)])
        XCTAssertThrowsError(try PrototypePagerOptions.validate(infinite))
    }
}
