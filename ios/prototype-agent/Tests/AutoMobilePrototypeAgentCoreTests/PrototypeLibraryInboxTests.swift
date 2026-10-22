@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeLibraryInboxTests: XCTestCase {
    private let root = URL(fileURLWithPath: "/app/Documents/Inbox")

    func testCleanupRemovesOnlyDescendantsWithCompletePathComponents() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let inbox = PrototypeLibraryInbox(root: root, files: files)
        let copy = root.appendingPathComponent("import.json")
        let outside = root.deletingLastPathComponent().appendingPathComponent("import.json")
        let sibling = URL(fileURLWithPath: root.path + "-other/import.json")
        files.directories.insert(root.path)
        for url in [copy, outside, sibling] {
            files.data[url.path] = Data([1])
        }
        for url in [outside, sibling, root, root.appendingPathComponent("../import.json")] {
            try inbox.cleanup(url)
        }
        XCTAssertTrue(files.exists(outside))
        XCTAssertTrue(files.exists(sibling))
        XCTAssertTrue(files.exists(root))
        try inbox.cleanup(copy)
        try inbox.cleanup(copy)
        XCTAssertFalse(files.exists(copy))
    }

    func testLaunchPurgePreservesDocumentsOutsideInboxAndReportsRemovalErrors() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let inbox = PrototypeLibraryInbox(root: root, files: files)
        try inbox.purgeStaleFiles() // A fresh install need not have an Inbox yet.
        files.directories.insert(root.path)
        let stale = root.appendingPathComponent("stale.json")
        let outside = root.deletingLastPathComponent().appendingPathComponent("owned.json")
        files.data[stale.path] = Data([1])
        files.data[outside.path] = Data([2])
        files.failRemove.insert(stale.path)
        XCTAssertThrowsError(try inbox.purgeStaleFiles())
        files.failRemove.removeAll()
        try inbox.purgeStaleFiles()
        XCTAssertFalse(files.exists(stale))
        XCTAssertTrue(files.exists(outside))
    }

    func testSymlinkEscapingInboxNeverDeletesExternalTarget() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let root = directory.appendingPathComponent("Inbox")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let outside = directory.appendingPathComponent("external.json")
        try Data([1]).write(to: outside)
        let alias = root.appendingPathComponent("alias.json")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: outside)
        let inbox = PrototypeLibraryInbox(root: root)
        try inbox.cleanup(alias)
        try inbox.purgeStaleFiles()
        XCTAssertEqual(try Data(contentsOf: outside), Data([1]))
        XCTAssertTrue(FileManager.default.fileExists(atPath: alias.path))
    }
}
