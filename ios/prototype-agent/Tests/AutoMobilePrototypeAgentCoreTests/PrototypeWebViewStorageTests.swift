@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeWebViewStorageTests: XCTestCase {
    @MainActor
    func testLibraryImportUsesTheRegisteredCapability() async throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let spec = try Data(contentsOf: repository.appendingPathComponent(
            "test/fixtures/prototype-spec/valid/webview-node.json"
        ))
        let registry = PrototypePlatformRegistry(modules: [PrototypeWebViewModule()])
        let capabilities = Set(AutoMobilePrototypeCapabilities.supported + registry.capabilities)
        let store = try PrototypeLibraryStore(
            root: URL(fileURLWithPath: "/app/library", isDirectory: true),
            storageRoot: URL(fileURLWithPath: "/app/storage", isDirectory: true),
            files: PrototypeLibraryFakeFileSystem(), clock: PrototypeLibraryFakeClock(),
            libraryId: { "00000000-0000-0000-0000-000000000001" },
            supportedCapabilities: capabilities
        )
        let importer = PrototypeLibraryImporter(store: store)
        let entry = try importer.importData(spec, source: .file)
        XCTAssertEqual(try importer.importData(spec, source: .mcp), entry)
        let loaded = try store.load(entry.libraryId)
        let rendered = try PrototypeEmbeddedSpec.load(data: loaded.spec, supported: Array(capabilities))
        XCTAssertEqual(rendered.spec.root.children?.last?.webViewURL, "https://example.com/post/hello")
    }

    @MainActor
    func testLibraryResetAndDeleteWipeOnlyTheAffectedWebsiteDataStore() async throws {
        let files = PrototypeLibraryFakeFileSystem()
        let root = URL(fileURLWithPath: "/app/library", isDirectory: true)
        let store = try PrototypeLibraryStore(
            root: root, storageRoot: URL(fileURLWithPath: "/app/storage", isDirectory: true),
            files: files, clock: PrototypeLibraryFakeClock()
        )
        let id = "00000000-0000-0000-0000-000000000001"
        let other = "00000000-0000-0000-0000-000000000002"
        let identifier = try XCTUnwrap(UUID(uuidString: id))
        let prototype = root.appendingPathComponent(id, isDirectory: true)
        try files.createDirectory(prototype)
        let storage = try store.storageURL(id)
        let otherStorage = try store.storageURL(other)
        let wiper = FakeWebDataWiper()

        try await store.resetStorage(id, webDataWiper: wiper)
        XCTAssertFalse(files.exists(storage))
        XCTAssertTrue(files.exists(prototype))
        XCTAssertTrue(files.exists(otherStorage))
        XCTAssertEqual(wiper.identifiers, [identifier])

        try await store.delete(id, webDataWiper: wiper)
        XCTAssertFalse(files.exists(prototype))
        XCTAssertTrue(files.exists(otherStorage))
        XCTAssertEqual(wiper.identifiers, [identifier, identifier])
    }
}

@MainActor
private final class FakeWebDataWiper: PrototypeWebDataWiper {
    private(set) var identifiers: [UUID] = []

    func wipe(_ identifier: UUID) async { identifiers.append(identifier) }
}
