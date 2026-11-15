@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

private final class FakeStringListDefaults: PrototypeStringListDefaults {
    var values: [String: [String]] = [:]

    func stringArray(forKey defaultName: String) -> [String]? { values[defaultName] }

    func set(_ value: Any?, forKey defaultName: String) { values[defaultName] = value as? [String] }
}

final class PrototypeContentBlocklistTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        do {
            try PrototypeSpecStrictValidator.validate(data: Data(
                #"{"id":"warm","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}"#
                    .utf8
            ))
        } catch { XCTFail("Fixture warmup failed: \(error)") }
    }

    private let root = URL(fileURLWithPath: "/app/library", isDirectory: true)
    private let storage = URL(fileURLWithPath: "/app/storage", isDirectory: true)
    private let spec =
        Data(#"{"id":"demo","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}"#.utf8)
    private let other =
        Data(#"{"id":"other","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}"#.utf8)

    private func bundle(_ spec: Data) -> PrototypeBundle {
        PrototypeBundle(spec: spec, assets: [:], fonts: [:], requires: [])
    }

    private func store(
        _ files: PrototypeLibraryFakeFileSystem,
        blocklist: (any PrototypeContentBlocklist)?
    )
        throws -> PrototypeLibraryStore
    {
        var sequence = 0
        return try PrototypeLibraryStore(
            root: root, storageRoot: storage, files: files, clock: PrototypeLibraryFakeClock(), libraryId: {
                sequence += 1
                return String(format: "00000000-0000-0000-0000-%012d", sequence)
            }, blocklist: blocklist
        )
    }

    func testDefaultsBlocklistStoresSortedValidHashesAndIgnoresCorruptValues() throws {
        let defaults = FakeStringListDefaults()
        let blocklist = PrototypeDefaultsContentBlocklist(defaults: defaults)
        let first = String(repeating: "b", count: 64)
        let second = String(repeating: "a", count: 64)
        try blocklist.hide(first)
        try blocklist.hide(second)
        try blocklist.hide(first)
        XCTAssertEqual(defaults.values[PrototypeDefaultsContentBlocklist.hiddenKey], [second, first])
        XCTAssertThrowsError(try blocklist.hide(String(repeating: "A", count: 64)))
        XCTAssertThrowsError(try blocklist.hide("abc"))
        defaults.values[PrototypeDefaultsContentBlocklist.hiddenKey] = [first, "not-a-hash"]
        XCTAssertEqual(blocklist.hiddenSpecHashes, [first])
    }

    func testOnlyFileAndShareSourcesAreReceived() {
        let sources: [PrototypeLibraryEntry.Source] = [.mcp, .file, .share, .paste]
        XCTAssertEqual(sources.filter(\.isReceived), [.file, .share])
    }

    func testHideDeletesEveryReceivedCopyAndKeepsOwnPrototypes() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let blocklist = PrototypeDefaultsContentBlocklist(defaults: FakeStringListDefaults())
        let library = try store(files, blocklist: blocklist)
        let filed = try library.add(bundle(spec), label: "Filed", source: .file)
        let shared = try library.add(bundle(spec), label: "Shared", source: .share)
        let own = try library.add(bundle(spec), label: "Own", source: .mcp)
        let unrelated = try library.add(bundle(other), label: "Other", source: .file)
        _ = try library.storageURL(shared.libraryId)

        let deleted = try library.hide(filed)

        XCTAssertEqual(Set(deleted.map(\.libraryId)), [filed.libraryId, shared.libraryId])
        try XCTAssertEqual(Set(library.list().entries.map(\.libraryId)), [own.libraryId, unrelated.libraryId])
        XCTAssertEqual(try library.list().skippedCount, 0)
        XCTAssertFalse(files.exists(storage.appendingPathComponent(shared.libraryId, isDirectory: true)))
        XCTAssertEqual(blocklist.hiddenSpecHashes, [filed.specSha256])
        XCTAssertThrowsError(try library.hide(own))
    }

    func testHiddenSpecIsAbsentFromListAndLoadAndRejectedBeforeStaging() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let blocklist = PrototypeDefaultsContentBlocklist(defaults: FakeStringListDefaults())
        let library = try store(files, blocklist: blocklist)
        let entry = try library.add(bundle(spec), label: "Filed", source: .file)
        // A blocklist written by another store (or a failed purge) still hides the entry everywhere.
        try blocklist.hide(entry.specSha256)
        XCTAssertTrue(try library.list().entries.isEmpty)
        XCTAssertThrowsError(try library.load(entry.libraryId))

        let before = files.data
        XCTAssertThrowsError(try PrototypeLibraryImporter(store: library).importData(spec, source: .share)) {
            XCTAssertEqual($0 as? PrototypeLibraryImportFailure, .hidden)
        }
        XCTAssertEqual(files.data, before)
        XCTAssertEqual(try PrototypeLibraryImporter(store: library).importData(spec, source: .mcp).source, .mcp)
    }

    func testPurgeRetriesFailedDeletesAndReportsThem() throws {
        let files = PrototypeLibraryFakeFileSystem()
        let blocklist = PrototypeDefaultsContentBlocklist(defaults: FakeStringListDefaults())
        let library = try store(files, blocklist: blocklist)
        let entry = try library.add(bundle(spec), label: "Filed", source: .file)
        let directory = root.appendingPathComponent(entry.libraryId, isDirectory: true)
        files.failRemove.insert(directory.path)

        XCTAssertThrowsError(try library.hide(entry))
        XCTAssertTrue(files.exists(directory))
        XCTAssertTrue(try library.list().entries.isEmpty)

        files.failRemove.remove(directory.path)
        XCTAssertEqual(try library.purgeHidden().map(\.libraryId), [entry.libraryId])
        XCTAssertFalse(files.exists(directory))
    }

    func testStoreWithoutBlocklistHidesNothingAndRefusesHide() throws {
        let library = try store(PrototypeLibraryFakeFileSystem(), blocklist: nil)
        let entry = try library.add(bundle(spec), label: "Filed", source: .file)
        XCTAssertEqual(try library.purgeHidden(), [])
        XCTAssertThrowsError(try library.hide(entry))
        XCTAssertEqual(try library.list().entries.map(\.libraryId), [entry.libraryId])
    }

    func testReportDraftAddressesContactAndEscapesEveryReservedCharacter() throws {
        let entry = PrototypeLibraryEntry(
            libraryId: "00000000-0000-0000-0000-000000000001", label: "A&b=c#d\ne+f", importedAt: 0,
            lastOpenedAt: 0, source: .share, specSha256: String(repeating: "c", count: 64), requires: [],
            pinned: false
        )
        let body = PrototypeContentReport.details(entry)
        XCTAssertEqual(
            body,
            "label: A&b=c#d\ne+f\nspecSha256: \(String(repeating: "c", count: 64))\nsource: share"
        )
        let url = try XCTUnwrap(PrototypeContentReport.mailURL(subject: "Report: x", body: "A&b=c#d\ne+f"))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "mailto")
        XCTAssertEqual(components.path, "automobile+coc@jasonpearson.dev")
        XCTAssertEqual(components.queryItems, [
            URLQueryItem(name: "subject", value: "Report: x"),
            URLQueryItem(name: "body", value: "A&b=c#d\ne+f"),
        ])
        // Only the separator `&` stays literal; nothing in a value can add or end a header.
        let query = try XCTUnwrap(components.percentEncodedQuery)
        XCTAssertEqual(query.split(separator: "&").count, 2)
        for reserved in ["+", "#", "\n", "="] {
            XCTAssertEqual(query.components(separatedBy: reserved).count - 1, reserved == "=" ? 2 : 0, reserved)
        }
    }
}
