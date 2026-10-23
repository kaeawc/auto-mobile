@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeLibraryTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        do {
            try PrototypeSpecStrictValidator.validate(data: Data(
                #"{"id":"warm","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}"#
                    .utf8
            ))
        } catch { XCTFail("Fixture warmup failed: \(error)") }
    }

    private let first = "00000000-0000-0000-0000-000000000001"
    private let second = "00000000-0000-0000-0000-000000000002"
    private let root = URL(fileURLWithPath: "/app/library", isDirectory: true)
    private let storage = URL(fileURLWithPath: "/app/storage", isDirectory: true)
    private let spec =
        Data(#"{"id":"demo","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}"#.utf8)

    private func bundle(_ spec: Data) -> PrototypeBundle {
        PrototypeBundle(spec: spec, assets: [:], fonts: [:], requires: [])
    }

    private func store(
        _ files: PrototypeLibraryFakeFileSystem,
        id: String? = nil,
        clock: PrototypeLibraryFakeClock = PrototypeLibraryFakeClock()
    )
        throws -> PrototypeLibraryStore
    {
        let generated = id ?? first
        return try PrototypeLibraryStore(
            root: root,
            storageRoot: storage,
            files: files,
            clock: clock,
            libraryId: { generated }
        )
    }

    func testEntryCodecRejectsUnknownDuplicateAndMissingFields() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let entry = try store(files).add(bundle(spec), label: "Demo", source: .file)
        let bytes = try entry.encoded()
        XCTAssertEqual(try PrototypeLibraryEntry.decode(bytes), entry)
        var fields = try JSONDecoder().decode([String: JSONValue].self, from: bytes)
        fields["extra"] = .bool(true)
        XCTAssertThrowsError(try PrototypeLibraryEntry.decode(JSONEncoder().encode(fields)))
        XCTAssertThrowsError(try JSONDecoder().decode(PrototypeLibraryEntry.self, from: JSONEncoder().encode(fields)))
        fields.removeValue(forKey: "extra")
        fields.removeValue(forKey: "pinned")
        XCTAssertThrowsError(try PrototypeLibraryEntry.decode(JSONEncoder().encode(fields)))
        let duplicate = Data(("{\"pinned\":true," + String(decoding: bytes.dropFirst(), as: UTF8.self)).utf8)
        XCTAssertThrowsError(try PrototypeLibraryEntry.decode(duplicate))
    }

    func testMetadataRejectsNoncanonicalIdsAndInvalidTypes() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let entry = try store(files).add(bundle(spec), label: "Demo", source: .paste)
        let original = try JSONDecoder().decode([String: JSONValue].self, from: entry.encoded())
        for (key, value) in [
            ("libraryId", JSONValue.string("../escape")),
            ("source", .string("bundle")),
            ("importedAt", .number(-1)),
            ("lastOpenedAt", .bool(true)),
            ("specSha256", .string("bad")),
            ("pinned", .number(1)),
        ] {
            var fields = original
            fields[key] = value
            XCTAssertThrowsError(try PrototypeLibraryEntry.decode(JSONEncoder().encode(fields)), key)
        }
    }

    func testRoundTripUsesUnchangedSavedLayoutAndAppOwnedSource() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let entry = try library.add(bundle(spec), label: "Demo", source: .mcp)
        let loaded = try library.load(first)
        XCTAssertEqual(loaded.spec, spec)
        XCTAssertEqual(loaded.entry, entry)
        XCTAssertEqual(loaded.assets, .none)
        let manifestURL = root.appendingPathComponent(first).appendingPathComponent("manifest.json")
        let manifest = try JSONDecoder().decode([String: JSONValue].self, from: XCTUnwrap(files.data[manifestURL.path]))
        XCTAssertEqual(Set(manifest.keys), ["formatVersion", "specFile", "assets", "fonts"])
        XCTAssertEqual(manifest["formatVersion"], .number(1))
        XCTAssertFalse(files.data.keys.contains { $0.hasSuffix("bundle.json") })
    }

    func testListSkipsCorruptUnreadableAndMismatchedMetadata() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try library.add(bundle(spec), label: "Good", source: .file)
        try store(files, id: second).add(bundle(spec), label: "Bad", source: .share)
        let bad = root.appendingPathComponent(second).appendingPathComponent("library.json")
        files.unreadable.insert(bad.path)
        var listing = try library.list()
        XCTAssertEqual(listing.entries.map(\.libraryId), [first])
        XCTAssertEqual(listing.skippedCount, 1)
        files.unreadable.remove(bad.path)
        files.data[bad.path] = files
            .data[root.appendingPathComponent(first).appendingPathComponent("library.json").path]
        listing = try library.list()
        XCTAssertEqual(listing.skippedCount, 1)
        files.data[bad.path] = Data("broken".utf8)
        XCTAssertEqual(try library.list().skippedCount, 1)
    }

    func testSortAndMarkOpenedUseInjectedClock() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let clock = PrototypeLibraryFakeClock()
        let library = try store(files, clock: clock)
        try library.add(bundle(spec), label: "First", source: .file)
        clock.nowMilliseconds = 2000
        try store(files, id: second, clock: clock).add(bundle(spec), label: "Second", source: .file)
        XCTAssertEqual(try library.list().entries.map(\.libraryId), [second, first])
        try library.markOpened(first, now: 2000)
        XCTAssertEqual(try library.list().entries.map(\.libraryId), [second, first])
        clock.nowMilliseconds = 3000
        try library.markOpened(first)
        XCTAssertEqual(try library.list().entries.map(\.libraryId), [first, second])
    }

    func testRejectsTraversalBeforeFileSystemAccessForEveryOperation() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        for id in [
            "../escape",
            "/absolute",
            "",
            first.uppercased().replacingOccurrences(of: "000001", with: "AAAAAA"),
            first + "/child",
        ] {
            let calls = files.calls
            XCTAssertThrowsError(try library.load(id))
            XCTAssertThrowsError(try library.markOpened(id))
            XCTAssertThrowsError(try library.storageURL(id))
            XCTAssertThrowsError(try library.resetStorage(id))
            XCTAssertThrowsError(try store(files, id: id).add(bundle(spec), label: "Bad", source: .file))
            XCTAssertEqual(files.calls, calls)
        }
    }

    func testStorageIsolationResetAndBackupExclusion() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try library.add(bundle(spec), label: "One", source: .file)
        try store(files, id: second).add(bundle(spec), label: "Two", source: .file)
        let one = try library.storageURL(first)
        let two = try library.storageURL(second)
        XCTAssertFalse(one.path.hasPrefix(root.path + "/"))
        XCTAssertTrue(files.excluded.isSuperset(of: [root.path, storage.path, one.path, two.path]))
        files.data[one.appendingPathComponent("value.json").path] = Data("one".utf8)
        files.data[two.appendingPathComponent("value.json").path] = Data("two".utf8)
        try library.resetStorage(first)
        try library.resetStorage(first)
        XCTAssertFalse(files.exists(one))
        XCTAssertTrue(files.exists(two))
        XCTAssertEqual(try library.load(first).spec, spec)
        XCTAssertEqual(try library.list().entries.count, 2)
    }

    func testStorageCannotNestInLibrary() {
        XCTAssertThrowsError(try PrototypeLibraryStore(
            root: root,
            storageRoot: root.appendingPathComponent("storage"),
            files: PrototypeLibraryFakeFileSystem()
        ))
    }

    func testLoadRevalidatesSpecAndReportsPath() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let entry = try library.add(bundle(spec), label: "One", source: .file)
        let invalid =
            Data(
                #"{"id":"demo","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello","surprise":true}}"#
                    .utf8
            )
        files.data[root.appendingPathComponent(first).appendingPathComponent("spec.json").path] = invalid
        let modified = PrototypeLibraryEntry(
            libraryId: first,
            label: entry.label,
            importedAt: 0,
            lastOpenedAt: 0,
            source: .file,
            specSha256: PrototypeBundle.sha256(invalid),
            requires: [],
            pinned: false
        )
        files.data[root.appendingPathComponent(first).appendingPathComponent("library.json").path] = try modified
            .encoded()
        XCTAssertThrowsError(try library.load(first)) { error in
            let failure = error as? PrototypeLibraryFailure
            XCTAssertTrue(failure?.path.contains("surprise") == true)
            XCTAssertFalse(failure?.message.isEmpty ?? true)
        }
    }

    func testHashMismatchAndCorruptManifestFailWithoutPartialRender() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try library.add(bundle(spec), label: "One", source: .file)
        files.data[root.appendingPathComponent(first).appendingPathComponent("spec.json").path] = spec + Data(" ".utf8)
        XCTAssertThrowsError(try library.load(first)) { XCTAssertEqual(
            ($0 as? PrototypeLibraryFailure)?.path,
            "spec.json"
        ) }
        files.data[root.appendingPathComponent(first).appendingPathComponent("manifest.json").path] = Data("{}".utf8)
        XCTAssertThrowsError(try library.load(first))
    }

    func testCapsApplyAtCommitAndLoad() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try library.add(bundle(spec), label: "One", source: .file)
        files.sizes[root.appendingPathComponent(first).path] = PrototypeLibraryStore.maxBytes + 1
        XCTAssertEqual(try library.list().skippedCount, 1)
        XCTAssertThrowsError(try library.load(first))
        files.sizes[root.path] = PrototypeLibraryStore.maxBytes
        XCTAssertThrowsError(try store(files, id: second).add(bundle(spec), label: "Two", source: .file))
    }

    func testCountCapOnLoadAndCommit() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let template = try library.add(bundle(spec), label: "One", source: .file)
        for index in 2 ... 201 {
            let id = String(format: "00000000-0000-0000-0000-%012d", index)
            let directory = root.appendingPathComponent(id)
            try files.createDirectory(directory)
            let entry = PrototypeLibraryEntry(
                libraryId: id,
                label: "Extra",
                importedAt: 0,
                lastOpenedAt: 0,
                source: .file,
                specSha256: template.specSha256,
                requires: [],
                pinned: false
            )
            files.data[directory.appendingPathComponent("library.json").path] = try entry.encoded()
        }
        let listing = try library.list()
        XCTAssertEqual(listing.entries.count, 200)
        XCTAssertEqual(listing.skippedCount, 1)
        XCTAssertThrowsError(try library.add(bundle(spec), label: "Full", source: .file))
    }

    func testFailedCommitCleansStageAndNeverPublishesEntry() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        files.failWrite = true
        XCTAssertThrowsError(try library.add(bundle(spec), label: "One", source: .file))
        XCTAssertEqual(try files.children(root), [])
    }

    func testAssetsLoadBySpecIdsAndMissingBytesRejectWholeLoad() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let imageSpec =
            Data(
                #"{"id":"image","window":{"placement":{"type":"fullscreen"}},"root":{"type":"image","asset":"hero"}}"#
                    .utf8
            )
        let png = Data([137, 80, 78, 71, 13, 10, 26, 10])
        let imageBundle = PrototypeBundle(
            spec: imageSpec,
            assets: [PrototypeBundleID("hero"): .init(mediaType: "image/png", bytes: png)],
            fonts: [:],
            requires: []
        )
        try library.add(imageBundle, label: "Image", source: .file)
        XCTAssertEqual(try library.load(first).assets.images, ["hero": png])
        let imagePath = try XCTUnwrap(files.data.keys.first { $0.hasSuffix(".png") })
        files.data.removeValue(forKey: imagePath)
        XCTAssertThrowsError(try library.load(first)) { XCTAssertEqual(($0 as? PrototypeLibraryFailure)?.path, "hero") }
    }

    func testMissingManifestReferenceRejectsLoad() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let imageSpec =
            Data(
                #"{"id":"image","window":{"placement":{"type":"fullscreen"}},"root":{"type":"image","asset":"hero"}}"#
                    .utf8
            )
        let png = Data([137, 80, 78, 71, 13, 10, 26, 10])
        try library.add(
            PrototypeBundle(
                spec: imageSpec,
                assets: [PrototypeBundleID("hero"): .init(mediaType: "image/png", bytes: png)],
                fonts: [:],
                requires: []
            ),
            label: "Image",
            source: .file
        )
        files
            .data[root.appendingPathComponent(first).appendingPathComponent("manifest.json").path] =
            Data(#"{"formatVersion":1,"specFile":"spec.json","assets":[],"fonts":[]}"#.utf8)
        XCTAssertThrowsError(try library.load(first)) { XCTAssertEqual(($0 as? PrototypeLibraryFailure)?.path, "hero") }
    }

    func testLibraryRejectsHostRoutePrivilegedWindowsAndUnsupportedCapabilities() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        let host =
            Data(
                #"{"id":"request","window":{"placement":{"type":"fullscreen"}},"data":{},"root":{"type":"button","label":"Go","onTap":[{"type":"request","url":"https://example.test/feed","into":"/data/result","via":"host"}]}}"#
                    .utf8
            )
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: host, library: true)) {
            guard case let PrototypeLoadError.invalidSpec(path, _) = $0 else {
                return XCTFail("Unexpected strict error: \($0)")
            }
            XCTAssertEqual(path, "root.onTap[0].via")
        }
        XCTAssertThrowsError(try library.add(bundle(host), label: "Host", source: .file)) { error in
            XCTAssertEqual((error as? PrototypeLibraryFailure)?.path, "root.onTap[0].via")
        }
        let privileged =
            Data(
                #"{"id":"system","window":{"placement":{"type":"fullscreen"},"layer":"system"},"root":{"type":"text","text":"Hello"}}"#
                    .utf8
            )
        XCTAssertThrowsError(try library.add(bundle(privileged), label: "System", source: .file)) { error in
            XCTAssertEqual((error as? PrototypeLibraryFailure)?.path, "window.layer")
        }
        var fields = try JSONDecoder().decode([String: JSONValue].self, from: spec)
        fields["requires"] = .array([.string("prototype_future_v1")])
        XCTAssertThrowsError(try library.add(bundle(JSONEncoder().encode(fields)), label: "Future", source: .file))
        XCTAssertEqual(try library.list().entries.count, 0)
    }

    func testAggregateByteCapAndDirectoryIdentityAreEnforced() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let library = try store(files)
        try library.add(bundle(spec), label: "One", source: .file)
        try store(files, id: second).add(bundle(spec), label: "Two", source: .file)
        files.sizes[root.appendingPathComponent(first).path] = 60 * 1024 * 1024
        files.sizes[root.appendingPathComponent(second).path] = 60 * 1024 * 1024
        XCTAssertEqual(try library.list().entries.count, 1)
        XCTAssertEqual(try library.list().skippedCount, 1)
        XCTAssertThrowsError(try library.load(second))
        XCTAssertThrowsError(try PrototypeLibraryStore(
            root: root,
            storageRoot: root.deletingLastPathComponent(),
            files: files
        ))
    }

    func testSwitchReleasesFontRegistrationsAndTheirRecordedDigests() {
        let ledger = PrototypeFontFaceLedger<String, Int>()
        var released: [String] = []
        XCTAssertTrue(ledger.register(
            face: "Face",
            digest: 1,
            font: "font",
            register: { _ in .registered },
            unregister: { released.append($0) }
        ))
        ledger.unregisterAll { released.append($0) }
        ledger.unregisterAll { released.append($0) }
        XCTAssertEqual(released, ["font"])
        XCTAssertFalse(ledger.register(
            face: "Face",
            digest: 1,
            font: "font",
            register: { _ in .alreadyRegistered },
            unregister: { released.append($0) }
        ))
        XCTAssertTrue(ledger.register(
            face: "Face",
            digest: 2,
            font: "replacement",
            register: { _ in .registered },
            unregister: { released.append($0) }
        ))
    }

    func testProtoViewerSourceNeverUsesDefaultTransport() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("ProtoViewer")
        for path in try FileManager.default.contentsOfDirectory(at: app, includingPropertiesForKeys: nil)
            where path.pathExtension == "swift"
        {
            let source = try String(contentsOf: path, encoding: .utf8)
            for forbidden in ["URLSession", "PrototypeURLSessionClient"] {
                XCTAssertFalse(source.contains(forbidden), path.lastPathComponent)
            }
            for pattern in [
                #"PrototypeNetworkConfiguration\s*\.\s*default\b"#,
                #"(?<![A-Za-z0-9_])\.\s*default\b"#,
            ] {
                XCTAssertNil(source.range(of: pattern, options: .regularExpression), path.lastPathComponent)
            }
        }
    }
}
