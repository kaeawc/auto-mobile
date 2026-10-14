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

    private func load(_ documents: Data? = nil, bundle: Data? = nil) -> PrototypeViewerContent {
        var files: [String: Data] = [:]
        files["documents"] = documents
        files["bundle"] = bundle
        return PrototypeViewerSpecLoader(reader: FakeReader(files: files), locations: ["documents", "bundle"]).load()
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

    func testDocumentsWins() {
        guard case let .loaded(spec, _) = load(spec(id: "documents"), bundle: spec(id: "bundle")) else {
            return XCTFail("Expected documents prototype")
        }
        XCTAssertEqual(spec.id, "documents")
    }

    func testBundleFallback() {
        guard case let .loaded(spec, _) = load(bundle: spec(id: "bundle")) else {
            return XCTFail("Expected bundled prototype")
        }
        XCTAssertEqual(spec.id, "bundle")
    }

    func testValidSpecByteCount() {
        let data = spec()
        guard case let .loaded(spec, bytes) = load(data) else { return XCTFail("Expected loaded prototype") }
        XCTAssertEqual(spec.id, "saved")
        XCTAssertEqual(bytes, data.count)
    }

    func testMalformedJSON() {
        assertInvalid(load(Data("not JSON".utf8)), pathContains: "$")
    }

    func testWrongTypeHasFieldPath() {
        let data = Data(#"{"id":42,"window":{"placement":{"type":"fullscreen"}},"root":{"type":"spacer"}}"#.utf8)
        assertInvalid(load(data), pathContains: "id")
    }

    func testByteLimitBeforeDecoding() {
        assertInvalid(
            load(Data(repeating: 32, count: PrototypeLimits.maxSpecBytes + 1)),
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

    func testInvalidDocumentsDoesNotFallBack() {
        assertInvalid(load(Data(), bundle: spec()), messageContains: "empty")
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
