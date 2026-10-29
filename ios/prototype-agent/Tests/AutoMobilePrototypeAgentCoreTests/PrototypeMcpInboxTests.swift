@testable import AutoMobilePrototypeAgentCore
import Foundation
import os
import XCTest

/// The inbox actor serializes calls; the lock also protects assertions after an await.
private struct McpFiles: PrototypeLibraryFileSystem, Sendable {
    let state = OSAllocatedUnfairLock(uncheckedState: PrototypeLibraryFakeFileSystem())
    let writes = OSAllocatedUnfairLock(initialState: 0)
    func exists(_ p: URL) -> Bool { state.withLock { $0.exists(p) } }
    func modifiedAt(_ p: URL) -> Date? { state.withLock { $0.modifiedAt(p) } }
    func children(_ p: URL) throws -> [String] { try state.withLock { try $0.children(p) } }
    func read(_ p: URL, cap: Int) throws -> Data { try state.withLock { try $0.read(p, cap: cap) } }
    func byteCount(_ p: URL) throws -> Int { try state.withLock { try $0.byteCount(p) } }
    func createDirectory(_ p: URL) throws { try state.withLock { try $0.createDirectory(p) } }
    func writeAtomic(_ p: URL, bytes: Data) throws {
        try state.withLock { try $0.writeAtomic(p, bytes: bytes) }
        writes.withLock { $0 += 1 }
    }

    func excludeFromBackup(_ p: URL) throws { try state.withLock { try $0.excludeFromBackup(p) } }
    func assertRealDirectory(_ p: URL) throws { try state.withLock { try $0.assertRealDirectory(p) } }
    func assertAbsent(_ p: URL) throws { try state.withLock { try $0.assertAbsent(p) } }
    func makeStagingDirectory(parent: URL, mode: UInt16) throws -> URL {
        try state.withLock { try $0.makeStagingDirectory(parent: parent, mode: mode) }
    }

    func mkdir(_ p: URL, mode: UInt16) throws { try state.withLock { try $0.mkdir(p, mode: mode) } }
    func writeExclusiveNoFollow(_ p: URL, bytes: Data) throws {
        try state.withLock { try $0.writeExclusiveNoFollow(p, bytes: bytes) }
    }

    func rename(from: URL, to: URL) throws { try state.withLock { try $0.rename(from: from, to: to) } }
    func remove(_ p: URL) throws { try state.withLock { try $0.remove(p) } }
}

final class PrototypeMcpInboxTests: XCTestCase {
    private let root = URL(fileURLWithPath: "/mcp")
    private let id = "0f8fad5b-d9cb-469f-a165-70867728950e"
    private var entry: PrototypeLibraryEntry {
        PrototypeLibraryEntry(
            libraryId: id, label: "Demo", importedAt: 1, lastOpenedAt: 1, source: .mcp,
            specSha256: String(repeating: "a", count: 64), requires: [], pinned: false
        )
    }

    private func result(_ files: McpFiles, request: String = "r") throws -> [String: String] {
        try JSONDecoder().decode(
            [String: String].self,
            from: files.read(root.appendingPathComponent("results/\(request).json"), cap: 4096)
        )
    }

    @MainActor
    func testRequestFilesDispatchImportAndOpenAndConsumeMalformedRequests() async throws {
        let files = McpFiles(); let entry = entry; let id = id
        let inbox = PrototypeMcpInbox(
            root: root, makeFiles: { files }, importBundle: { _, label in
                XCTAssertEqual(label, "Demo"); return entry
            }, entries: { [entry] }, warning: { _ in }
        )
        try await inbox.ensureDirectories()
        let delivery = try files.read(root.appendingPathComponent("delivery"), cap: 64)
        XCTAssertEqual(String(decoding: delivery, as: UTF8.self), "file-inbox-v1")
        files.state.withLock {
            $0.data["/mcp/inbox/imp.request"] = Data(#"{"action":"import","label":"Demo"}"#.utf8)
            $0.data["/mcp/inbox/imp.automobile-proto"] = Data([1])
            $0.data["/mcp/inbox/opn.request"] = Data("{\"action\":\"open\",\"libraryId\":\"\(id)\"}".utf8)
            $0.data["/mcp/inbox/bad.request"] = Data("bad".utf8)
            $0.data["/mcp/inbox/bad.automobile-proto"] = Data([1])
            $0.data["/mcp/inbox/staged.request.tmp"] = Data("bad".utf8)
        }
        let opened = await inbox.receiveFiles(screen: "1206x2622")
        XCTAssertEqual(opened.count, 3)
        let command = try XCTUnwrap(opened.first { $0.1 != nil })
        XCTAssertEqual(command.0, .open(request: "opn", libraryId: id))
        XCTAssertEqual(command.1, entry)
        try await inbox.reportOpened(command.0, entry: XCTUnwrap(command.1))
        XCTAssertEqual(try result(files, request: "imp")["status"], "imported")
        XCTAssertEqual(try result(files, request: "opn")["status"], "opened")
        XCTAssertEqual(try result(files, request: "bad")["status"], "rejected")
        XCTAssertEqual(try result(files, request: "bad")["path"], "action")
        for name in ["imp.request", "opn.request", "bad.request", "bad.automobile-proto", "imp.automobile-proto"] {
            XCTAssertFalse(files.exists(root.appendingPathComponent("inbox/" + name)))
        }
        XCTAssertTrue(files.exists(root.appendingPathComponent("inbox/staged.request.tmp")))
        let again = await inbox.receiveFiles()
        XCTAssertTrue(again.isEmpty)
    }

    @MainActor
    func testRetriedSaveFilesReturnTheSameLibraryEntryWithoutWrites() async throws {
        let files = McpFiles()
        let libraryFiles = PrototypeLibraryFakeFileSystem()
        let library = try PrototypeLibraryStore(
            root: URL(fileURLWithPath: "/library"), storageRoot: URL(fileURLWithPath: "/storage"),
            files: libraryFiles, clock: PrototypeLibraryFakeClock(), libraryId: { self.id }
        )
        let locked = OSAllocatedUnfairLock(uncheckedState: library)
        let spec =
            Data(#"{"id":"demo","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}"#.utf8)
        let inbox = PrototypeMcpInbox(
            root: root, makeFiles: { files }, importBundle: { _, label in
                try locked.withLock { try PrototypeLibraryImporter(store: $0).importData(
                    spec,
                    source: .mcp,
                    label: label
                ) }
            }, entries: { try locked.withLock { try $0.list().entries } }, warning: { _ in }
        )
        try await inbox.ensureDirectories()
        for request in ["first", "retry"] {
            files.state.withLock {
                $0.data["/mcp/inbox/\(request).request"] = Data("{\"action\":\"import\",\"label\":\"\(request)\"}".utf8)
                $0.data["/mcp/inbox/\(request).automobile-proto"] = spec
            }
            _ = await inbox.receiveFiles()
            XCTAssertEqual(try result(files, request: request)["status"], "imported")
            XCTAssertEqual(try result(files, request: request)["libraryId"], id)
            XCTAssertEqual(try result(files, request: request)["label"], "first")
        }
        XCTAssertEqual(try library.list().entries.count, 1)
    }

    @MainActor
    func testImportAndCleanupSuccessAndFailure() async throws {
        for fails in [false, true] {
            let files = McpFiles()
            let url = root.appendingPathComponent("inbox/r.automobile-proto")
            files.state.withLock { $0.data[url.path] = Data([1]) }
            let entry = entry
            let inbox = PrototypeMcpInbox(
                root: root, makeFiles: { files }, importBundle: { received, label in
                    XCTAssertEqual(received, url); XCTAssertEqual(label, "Override")
                    if fails { throw PrototypeLibraryImportFailure.invalid(path: "root.text", message: "Bad text") }
                    return entry
                }, entries: { [] }, warning: { _ in }
            )
            _ = await inbox.handle(.importBundle(request: "r", label: " Override "))
            XCTAssertFalse(files.exists(url))
            let output = try result(files)
            XCTAssertEqual(output["status"], fails ? "rejected" : "imported")
            XCTAssertEqual(output[fails ? "path" : "libraryId"], fails ? "root.text" : id)
            XCTAssertEqual(files.writes.withLock { $0 }, 1)
            if !fails {
                let bytes = try files.read(root.appendingPathComponent("results/r.json"), cap: 4096)
                let expected = "{\"label\":\"Demo\",\"libraryId\":\"\(id)\","
                    + "\"request\":\"r\",\"status\":\"imported\"}"
                XCTAssertEqual(String(decoding: bytes, as: UTF8.self), expected)
            }
        }
    }

    @MainActor
    func testResultsCarryTheScreenTheAppWasOn() async throws {
        let files = McpFiles(); let entry = entry
        files.state.withLock { $0.data["/mcp/inbox/imp.automobile-proto"] = Data([1]) }
        let inbox = PrototypeMcpInbox(
            root: root, makeFiles: { files }, importBundle: { _, _ in entry },
            entries: { [entry] }, warning: { _ in }
        )
        _ = await inbox.handle(.importBundle(request: "imp", label: nil), screen: "1902x1338")
        XCTAssertEqual(try result(files, request: "imp")["screen"], "1902x1338")
        let command = PrototypeMcpRequest.open(request: "opn", libraryId: id)
        _ = await inbox.handle(command)
        await inbox.reportOpened(command, entry: entry, screen: "1206x2622")
        XCTAssertEqual(try result(files, request: "opn")["screen"], "1206x2622")
        XCTAssertEqual(try result(files, request: "opn")["status"], "opened")
    }

    func testScreenFormatRejectsUnusableSizes() {
        XCTAssertEqual(PrototypeMcpScreen.format(widthPx: 1902, heightPx: 1338), "1902x1338")
        XCTAssertEqual(PrototypeMcpScreen.format(widthPx: 1205.6, heightPx: 2622), "1206x2622")
        XCTAssertNil(PrototypeMcpScreen.format(widthPx: 0, heightPx: 1338))
        XCTAssertNil(PrototypeMcpScreen.format(widthPx: .nan, heightPx: 1338))
        XCTAssertNil(PrototypeMcpScreen.format(widthPx: 1902, heightPx: .infinity))
        XCTAssertNil(PrototypeMcpScreen.format(widthPx: 200_000, heightPx: 1338))
    }

    @MainActor
    func testMissingInboxAndInvalidLabel() async throws {
        for label in [nil, "\u{202E}bad"] as [String?] {
            let files = McpFiles()
            let inbox = PrototypeMcpInbox(
                root: root, makeFiles: { files }, importBundle: { _, _ in
                    XCTFail("Must not import"); throw POSIXError(.EIO)
                }, entries: { [] }, warning: { _ in }
            )
            _ = await inbox.handle(.importBundle(request: "r", label: label))
            XCTAssertEqual(try result(files)["path"], label == nil ? "inbox" : "label")
        }
    }

    @MainActor
    func testCapabilityAndByteCapPaths() async throws {
        for capability in [true, false] {
            let files = McpFiles(); files.state.withLock { $0.data["/mcp/inbox/r.automobile-proto"] = Data([1]) }
            let inbox = PrototypeMcpInbox(
                root: root, makeFiles: { files }, importBundle: { _, _ in
                    if capability { throw PrototypeLibraryImportFailure.needsNewerViewer(missing: ["new"]) }
                    throw PrototypeLibraryImportFailure.invalid(path: "$", message: "Import byte cap exceeded")
                }, entries: { [] }, warning: { _ in }
            )
            _ = await inbox.handle(.importBundle(request: "r", label: nil))
            XCTAssertEqual(try result(files)["path"], capability ? "capability" : "content")
        }
    }

    @MainActor
    func testOpenDefersResultUntilLoadedAndWritesExactlyOnce() async throws {
        for success in [true, false] {
            let files = McpFiles(); let entry = entry
            let inbox = PrototypeMcpInbox(
                root: root, makeFiles: { files }, importBundle: { _, _ in entry },
                entries: { [entry] }, warning: { _ in }
            )
            let command = PrototypeMcpRequest.open(request: "r", libraryId: id)
            let opened = await inbox.handle(command)
            XCTAssertEqual(opened, entry); XCTAssertEqual(files.writes.withLock { $0 }, 0)
            if success { await inbox.reportOpened(command, entry: entry) }
            else { await inbox.reportOpenFailed(command) }
            await inbox.reportOpenFailed(command)
            await inbox.reportOpened(command, entry: entry)
            XCTAssertEqual(files.writes.withLock { $0 }, 1)
            XCTAssertEqual(try result(files)["status"], success ? "opened" : "rejected")
            if !success { XCTAssertEqual(try result(files)["path"], "viewer") }
        }
    }

    @MainActor
    func testNotFoundMalformedAndListingFailure() async throws {
        for kind in 0 ... 2 {
            let files = McpFiles()
            let inbox = PrototypeMcpInbox(
                root: root, makeFiles: { files }, importBundle: { _, _ in throw POSIXError(.EIO) }, entries: {
                    if kind == 2 { throw POSIXError(.EIO) }; return []
                }, warning: { _ in }
            )
            _ = await inbox.handle(.open(request: "r", libraryId: kind == 0 ? "../bad" : id))
            XCTAssertEqual(try result(files)["status"], kind == 2 ? "rejected" : "not_found")
            if kind == 2 { XCTAssertEqual(try result(files)["path"], "library") }
        }
    }

    @MainActor
    func testConcurrentDuplicateRequestsCommitOneResult() async throws {
        let files = McpFiles(); files.state.withLock { $0.data["/mcp/inbox/r.automobile-proto"] = Data([1]) }
        let entry = entry
        let inbox = PrototypeMcpInbox(
            root: root, makeFiles: { files }, importBundle: { _, _ in entry },
            entries: { [] }, warning: { _ in }
        )
        async let first = inbox.handle(.importBundle(request: "r", label: nil))
        async let second = inbox.handle(.importBundle(request: "r", label: nil))
        _ = await(first, second)
        XCTAssertEqual(files.writes.withLock { $0 }, 1)
        XCTAssertEqual(try result(files)["status"], "imported")
    }

    @MainActor
    func testDirectoriesPreserveColdLaunchInboxAndWriteFailureWarns() async throws {
        let files = McpFiles()
        let url = root.appendingPathComponent("inbox/r.automobile-proto")
        files.state.withLock { $0.data[url.path] = Data([1]) }
        let warnings = OSAllocatedUnfairLock(initialState: [String]())
        let entry = entry
        let inbox = PrototypeMcpInbox(
            root: root, makeFiles: { files }, importBundle: { _, _ in entry }, entries: { [] },
            warning: { message in warnings.withLock { $0.append(message) } }
        )
        try await inbox.ensureDirectories()
        XCTAssertTrue(files.exists(url))
        files.state.withLock { $0.failWrite = true }
        _ = await inbox.handle(.unsupported(request: "r", reason: "Unknown action"))
        XCTAssertEqual(warnings.withLock { $0.count }, 1)
        XCTAssertTrue(warnings.withLock { $0[0].contains("Cannot publish MCP result") })
    }

    @MainActor
    func testSweepRemovesOldResultsAndBundlesButKeepsFreshUnknownAndFolders() async throws {
        let files = McpFiles()
        let now = Date(timeIntervalSince1970: 10_000_000)
        let old = now.addingTimeInterval(-prototypeMcpOrphanMaxAge - 60)
        let fresh = now.addingTimeInterval(-prototypeMcpOrphanMaxAge + 60)
        let paths = [
            "/mcp/results/old.json": old, "/mcp/inbox/stray.automobile-proto": old,
            "/mcp/results/fresh.json": fresh, "/mcp/inbox/inflight.automobile-proto": now,
        ]
        files.state.withLock { fake in
            for (path, date) in paths {
                fake.data[path] = Data([1]); fake.modified[path] = date
            }
            fake.data["/mcp/results/unknown.json"] = Data([1])
            fake.directories.formUnion(["/mcp/results/nested", "/mcp/inbox", "/mcp/results"])
        }
        let entry = entry
        let inbox = PrototypeMcpInbox(
            root: root, makeFiles: { files }, importBundle: { _, _ in entry }, entries: { [] },
            now: { now }, warning: { _ in }
        )
        let removed = await inbox.sweepOrphans()
        XCTAssertEqual(removed, 2)
        XCTAssertFalse(files.exists(URL(fileURLWithPath: "/mcp/results/old.json")))
        XCTAssertFalse(files.exists(URL(fileURLWithPath: "/mcp/inbox/stray.automobile-proto")))
        for kept in [
            "results/fresh.json",
            "inbox/inflight.automobile-proto",
            "results/unknown.json",
            "results/nested",
        ] {
            XCTAssertTrue(files.exists(root.appendingPathComponent(kept)), kept)
        }
    }

    @MainActor
    func testSweepBeforeFoldersExistIsANoOpAndHandleSweepsFirst() async throws {
        let files = McpFiles()
        let now = Date(timeIntervalSince1970: 10_000_000)
        let entry = entry
        let inbox = PrototypeMcpInbox(
            root: root, makeFiles: { files }, importBundle: { _, _ in entry }, entries: { [] },
            now: { now }, warning: { _ in }
        )
        let none = await inbox.sweepOrphans()
        XCTAssertEqual(none, 0)
        files.state.withLock {
            $0.directories.formUnion(["/mcp/results"])
            $0.data["/mcp/results/gone.json"] = Data([1])
            $0.modified["/mcp/results/gone.json"] = now.addingTimeInterval(-prototypeMcpOrphanMaxAge * 2)
        }
        _ = await inbox.handle(.unsupported(request: "r", reason: "Unknown action"))
        XCTAssertFalse(files.exists(URL(fileURLWithPath: "/mcp/results/gone.json")))
        XCTAssertEqual(try result(files)["status"], "rejected")
    }

    func testImporterChoosesMcpSourceAndLabelOverride() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let store = try PrototypeLibraryStore(
            root: URL(fileURLWithPath: "/library"), storageRoot: URL(fileURLWithPath: "/storage"), files: files,
            clock: PrototypeLibraryFakeClock(), libraryId: { self.id }
        )
        let spec = Data("""
        {"id":"Original","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}
        """.utf8)
        let imported = try PrototypeLibraryImporter(store: store).importData(spec, source: .mcp, label: "Override")
        XCTAssertEqual(imported.source, .mcp); XCTAssertEqual(imported.label, "Override")
    }
}
