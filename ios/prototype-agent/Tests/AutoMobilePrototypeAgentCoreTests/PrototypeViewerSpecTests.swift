@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeViewerSpecTests: XCTestCase {
    private struct FakeReader: PrototypeViewerFileReading {
        let files: [String: Data]
        func read(path: String) -> Data? { files[path] }
    }

    private func spec(id: String = "saved", root: String = #"{"type":"text","text":"Hello"}"#) -> Data {
        Data("""
        {"id":"\(id)","window":{"placement":{"type":"fullscreen"}},"root":\(root)}
        """.utf8)
    }

    private func load(_ bundle: Data? = nil) -> PrototypeViewerContent {
        var files: [String: Data] = [:]
        files["bundle"] = bundle
        return PrototypeViewerSpecLoader(reader: FakeReader(files: files), locations: ["bundle"]).load()
    }

    private func assertInvalid(
        _ content: PrototypeViewerContent, pathContains: String = "", messageContains: String = "",
        file: StaticString = #filePath, line: UInt = #line
    ) {
        guard case let .invalid(path, message) = content else {
            return XCTFail("Expected invalid content", file: file, line: line)
        }
        XCTAssertFalse(path.isEmpty, file: file, line: line)
        XCTAssertFalse(message.isEmpty, file: file, line: line)
        if !pathContains.isEmpty {
            XCTAssertTrue(path.contains(pathContains), path, file: file, line: line)
        }
        if !messageContains.isEmpty {
            XCTAssertTrue(message.contains(messageContains), message, file: file, line: line)
        }
    }

    func testMissingIsNone() {
        guard case .none = load() else { return XCTFail("Expected no saved prototype") }
    }

    func testBundledDemo() {
        guard case let .loaded(spec, _) = load(spec(id: "bundle")) else {
            return XCTFail("Expected bundled prototype")
        }
        XCTAssertEqual(spec.id, "bundle")
        XCTAssertEqual(PrototypeViewerLayoutLoader.documentsDirectoryName, "prototype")
    }

    func testValidSpecByteCount() throws {
        let data = spec()
        let object = try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
        let compactBytes = try JSONSerialization.data(withJSONObject: object, options: .fragmentsAllowed).count
        guard case let .loaded(spec, bytes) = load(data) else { return XCTFail("Expected loaded prototype") }
        XCTAssertEqual(spec.id, "saved")
        XCTAssertEqual(bytes, compactBytes)
    }

    func testPrettyPrintedSpecUsesCompactByteCount() throws {
        let object = try JSONSerialization.jsonObject(with: spec(), options: .fragmentsAllowed)
        let compactBytes = try JSONSerialization.data(withJSONObject: object, options: .fragmentsAllowed).count
        let pretty = try JSONSerialization.data(withJSONObject: object, options: .prettyPrinted)
        // A wide indentation keeps the JSON valid without constructing a huge authored tree.
        var data = Data("{\n".utf8)
        data.append(Data(repeating: 32, count: PrototypeLimits.maxSpecBytes))
        data.append(pretty.dropFirst())
        XCTAssertGreaterThan(data.count, PrototypeLimits.maxSpecBytes)
        XCTAssertLessThanOrEqual(data.count, PrototypeLimits.maxSpecBytes * 4)
        guard case let .loaded(spec, bytes) = load(data) else { return XCTFail("Expected loaded prototype") }
        XCTAssertEqual(spec.id, "saved")
        XCTAssertEqual(bytes, compactBytes)
    }

    func testMalformedJSON() {
        assertInvalid(load(Data("not JSON".utf8)), pathContains: "$")
    }

    func testWrongTypeHasFieldPath() {
        let data = Data(#"{"id":42,"window":{"placement":{"type":"fullscreen"}},"root":{"type":"spacer"}}"#.utf8)
        assertInvalid(load(data), pathContains: "id")
    }

    func testCompactByteLimitBeforeDecoding() {
        var data = Data(#"{"padding":""#.utf8)
        data.append(Data(repeating: 97, count: PrototypeLimits.maxSpecBytes))
        data
            .append(Data(
                #"","id":"saved","window":{"placement":{"type":"fullscreen"}},"root":{"type":"spacer"}}"#
                    .utf8
            ))
        assertInvalid(load(data), pathContains: "$", messageContains: "Spec byte limit exceeded")
    }

    func testRawByteBackstopBeforeParsing() {
        assertInvalid(
            load(Data(repeating: 32, count: PrototypeLimits.maxSpecBytes * 4 + 1)),
            pathContains: "$",
            messageContains: "Spec byte limit exceeded"
        )
    }

    func testTreeDepthLimit() {
        // Same bounded child-chain construction as PrototypeLimitsTests; its helper is private.
        var root = #"{"type":"text","text":"leaf"}"#
        for _ in 0 ..< PrototypeLimits.maxDepth {
            root = "{\"type\":\"scroll\",\"child\":\(root)}"
        }
        assertInvalid(load(spec(root: root)), pathContains: "root.child", messageContains: "Tree depth limit exceeded")
    }

    func testEmptyFile() {
        assertInvalid(load(Data()), pathContains: "$", messageContains: "empty")
    }

    func testWhitespaceFile() {
        assertInvalid(load(Data(" \n\t".utf8)), pathContains: "$", messageContains: "empty")
    }

    func testUnresolvedElementAnchor() {
        assertInvalid(
            load(
                spec(root: #"{"type":"text","text":"Hello","anchor":{"type":"element","selector":{"text":"General"}}}"#)
            ),
            pathContains: "root.anchor",
            messageContains: "Element anchors must be resolved to bounds by the host"
        )
    }
}
