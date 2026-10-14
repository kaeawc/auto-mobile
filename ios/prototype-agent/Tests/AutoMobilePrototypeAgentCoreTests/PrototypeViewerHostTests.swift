@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class ViewerHostFiles: PrototypeEndpointFiles {
    struct Write {
        let data: Data
        let path: String
        let mode: UInt16
    }

    var writes: [Write] = []
    var removals: [String] = []
    var manifestExists = true
    var checkedDirectories: [URL] = []

    func layoutExists(_ directory: URL) -> Bool {
        checkedDirectories.append(directory)
        return manifestExists
    }

    var failWrite = false
    var failRemove = false

    func writeAtomically(_ data: Data, to path: String, mode: UInt16) throws {
        if failWrite { throw CocoaError(.fileWriteNoPermission) }
        writes.append(Write(data: data, path: path, mode: mode))
    }

    func remove(path: String) throws {
        if failRemove { throw CocoaError(.fileWriteNoPermission) }
        removals.append(path)
    }
}

private final class ViewerHostTokens: PrototypeTokenSource {
    let value = String(repeating: "ab", count: 32)
    private(set) var calls = 0

    func makeToken() -> String {
        calls += 1
        return value
    }
}

final class PrototypeViewerHostTests: XCTestCase {
    private let token = "0123456789abcdef"

    func testEndpointRoundTripAndSortedKeys() throws {
        for port: UInt16 in [1, 12345, 65535] {
            let data = PrototypeViewerEndpoint.encode(port: port, token: token)
            XCTAssertEqual(String(data: data, encoding: .utf8), "{\"port\":\(port),\"token\":\"\(token)\"}")
            let decoded = try PrototypeViewerEndpoint.decode(data).get()
            XCTAssertEqual(decoded.port, port)
            XCTAssertEqual(decoded.token, token)
        }
    }

    func testEndpointRejectsInvalidJSONAndMissingPort() {
        for json in ["not json", "{", "[]", "null", "42", "\"text\""] {
            assertFailure(json, .notJSON)
        }
        assertFailure("{}", .missingPort)
        assertFailure("{\"token\":\"\(token)\"}", .missingPort)
    }

    func testEndpointRejectsInvalidPorts() {
        for port in ["0", "-1", "65536", "1.5", "true", "null", "\"1234\"", "[]", "{}"] {
            assertFailure("{\"port\":\(port),\"token\":\"\(token)\"}", .invalidPort)
        }
    }

    func testEndpointRejectsMissingAndShortTokens() {
        assertFailure("{\"port\":1}", .missingToken)
        for token in ["null", "42", "true", "[]", "{}", "\"\""] {
            assertFailure("{\"port\":1,\"token\":\(token)}", .missingToken)
        }
        assertFailure("{\"port\":1,\"token\":\"short\"}", .tokenTooShort)
        assertFailure(
            "{\"port\":1,\"token\":\"\(String(repeating: "a", count: PrototypeAgentProtocol.minimumTokenLength - 1))\"}",
            .tokenTooShort
        )
    }

    func testSecureTokenSourceSanity() {
        // This is the sole real-random sanity check; all publisher tests inject a fixed source.
        let source = SecurePrototypeTokenSource()
        let first = source.makeToken()
        let second = source.makeToken()
        for token in [first, second] {
            XCTAssertEqual(token.count, 64)
            XCTAssertTrue(token.utf8.allSatisfy { (0x30 ... 0x39).contains($0) || (0x61 ... 0x66).contains($0) })
        }
        XCTAssertNotEqual(first, second)
    }

    func testPublisherWaitsForPublishAndWritesPrivateEndpoint() throws {
        let files = ViewerHostFiles()
        let tokens = ViewerHostTokens()
        let publisher = PrototypeEndpointPublisher(root: "/container", files: files, tokens: tokens)
        XCTAssertEqual(publisher.token, tokens.value)
        XCTAssertEqual(tokens.calls, 1)
        XCTAssertTrue(files.writes.isEmpty)
        XCTAssertTrue(files.removals.isEmpty)

        try publisher.publish(port: 54321)
        XCTAssertEqual(files.writes.count, 1)
        let write = try XCTUnwrap(files.writes.first)
        XCTAssertEqual(write.path, "/container/Library/AutoMobile/prototype-endpoint.json")
        XCTAssertEqual(write.mode, 0o600)
        let endpoint = try PrototypeViewerEndpoint.decode(write.data).get()
        XCTAssertEqual(endpoint.port, 54321)
        XCTAssertEqual(endpoint.token, tokens.value)
        XCTAssertEqual(tokens.calls, 1)

        publisher.retract()
        publisher.retract()
        XCTAssertEqual(files.removals, [write.path])
    }

    func testPublisherSurfacesWriteFailureAndRejectsZeroPort() {
        let files = ViewerHostFiles()
        let publisher = PrototypeEndpointPublisher(root: "/container", files: files, tokens: ViewerHostTokens())
        files.failWrite = true
        XCTAssertThrowsError(try publisher.publish(port: 1234)) {
            XCTAssertEqual(($0 as? CocoaError)?.code, .fileWriteNoPermission)
        }
        XCTAssertThrowsError(try publisher.publish(port: 0)) {
            XCTAssertEqual($0 as? PrototypeViewerEndpoint.Failure, .invalidPort)
        }
        XCTAssertTrue(files.writes.isEmpty)
    }

    func testPublisherCanRepublishAndRetryRetraction() throws {
        let files = ViewerHostFiles()
        let publisher = PrototypeEndpointPublisher(root: "/container/", files: files, tokens: ViewerHostTokens())
        publisher.retract()
        publisher.retract()
        XCTAssertEqual(files.removals.count, 1)
        try publisher.publish(port: 1000)
        files.failRemove = true
        publisher.retract()
        XCTAssertEqual(files.removals.count, 1)
        files.failRemove = false
        publisher.retract()
        publisher.retract()
        XCTAssertEqual(files.removals.count, 2)
    }

    func testSaveBackWritesOnlySavedIDAndKeepsJSON() throws {
        let files = ViewerHostFiles()
        let save = PrototypeViewerSaveBack(
            savedSpecId: "saved",
            layoutDirectory: URL(fileURLWithPath: "/container/Documents/prototype"),
            files: files, layoutExists: files.layoutExists
        )
        let spec: [String: Any] = ["id": "saved", "root": ["type": "text", "text": "updated"]]
        XCTAssertFalse(save.persistIfSaved(specId: "other", specJSON: spec))
        XCTAssertTrue(files.writes.isEmpty)
        XCTAssertTrue(save.persistIfSaved(specId: "saved", specJSON: spec))
        XCTAssertEqual(files.writes.count, 1)
        let write = try XCTUnwrap(files.writes.first)
        XCTAssertEqual(write.path, "/container/Documents/prototype/spec.json")
        XCTAssertEqual(write.mode, 0o600)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: write.data) as? [String: Any])
        XCTAssertEqual(object["id"] as? String, "saved")
        XCTAssertEqual((object["root"] as? [String: String])?["text"], "updated")
    }

    func testSaveBackWithoutSavedIDDoesNothing() {
        let files = ViewerHostFiles()
        let save = PrototypeViewerSaveBack(
            savedSpecId: nil,
            layoutDirectory: URL(fileURLWithPath: "/container/Documents/prototype"),
            files: files,
            layoutExists: files.layoutExists
        )
        XCTAssertFalse(save.persistIfSaved(specId: "new", specJSON: ["id": "new"]))
        XCTAssertTrue(files.writes.isEmpty)
    }

    func testSaveBackFailureDoesNotThrowOrWrite() {
        let files = ViewerHostFiles()
        let save = PrototypeViewerSaveBack(
            savedSpecId: "saved",
            layoutDirectory: URL(fileURLWithPath: "/container/Documents/prototype"),
            files: files,
            layoutExists: files.layoutExists
        )
        files.failWrite = true
        XCTAssertFalse(save.persistIfSaved(specId: "saved", specJSON: ["id": "saved"]))
        files.failWrite = false
        for value in [Double.nan, Double.infinity, -Double.infinity] {
            XCTAssertFalse(save.persistIfSaved(specId: "saved", specJSON: value))
            XCTAssertFalse(save.persistIfSaved(specId: "saved", specJSON: ["value": value]))
        }
        XCTAssertTrue(files.writes.isEmpty)
    }

    func testSaveBackWithoutManifestDoesNotWrite() {
        let files = ViewerHostFiles()
        files.manifestExists = false
        let directory = URL(fileURLWithPath: "/container/Documents/prototype")
        let save = PrototypeViewerSaveBack(
            savedSpecId: "saved", layoutDirectory: directory,
            files: files, layoutExists: files.layoutExists
        )
        XCTAssertFalse(save.persistIfSaved(specId: "saved", specJSON: ["id": "saved"]))
        XCTAssertEqual(files.checkedDirectories, [directory])
        XCTAssertTrue(files.writes.isEmpty)
        XCTAssertTrue(files.removals.isEmpty)
    }

    func testSaveBackOversizedSpecDoesNotWrite() {
        let files = ViewerHostFiles()
        let save = PrototypeViewerSaveBack(
            savedSpecId: "saved", layoutDirectory: URL(fileURLWithPath: "/container/Documents/prototype"),
            files: files, layoutExists: files.layoutExists
        )
        // JSON quotes make the encoded data one byte larger than the saved-layout cap.
        let spec = String(repeating: "x", count: PrototypeSavedLayoutLimits().maxSpecBytes - 1)
        XCTAssertFalse(save.persistIfSaved(specId: "saved", specJSON: spec))
        XCTAssertTrue(files.writes.isEmpty)
        XCTAssertTrue(files.removals.isEmpty)
    }

    func testFoundationEndpointWriteIsPrivateAndAtomicallyReplaces() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("prototype-viewer-\(UUID().uuidString)")
        let manager = FileManager.default
        defer { try? manager.removeItem(at: directory) }
        let destination = directory.appendingPathComponent("endpoint.json")
        let files = FoundationPrototypeEndpointFiles()
        let original = Data("original".utf8)
        let replacement = Data("replacement".utf8)
        try files.writeAtomically(original, to: destination.path, mode: 0o600)
        let originalAttributes = try manager.attributesOfItem(atPath: destination.path)
        XCTAssertEqual((originalAttributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        // An open handle keeps the old inode: in-place truncation would change these bytes.
        let reader = try FileHandle(forReadingFrom: destination)
        defer { try? reader.close() }
        try files.writeAtomically(replacement, to: destination.path, mode: 0o600)
        XCTAssertEqual(try reader.readToEnd(), original)
        XCTAssertEqual(try Data(contentsOf: destination), replacement)
        let attributes = try manager.attributesOfItem(atPath: destination.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual(try manager.contentsOfDirectory(atPath: directory.path), ["endpoint.json"])
    }

    func testSaveBackAllowsJSONFragments() throws {
        let files = ViewerHostFiles()
        let save = PrototypeViewerSaveBack(
            savedSpecId: "saved",
            layoutDirectory: URL(fileURLWithPath: "/container/Documents/prototype"),
            files: files,
            layoutExists: files.layoutExists
        )
        XCTAssertTrue(save.persistIfSaved(specId: "saved", specJSON: "fragment"))
        let write = try XCTUnwrap(files.writes.first)
        XCTAssertEqual(String(data: write.data, encoding: .utf8), "\"fragment\"")
    }

    func testCapabilitiesRemoveExactlyWindowCaptureCapabilities() {
        let capture = [
            PrototypeAgentProtocol.hideForCaptureRequest,
            PrototypeAgentProtocol.restoreAfterCaptureRequest,
            PrototypeAgentProtocol.screenshotHideCapability,
        ]
        let retained = ["show_prototype", "other", PrototypeLifecycleMode.persistenceReplayCapability, "other"]
        XCTAssertEqual(PrototypeViewerHostCapabilities.advertised(capture + retained + capture), retained)
        let base = PrototypeLifecycleMode.standalone.advertising(PrototypeAgentProtocol.capabilities)
        XCTAssertEqual(PrototypeViewerHostCapabilities.advertised(base), base.filter { !capture.contains($0) })
    }

    private func assertFailure(
        _ json: String, _ expected: PrototypeViewerEndpoint.Failure,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        switch PrototypeViewerEndpoint.decode(Data(json.utf8)) {
        case .success: XCTFail("Expected \(expected)", file: file, line: line)
        case let .failure(actual): XCTAssertEqual(actual, expected, file: file, line: line)
        }
    }
}
