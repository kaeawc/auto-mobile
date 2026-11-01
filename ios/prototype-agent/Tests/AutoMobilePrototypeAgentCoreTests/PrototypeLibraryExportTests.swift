@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeLibraryExportTests: XCTestCase {
    private let root = URL(fileURLWithPath: "/app/library")
    private let storage = URL(fileURLWithPath: "/app/storage")
    private let temp = URL(fileURLWithPath: "/app/tmp/exports")
    private let first = "00000000-0000-0000-0000-000000000001"
    private let second = "00000000-0000-0000-0000-000000000002"
    private let spec = Data("""
    {"id":"demo","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}
    """.utf8)

    override static func setUp() {
        super.setUp()
        _ = PrototypeBundleFixtures.corpus
        do {
            try PrototypeSpecStrictValidator.validate(data: Data("""
            {"id":"warm","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}
            """.utf8))
        } catch { XCTFail("Warmup: \(error)") }
    }

    private func store(_ files: PrototypeLibraryFakeFileSystem, id: String? = nil) throws -> PrototypeLibraryStore {
        let generated = id ?? first
        return try PrototypeLibraryStore(
            root: root, storageRoot: storage, files: files, clock: PrototypeLibraryFakeClock(), libraryId: { generated }
        )
    }

    private func add(_ library: PrototypeLibraryStore, label: String = "Demo", spec: Data? = nil) throws {
        let bytes = spec ?? self.spec
        try library.add(.init(spec: bytes, assets: [:], fonts: [:], requires: []), label: label, source: .share)
    }

    func testExportRebuildsOnlySpecAndReferencedAssetsAndRoundTrips() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let fixture = try XCTUnwrap(PrototypeBundleFixtures.corpus.get().cases.first { $0.name == "golden-image-font" })
        let importer = PrototypeLibraryImporter(store: library, imageProbe: PrototypeLibraryFakeImageProbe())
        try importer.importData(fixture.bundleBase64, source: .share)
        let values = try library.storageURL(first).appendingPathComponent("values.json")
        files.data[values.path] = Data("private stored value".utf8)
        files.data[root.appendingPathComponent(first).appendingPathComponent("unreferenced.png").path] = Data([1])
        let exporter = PrototypeLibraryExporter(store: library, temporaryRoot: temp, files: files)
        let export = try exporter.export(first)
        let bytes = try XCTUnwrap(files.data[export.url.path])
        let entries = try PrototypeBundleZipReader.read(bytes)
        XCTAssertEqual(entries.count, 4)
        XCTAssertFalse(entries.contains { ["library.json", "manifest.json", "values.json"].contains($0.0) })
        let manifestData = try XCTUnwrap(entries.first { $0.0 == "bundle.json" }?.1)
        let manifest = try JSONDecoder().decode([String: JSONValue].self, from: manifestData)
        XCTAssertEqual(Set(manifest.keys), ["bundleFormatVersion", "specSha256", "assets", "fonts", "requires"])
        // A recipient library has no matching digest; reimporting into the sender would dedupe.
        let recipientFiles = PrototypeLibraryFakeFileSystem()
        let recipient = try store(recipientFiles, id: second)
        let imported = try PrototypeLibraryImporter(
            store: recipient, imageProbe: PrototypeLibraryFakeImageProbe()
        ).importData(bytes, source: .file)
        XCTAssertEqual(imported.libraryId, second)
        XCTAssertEqual(imported.source, .file)
        XCTAssertEqual(try library.load(first).assets, try recipient.load(second).assets)
        XCTAssertEqual(try recipientFiles.children(recipient.storageURL(second)), [])
    }

    func testExportUsesFreshDirectorySanitizesFilenameAndCleansAfterCompletionOrCancellation() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try add(library, label: "../../Private:/Demo")
        let exporter = PrototypeLibraryExporter(store: library, temporaryRoot: temp, files: files)
        let completed = try exporter.export(first)
        let cancelled = try exporter.export(first)
        XCTAssertNotEqual(completed.url.deletingLastPathComponent(), cancelled.url.deletingLastPathComponent())
        XCTAssertEqual(completed.url.pathExtension, "automobile-proto")
        XCTAssertEqual(completed.url.lastPathComponent, "______Private__Demo.automobile-proto")
        try exporter.cleanup(completed)
        try exporter.cleanup(completed)
        XCTAssertFalse(files.exists(completed.url))
        XCTAssertTrue(files.exists(cancelled.url))
        try exporter.cleanup(cancelled)
        XCTAssertEqual(try files.children(temp), [])
        XCTAssertEqual(try library.load(first).spec, spec)
    }

    func testLaunchPurgeRemovesOnlyExportRootContents() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try add(library)
        let exporter = PrototypeLibraryExporter(store: library, temporaryRoot: temp, files: files)
        let export = try exporter.export(first)
        let outside = temp.deletingLastPathComponent().appendingPathComponent("unrelated")
        files.data[outside.path] = Data([1])
        try exporter.purgeStaleExports()
        XCTAssertFalse(files.exists(export.url))
        XCTAssertTrue(files.exists(outside))
        XCTAssertEqual(try library.list().entries.count, 1)
        XCTAssertThrowsError(try exporter.cleanup(.init(url: outside, warnings: [])))
    }

    func testReplacingPendingExportCleansPreviousBeforeCreatingNext() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try add(library)
        let exporter = PrototypeLibraryExporter(store: library, temporaryRoot: temp, files: files)
        var pending: PrototypeLibraryExport?
        try exporter.prepareExport(first, pending: &pending)
        let previous = try XCTUnwrap(pending)
        files.failRemove.insert(previous.url.deletingLastPathComponent().path)
        XCTAssertThrowsError(try exporter.prepareExport(first, pending: &pending))
        XCTAssertEqual(pending?.url, previous.url)
        XCTAssertEqual(try files.children(temp).count, 1)
        files.failRemove.removeAll()
        try exporter.prepareExport(first, pending: &pending)
        XCTAssertFalse(files.exists(previous.url))
        XCTAssertNotEqual(pending?.url, previous.url)
        XCTAssertEqual(try files.children(temp).count, 1)
        files.failWrite = true
        XCTAssertThrowsError(try exporter.prepareExport(first, pending: &pending))
        XCTAssertNil(pending)
        XCTAssertEqual(try files.children(temp), [])
    }

    func testStartupCleanupFailureWarnsAndKeepsLibraryUsableWhilePurgingInbox() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try add(library)
        let exporter = PrototypeLibraryExporter(store: library, temporaryRoot: temp, files: files)
        let export = try exporter.export(first)
        files.failRemove.insert(export.url.deletingLastPathComponent().path)
        let inbox = temp.deletingLastPathComponent().appendingPathComponent("Inbox")
        files.directories.insert(inbox.path)
        let stale = inbox.appendingPathComponent("stale.json")
        files.data[stale.path] = Data([1])
        var warnings: [String] = []
        PrototypeLibraryStartupCleanup(
            exporter: exporter, inbox: PrototypeLibraryInbox(root: inbox, files: files)
        ).run { warnings.append($0) }
        XCTAssertEqual(warnings.count, 1)
        XCTAssertTrue(warnings[0].contains("Export cleanup failed"))
        XCTAssertFalse(files.exists(stale))
        XCTAssertEqual(try library.list().entries.count, 1)
        XCTAssertEqual(try library.load(first).spec, spec)
    }

    func testExportFailureCleansTemporaryDirectoryAndReportsCleanupFailures() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try add(library)
        let exporter = PrototypeLibraryExporter(store: library, temporaryRoot: temp, files: files)
        files.failWrite = true
        XCTAssertThrowsError(try exporter.export(first))
        XCTAssertEqual(try files.children(temp), [])
        // The fake's first stage was the library commit; the failed export used stage 2.
        let failedStage = temp.appendingPathComponent(".stage-3")
        files.failRemove.insert(failedStage.path)
        XCTAssertThrowsError(try exporter.export(first)) {
            XCTAssertTrue(($0 as? PrototypeLibraryFailure)?.message.contains("cleanup failed") == true)
        }
    }

    func testCleanupAndPurgeSurfaceRemovalErrors() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try add(library)
        let exporter = PrototypeLibraryExporter(store: library, temporaryRoot: temp, files: files)
        let export = try exporter.export(first)
        files.failRemove.insert(export.url.deletingLastPathComponent().path)
        XCTAssertThrowsError(try exporter.cleanup(export))
        XCTAssertThrowsError(try exporter.purgeStaleExports())
        XCTAssertTrue(files.exists(export.url))
    }

    func testPreflightWarningsContainPathsAndNeverCredentialValues() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let networkSpec = Data("""
        {"id":"request","window":{"placement":{"type":"fullscreen"}},"data":{},
        "root":{"type":"button","label":"Go","onTap":[{"type":"request","via":"device",
        "url":"https://127.0.0.1/feed?token=private-value","headers":{"Authorization":"Bearer private-value"},
        "into":"/data/result"}]}}
        """.utf8)
        try add(library, spec: networkSpec)
        let export = try PrototypeLibraryExporter(store: library, temporaryRoot: temp, files: files).export(first)
        XCTAssertEqual(Set(export.warnings.map(\.code)), [.credentialHeader, .credentialQuery, .privateHost])
        XCTAssertTrue(export.warnings.allSatisfy { $0.path.hasPrefix("$.root.onTap") })
        XCTAssertFalse(export.warnings.contains { $0.path.contains("private-value") })
        let bundle = try PrototypeBundle.read(XCTUnwrap(files.data[export.url.path]))
        XCTAssertEqual(bundle.spec, networkSpec) // Advisory scan must never redact the authored spec.
    }

    func testDeleteRemovesBothDirectoriesAndLeavesOtherPrototypeUntouched() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try add(library)
        try add(store(files, id: second))
        let firstStorage = try library.storageURL(first)
        let secondStorage = try library.storageURL(second)
        files.data[firstStorage.appendingPathComponent("values.json").path] = Data([1])
        files.data[secondStorage.appendingPathComponent("values.json").path] = Data([2])
        try library.delete(first)
        try library.delete(first)
        XCTAssertFalse(files.exists(root.appendingPathComponent(first)))
        XCTAssertFalse(files.exists(firstStorage))
        XCTAssertTrue(files.exists(secondStorage))
        XCTAssertEqual(try library.list().entries.map(\.libraryId), [second])
    }

    func testDeleteReportsEitherPartialFailureAndAttemptsBothDirectories() throws {
        for failStorage in [true, false] {
            let files = PrototypeLibraryFakeFileSystem()
            let library = try store(files)
            try add(library)
            let prototype = root.appendingPathComponent(first)
            let values = try library.storageURL(first)
            files.failRemove.insert((failStorage ? values : prototype).path)
            XCTAssertThrowsError(try library.delete(first)) {
                XCTAssertEqual(($0 as? PrototypeLibraryFailure)?.path, self.first)
                XCTAssertTrue(
                    ($0 as? PrototypeLibraryFailure)?.message
                        .contains(failStorage ? values.path : prototype.path) == true
                )
            }
            XCTAssertEqual(files.exists(prototype), !failStorage)
            XCTAssertEqual(files.exists(values), failStorage)
        }
    }

    func testDeleteAndExportRejectTraversalBeforeFileAccess() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let exporter = PrototypeLibraryExporter(store: library, temporaryRoot: temp, files: files)
        for id in ["../escape", "/absolute", "", first + "/child"] {
            let calls = files.calls
            XCTAssertThrowsError(try library.delete(id))
            XCTAssertThrowsError(try exporter.export(id))
            XCTAssertEqual(files.calls, calls)
        }
    }
}
