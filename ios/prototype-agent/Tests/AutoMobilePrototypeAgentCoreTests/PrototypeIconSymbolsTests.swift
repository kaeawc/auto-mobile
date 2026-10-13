@testable import AutoMobilePrototypeAgentCore
#if canImport(AppKit)
    import AppKit
#endif
import Foundation
import XCTest

final class PrototypeIconSymbolsTests: XCTestCase {
    private struct Entry: Decodable {
        let symbol: String
        let filled: String?
        let outlined: String?
    }

    private struct Table: Decodable {
        let minimumIOS: String
        let placeholder: String
        let mapped: [String: Entry]
        let unmapped: [String]
    }

    private struct Contract: Decodable {
        struct Enumeration: Decodable { let values: [String] }
        struct Definitions: Decodable {
            let iconName: Enumeration
            let iconVariant: Enumeration
        }

        let definitions: Definitions
    }

    private struct Availability: Decodable {
        struct Release: Decodable { let iOS: String? }
        let symbols: [String: String]
        let yearToRelease: [String: Release]
        private enum CodingKeys: String, CodingKey {
            case symbols
            case yearToRelease = "year_to_release"
        }
    }

    private var root: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private func table() throws -> Table {
        try JSONDecoder().decode(
            Table.self,
            from: Data(contentsOf: root.appendingPathComponent("schemas/prototype-ios-icon-symbols.json"))
        )
    }

    private func contract() throws -> Contract {
        try JSONDecoder().decode(
            Contract.self,
            from: Data(contentsOf: root.appendingPathComponent("schemas/prototype-spec-contract.json"))
        )
    }

    func testCompiledTableMatchesEveryCanonicalFormAndOrder() throws {
        let table = try table()
        let names = try contract().definitions.iconName.values
        let shared = PrototypeIconSymbolTable.shared
        XCTAssertEqual(shared.mappedNames, names.filter { table.mapped[$0] != nil })
        XCTAssertEqual(shared.unmappedNames, table.unmapped)
        XCTAssertEqual(prototypeIconSymbolPlaceholder, table.placeholder)
        let rows = names.map { name in
            guard let entry = table.mapped[name] else { return name }
            return [name, entry.symbol, entry.filled ?? "", entry.outlined ?? ""].joined(separator: "\t")
        }
        XCTAssertEqual(prototypeIconSymbolData, rows.joined(separator: "\n"))
        for (name, entry) in table.mapped {
            let filled = entry.filled ?? entry.symbol
            let outlined = entry.outlined ?? entry.symbol
            XCTAssertEqual(shared.resolve(name), .symbol(entry.symbol, fallback: nil), name)
            XCTAssertEqual(
                shared.resolve(name, variant: "filled"),
                .symbol(filled, fallback: filled == entry.symbol ? nil : entry.symbol), name
            )
            XCTAssertEqual(
                shared.resolve(name, variant: "outlined"),
                .symbol(outlined, fallback: outlined == entry.symbol ? nil : entry.symbol), name
            )
        }
        for name in table.unmapped {
            XCTAssertEqual(shared.resolve(name), .placeholder, name)
        }
    }

    func testCanonicalNamesPartitionTheContractAndVariantsMatch() throws {
        let table = try table()
        let contract = try contract()
        let names = contract.definitions.iconName.values
        let mapped = Set(table.mapped.keys)
        let unmapped = Set(table.unmapped)
        let actual = mapped.union(unmapped)
        let expected = Set(names)
        XCTAssertEqual(
            actual,
            expected,
            "Missing: \(expected.subtracting(actual).sorted()); extra: \(actual.subtracting(expected).sorted())"
        )
        XCTAssertTrue(mapped.isDisjoint(with: unmapped), "Overlap: \(mapped.intersection(unmapped).sorted())")
        XCTAssertEqual(table.unmapped, names.filter { unmapped.contains($0) })
        XCTAssertEqual(table.unmapped.count, unmapped.count, "Duplicate unmapped names")
        XCTAssertEqual(PrototypeIconVariant.allCases.map(\.rawValue), contract.definitions.iconVariant.values)
    }

    @MainActor
    func testEverySymbolIsAvailableUnrestrictedAndDrawable() throws {
        let table = try table()
        let resources = URL(fileURLWithPath: "/System/Library/CoreServices/CoreGlyphs.bundle/Contents/Resources")
        for file in ["name_availability.plist", "symbol_restrictions.strings"] {
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: resources.appendingPathComponent(file).path),
                "Required CoreGlyphs metadata missing: \(file)"
            )
        }
        let availability = try PropertyListDecoder().decode(
            Availability.self,
            from: Data(contentsOf: resources.appendingPathComponent("name_availability.plist"))
        )
        let restrictions = try PropertyListDecoder().decode(
            [String: String].self,
            from: Data(contentsOf: resources.appendingPathComponent("symbol_restrictions.strings"))
        )
        var symbols: Set<String> = [table.placeholder]
        for entry in table.mapped.values {
            symbols.insert(entry.symbol)
            if let filled = entry.filled { symbols.insert(filled) }
            if let outlined = entry.outlined { symbols.insert(outlined) }
        }
        for symbol in symbols.sorted() {
            let year = try XCTUnwrap(availability.symbols[symbol], "Missing CoreGlyphs symbol: \(symbol)")
            let version = try XCTUnwrap(availability.yearToRelease[year]?.iOS, "Missing iOS release for \(symbol)")
            XCTAssertNotEqual(
                version.compare(table.minimumIOS, options: .numeric),
                .orderedDescending,
                "\(symbol) requires iOS \(version), minimum is \(table.minimumIOS)"
            )
            XCTAssertNil(restrictions[symbol], "Apple-product-only symbol: \(symbol)")
            #if canImport(AppKit)
                XCTAssertNotNil(
                    NSImage(systemSymbolName: symbol, accessibilityDescription: nil),
                    "Host cannot draw \(symbol)"
                )
            #endif
        }
    }

    func testLegacyDefaultsAreUnchanged() {
        let legacy: [String: String] = [
            "home": "house",
            "search": "magnifyingglass",
            "settings": "gearshape",
            "person": "person",
            "favorite": "heart",
            "add": "plus",
            "close": "xmark",
            "check": "checkmark",
            "arrow_back": "arrow.left",
            "arrow_forward": "arrow.right",
            "chevron_left": "chevron.left",
            "chevron_right": "chevron.right",
            "menu": "line.3.horizontal",
            "more_vert": "ellipsis",
            "share": "square.and.arrow.up",
            "edit": "pencil",
            "delete": "trash",
            "info": "info.circle",
            "warning": "exclamationmark.triangle",
            "notifications": "bell",
            "star": "star",
            "shopping_cart": "cart",
            "help": "questionmark.circle",
            "refresh": "arrow.clockwise",
            "done": "checkmark.circle",
            "cancel": "xmark.circle",
            "play_arrow": "play.fill",
            "pause": "pause.fill",
            "stop": "stop.fill",
            "mail": "envelope",
            "phone": "phone",
            "location_on": "mappin.and.ellipse",
            "calendar_today": "calendar",
            "visibility": "eye",
            "lock": "lock",
            "logout": "rectangle.portrait.and.arrow.right",
            "alarm": "alarm",
            "schedule": "clock",
            "event": "calendar",
            "today": "calendar",
            "remove": "minus",
            "expand_more": "chevron.down",
            "expand_less": "chevron.up",
            "more_horiz": "ellipsis",
            "account_circle": "person.crop.circle",
            "send": "paperplane",
            "bookmark": "bookmark",
            "thumb_up": "hand.thumbsup",
            "photo_camera": "camera",
            "image": "photo",
            "music_note": "music.note",
            "wifi": "wifi",
            "sort": "arrow.up.arrow.down",
            "filter_list": "line.3.horizontal.decrease",
            "content_copy": "doc.on.doc",
        ]
        XCTAssertEqual(legacy.count, 55)
        for (name, symbol) in legacy {
            XCTAssertEqual(
                PrototypeIconSymbolTable.shared.resolve(name),
                .symbol(symbol, fallback: nil),
                name
            )
        }
    }

    func testResolutionSemanticsWithoutUIKit() {
        let table = PrototypeIconSymbolTable(data: "paired\theart\theart.fill\theart\nsolid\tplus\t\t\nunmapped")
        XCTAssertEqual(table.mappedNames, ["paired", "solid"])
        XCTAssertEqual(table.unmappedNames, ["unmapped"])
        XCTAssertEqual(table.resolve(nil), .unknown)
        XCTAssertEqual(table.resolve("skew"), .unknown)
        XCTAssertEqual(table.resolve(""), .unknown)
        XCTAssertEqual(table.resolve("unmapped", variant: "filled"), .placeholder)
        XCTAssertEqual(table.resolve("paired"), .symbol("heart", fallback: nil))
        XCTAssertEqual(table.resolve("paired", variant: "filled"), .symbol("heart.fill", fallback: "heart"))
        XCTAssertEqual(table.resolve("paired", variant: "outlined"), .symbol("heart", fallback: nil))
        for variant in ["filled", "outlined", "rounded", "sharp", "twoTone", "unheard-of"] {
            XCTAssertEqual(table.resolve("solid", variant: variant), .symbol("plus", fallback: nil))
        }
        for variant in ["rounded", "sharp", "twoTone", "unheard-of"] {
            XCTAssertEqual(table.resolve("paired", variant: variant), .symbol("heart", fallback: nil))
        }
    }

    func testDistinctOutlinedFormFallsBackToDefaultAndMatchingFormDoesNot() {
        let table = PrototypeIconSymbolTable(data: "solid\theart.fill\theart.fill\theart")
        XCTAssertEqual(table.resolve("solid", variant: "outlined"), .symbol("heart", fallback: "heart.fill"))
        XCTAssertEqual(table.resolve("solid", variant: "filled"), .symbol("heart.fill", fallback: nil))
        XCTAssertEqual(table.resolve("solid"), .symbol("heart.fill", fallback: nil))
    }

    func testMalformedRowsAreIgnoredWithoutBecomingUnmapped() {
        let table = PrototypeIconSymbolTable(data: """
        empty\t\t\t
        two\theart
        three\theart\theart.fill
        extra\theart\theart.fill\theart\textra
        \theart\t\t
        valid\theart\t\t
        unmapped
        """)
        XCTAssertEqual(table.mappedNames, ["valid"])
        XCTAssertEqual(table.unmappedNames, ["unmapped"])
        for name in ["empty", "two", "three", "extra", ""] {
            XCTAssertEqual(table.resolve(name), .unknown, name)
        }
        XCTAssertEqual(table.resolve("valid"), .symbol("heart", fallback: nil))
        XCTAssertEqual(table.resolve("unmapped"), .placeholder)
    }

    func testRendererSourcesHaveNoSeparateTableOrMaterialCapability() throws {
        let sources = root.appendingPathComponent("ios/prototype-agent/Sources/AutoMobilePrototypeAgent")
        let files = try XCTUnwrap(
            FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil),
            "Missing renderer sources"
        )
        for case let file as URL in files where file.pathExtension == "swift" {
            let source = try String(contentsOf: file, encoding: .utf8)
            XCTAssertFalse(source.contains("sfSymbols"), file.path)
            XCTAssertFalse(source.contains("prototype_icon_set_material_v1"), file.path)
            XCTAssertFalse(source.contains("prototype_icon_variant_v1"), file.path)
        }
    }
}
