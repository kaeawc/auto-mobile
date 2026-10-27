@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeStringsTests: XCTestCase {
    private struct Resolution: Decodable {
        let name: String
        let strings: JSONValue
        let locales: [String]
        let text: String
        let data: [String: JSONValue]?
        let expected: String
    }

    func testSharedResolutionCases() throws {
        let cases = try JSONDecoder().decode([Resolution].self, from: Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("strings/resolve.json")
        ))
        for entry in cases {
            XCTAssertEqual(PrototypeStrings.resolveText(
                entry.text,
                strings: entry.strings,
                locales: entry.locales,
                data: entry.data
            ), entry.expected, entry.name)
        }
    }

    private struct Plural: Decodable { let n: Double; let category: String }

    func testSharedPluralCategories() throws {
        let languages = try JSONDecoder().decode([String: [Plural]].self, from: Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("strings/plural-categories.json")
        ))
        for (language, entries) in languages {
            for entry in entries {
                XCTAssertEqual(
                    PrototypeStrings.pluralCategory(language, entry.n),
                    entry.category,
                    "\(language): \(entry.n)"
                )
            }
        }
    }

    func testSharedFixtureCapabilitiesAndEmbeddedDecode() throws {
        let data = try Data(
            contentsOf: PrototypeSpecFixtures.directory
                .appendingPathComponent("valid/strings-and-semantics.json")
        )
        let raw = try JSONDecoder().decode(JSONValue.self, from: data)
        let expected: Set<String> = ["prototype_strings_v1", "prototype_semantics_v1", "prototype_data_model_v1"]
        XCTAssertEqual(PrototypeStrictCapabilities.required(raw.objectFields ?? [:]), expected)
        XCTAssertEqual(try Set(PrototypeBundleCapabilities.required(data)), expected)
        XCTAssertTrue(expected.isSubset(of: Set(AutoMobilePrototypeCapabilities.supported)))
        let loaded = try PrototypeEmbeddedSpec.load(data: data)
        XCTAssertEqual(loaded.spec.root.text, "2 items")
        XCTAssertEqual(loaded.spec.root.semantics?.label, "Cart")
        XCTAssertEqual(loaded.spec.root.semantics?.hint, "Your cart")
    }

    func testLiteralCountsAndUnicodeBoundaries() {
        let tables: JSONValue =
            .object(["default": .object(["x": .object(["zero": .string("zero"), "other": .string("{#}")])])])
        XCTAssertEqual(PrototypeStrings.resolveText("{t:x| }", strings: tables, locales: ["ar"]), "{#}")
        XCTAssertEqual(PrototypeStrings.resolveText("{t:x|0x10}", strings: tables, locales: ["en"]), "{#}")
        XCTAssertEqual(
            PrototypeStrings.resolveText("🙂{t:x|2}\u{301} end", strings: tables, locales: ["en"]),
            "🙂2\u{301} end"
        )
    }

    func testCombiningMarksInTranslationAndAdjacentPlaceholders() throws {
        let entry: JSONValue = .object(["other": .string("{#}\u{301}🙂{#}")])
        let text = "🙂{t:x|2}\u{301}{t:x|3}"
        // JS replaces both number tokens, then preserves the mark after the first use.
        let expected = "🙂2\u{301}🙂2\u{301}3\u{301}🙂3"
        for tables: JSONValue in [
            .object(["default": .object(["x": entry])]),
            .object(["default": .object(["x": .string("fallback")]), "en": .object(["x": entry])]),
        ] {
            let actual = PrototypeStrings.resolveText(text, strings: tables, locales: ["en"])
            XCTAssertEqual(Array(actual.utf16), Array(expected.utf16))
            try PrototypeStrings.validateTables(tables)
            let root: [String: JSONValue] = ["type": .string("text"), "text": .string(text)]
            try PrototypeStrings.validate(
                spec: ["strings": tables],
                nodes: [PrototypeLocatedValue(value: root, path: "root")]
            )
        }
    }

    func testForbiddenTranslationTokensWithCombiningMarks() {
        for token in ["{t:", "{data:", "{platform:", "{#}"] {
            let text = "🙂" + token + "\u{301}"
            let tables: JSONValue = .object(["default": .object(["x": .string(text)])])
            XCTAssertThrowsError(try PrototypeStrings.validateTables(tables)) { error in
                XCTAssertEqual(error as? PrototypeLoadError, .invalidSpec(
                    path: "strings.default.x",
                    message: "Forbidden translation placeholder"
                ))
            }
        }
    }

    func testPlaceholderPrefixAndDataPointerScalarBoundaries() throws {
        let tables: JSONValue = .object(["default": .object([
            "x": .object(["other": .string("{#}\u{301}")]),
        ])])
        let text = "{t:x|{data:/\u{301}n}}"
        let actual = PrototypeStrings.resolveText(text, strings: tables, locales: [], data: ["\u{301}n": .number(2)])
        XCTAssertEqual(Array(actual.utf16), Array("2\u{301}".utf16))
        for invalid in ["{t:\u{301}x}", "{t:x|{data:\u{301}/n}}", "{t:x\u{301}}"] {
            let root: [String: JSONValue] = ["type": .string("text"), "text": .string(invalid)]
            XCTAssertThrowsError(try PrototypeStrings.validate(
                spec: ["strings": tables],
                nodes: [PrototypeLocatedValue(value: root, path: "root")]
            ))
            XCTAssertEqual(PrototypeStrings.resolveText(invalid, strings: tables, locales: []), invalid)
        }
    }

    func testLocaleSeparatorsWithCombiningMarks() {
        XCTAssertEqual(PrototypeStrings.localeChain(["en_\u{301}US"]), ["en-\u{301}us", "en", "default"])
        XCTAssertEqual(PrototypeStrings.pluralCategory("fr-\u{301}CA", 0), "one")
        // JS Set keeps canonically equivalent strings with different code units distinct.
        let chain = PrototypeStrings.localeChain(["é", "e\u{301}"])
        XCTAssertEqual(chain.count, 3)
        XCTAssertEqual(Array(chain[0].utf16), [0xE9])
        XCTAssertEqual(Array(chain[1].utf16), [0x65, 0x301])
    }

    func testInvalidSubstitutedCountsLeaveNumberPlaceholderLiteral() {
        let tables: JSONValue = .object(["default": .object([
            "x": .object(["one": .string("one {#}"), "other": .string("other {#}")]),
        ])])
        for count in ["", " ", "0x1", "0o1", "0b1", " 1", "1 ", "1.0", "1e0", "-1", "1000000000", "1\u{301}", "١"] {
            XCTAssertEqual(
                PrototypeStrings.resolveText("{t:x|\(count)}", strings: tables, locales: ["en"]),
                "other {#}",
                count
            )
        }
        XCTAssertEqual(PrototypeStrings.resolveText("{t:x|000000001}", strings: tables, locales: ["en"]), "one 1")
        XCTAssertEqual(
            PrototypeStrings.resolveText("{t:x|999999999}", strings: tables, locales: ["en"]),
            "other 999999999"
        )
    }

    func testLocaleChain() {
        XCTAssertEqual(
            PrototypeStrings.localeChain(["zh-Hant-TW", "ZH-hant", "pt_BR"]),
            ["zh-hant-tw", "zh-hant", "zh", "pt-br", "pt", "default"]
        )
        XCTAssertEqual(PrototypeStrings.localeChain([]), ["default"])
        XCTAssertEqual(PrototypeStrings.pluralCategory("ar", -1), "other")
        XCTAssertEqual(PrototypeStrings.pluralCategory("en", 1.5), "other")
    }

    private struct FakeLocales: PrototypeLocaleProvider {
        let preferredLanguages: [String]
    }

    private func spec() throws -> PrototypeSpec {
        try JSONDecoder().decode(
            PrototypeSpec.self,
            from: Data(
                #"{"id":"locale","window":{"placement":{"type":"fullscreen"}},"data":{"n":1},"strings":{"default":{"x":{"one":"{#} item {name}","other":"{#} items {name}"}},"fr":{"x":"article {name}"}},"state":{"name":"Ada"},"root":{"type":"text","text":"{t:x|{data:/n}}","semantics":{"label":"{t:x|{data:/n}}"}}}"#
                    .utf8
            )
        )
    }

    func testSessionLocaleChangesAndDataRebuilds() throws {
        var session = PrototypeSession()
        session.setDeviceLocales(FakeLocales(preferredLanguages: ["en"]).preferredLanguages)
        try session.show(spec())
        XCTAssertEqual(session.spec?.root.text, "1 item {name}")
        XCTAssertEqual(
            session.spec?.root.accessibilityLabel(state: session.state, pager: nil, tappable: false),
            "1 item Ada"
        )
        let revision = session.structureRevision
        session.setDeviceLocales(["fr-CA"])
        XCTAssertEqual(session.structureRevision, revision + 1)
        XCTAssertEqual(session.spec?.root.text, "article {name}")
        try session.show(spec(), locale: "en")
        session.setDeviceLocales(["fr"])
        XCTAssertEqual(session.spec?.root.text, "1 item {name}")
        let rebuilt = try XCTUnwrap(session.spec).replacingData(["n": .number(2)])
        XCTAssertEqual(rebuilt.root.text, "2 items {name}")
        try session.show(spec())
        XCTAssertEqual(session.spec?.root.text, "article {name}")
    }

    func testTransformLeavesOpaqueObjectsUntouched() throws {
        let value = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(
                #"{"text":"{t:x}","semantics":{"label":"{t:x}","hint":"{t:x}"},"spans":[{"text":"{t:x}"}],"payload":{"text":"{t:x}"},"strings":{"default":{"label":"{t:x}"}},"contentDescription":"{t:x}"}"#
                    .utf8
            )
        )
        let tables: JSONValue = .object(["default": .object(["x": .string("Hello {name}")])])
        let resolved = PrototypeStrings.resolve(value, strings: tables, locales: [], data: nil).objectFields
        XCTAssertEqual(resolved?["text"], .string("Hello {name}"))
        XCTAssertEqual(resolved?["semantics"]?.objectFields?["hint"], .string("Hello {name}"))
        XCTAssertEqual(resolved?["payload"], value.objectFields?["payload"])
        XCTAssertEqual(resolved?["strings"], value.objectFields?["strings"])
        XCTAssertEqual(resolved?["contentDescription"], .string("{t:x}"))
    }

    func testSharedStringAndSemanticsDiagnostics() throws {
        let files = try FileManager.default.contentsOfDirectory(
            at: PrototypeSpecFixtures.directory.appendingPathComponent("invalid"),
            includingPropertiesForKeys: nil
        )
        for file in files
            where file.lastPathComponent.hasPrefix("strings-") || file.lastPathComponent.hasPrefix("semantics-")
        {
            let fixture = try JSONDecoder().decode(PrototypeSpecFixtures.Invalid.self, from: Data(contentsOf: file))
            XCTAssertThrowsError(
                try PrototypeSpecStrictValidator
                    .validate(data: JSONEncoder().encode(fixture.spec))
            ) { error in
                XCTAssertEqual(
                    error as? PrototypeLoadError,
                    .invalidSpec(path: fixture.expectedPath, message: fixture.expectedMessage ?? ""),
                    file.lastPathComponent
                )
            }
        }
    }
}
