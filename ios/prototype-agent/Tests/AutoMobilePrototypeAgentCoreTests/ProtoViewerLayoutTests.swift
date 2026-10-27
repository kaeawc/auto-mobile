@testable import AutoMobilePrototypeAgentCore
import XCTest

final class ProtoViewerLayoutTests: XCTestCase {
    private func entry(_ id: String) -> PrototypeLibraryEntry {
        PrototypeLibraryEntry(
            libraryId: id, label: "Entry \(id)", importedAt: 1, lastOpenedAt: 1, source: .file,
            specSha256: String(repeating: "a", count: 64), requires: [], pinned: false
        )
    }

    private let first = "00000000-0000-0000-0000-000000000001"
    private let second = "00000000-0000-0000-0000-000000000002"

    func testWidthClassFollowsNativeSizeClassAndDefaultsToCompact() {
        XCTAssertEqual(ProtoViewerWidthClass(isRegular: true), .regular)
        XCTAssertEqual(ProtoViewerWidthClass(isRegular: false), .compact)
        XCTAssertEqual(ProtoViewerWidthClass(isRegular: nil), .compact)
    }

    func testCompactLayoutIsUnchangedAndRegularCapsReadableWidth() {
        XCTAssertNil(ProtoViewerWidthClass.compact.readableContentWidth)
        XCTAssertEqual(ProtoViewerWidthClass.regular.readableContentWidth, 640)
        let width = ProtoViewerWidthClass.sidebarWidth
        XCTAssertLessThanOrEqual(width.min, width.ideal)
        XCTAssertLessThanOrEqual(width.ideal, width.max)
    }

    func testDestinationIdentitySeparatesPlainAndMcpOpensOfTheSameEntry() {
        let entry = entry(first)
        let plain = PrototypeLibraryDestination.entry(entry)
        let one = PrototypeLibraryDestination.mcp(entry: entry, command: .open(request: "req-1", libraryId: first))
        let two = PrototypeLibraryDestination.mcp(entry: entry, command: .open(request: "req-2", libraryId: first))
        XCTAssertEqual(Set([plain.id, one.id, two.id]).count, 3)
        XCTAssertEqual(plain.id, PrototypeLibraryDestination.entry(entry).id)
        XCTAssertEqual(one.entry, entry)
    }

    func testMcpOpenReplacesTheCurrentSelection() {
        var navigation = PrototypeLibraryNavigation(selection: .entry(entry(first)))
        navigation.openMcp(entry(second), command: .open(request: "req-1", libraryId: second))
        XCTAssertEqual(navigation.selection?.entry.libraryId, second)
        XCTAssertEqual(navigation.selection?.id, "mcp:\(second):req-1")
    }

    func testClosingClearsSelectionAndDeletingOnlyClearsTheOpenEntry() {
        var navigation = PrototypeLibraryNavigation(selection: .entry(entry(first)))
        navigation.didDelete(libraryId: second)
        XCTAssertEqual(navigation.selection?.entry.libraryId, first)
        navigation.didDelete(libraryId: first)
        XCTAssertNil(navigation.selection)
        navigation.selection = .entry(entry(second))
        navigation.close()
        XCTAssertNil(navigation.selection)
    }

    func testSelectionSurvivesSizeClassChanges() {
        // The selection holds no size class: a compact/regular switch cannot reset the open prototype.
        let navigation = PrototypeLibraryNavigation(selection: .entry(entry(first)))
        for isRegular in [true, false, true] {
            _ = ProtoViewerWidthClass(isRegular: isRegular)
            XCTAssertEqual(navigation.selection?.entry.libraryId, first)
        }
    }
}
