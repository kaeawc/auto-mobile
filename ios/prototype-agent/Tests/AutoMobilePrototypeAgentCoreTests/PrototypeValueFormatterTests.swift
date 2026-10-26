@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeValueFormatterTests: XCTestCase {
    private struct Golden: Decodable {
        let environment: Environment
        let cases: [Case]
        struct Environment: Decodable { let locale: String; let timeZone: String; let nowMs: Double }
        struct Case: Decodable {
            let name: String
            let format: PrototypeValueFormat
            let of: JSONValue
            let locale: String?
            let timeZone: String?
            let expected: String
            let exact: Bool
            let nonEmpty: Bool?
            let matches: String?
            let engines: [String: String]?
        }
    }

    func testGoldenUSNumbers() throws {
        try golden {
            $0.name.hasPrefix("en-US") && $0.format.date == nil && $0.format.time == nil && $0.format.relative == nil
        }
    }

    func testGoldenUSDatesAndTimes() throws {
        try golden { $0.name.hasPrefix("en-US") && ($0.format.date != nil || $0.format.time != nil) }
    }

    func testGoldenUSRelative() throws { try golden { $0.name.hasPrefix("en-US") && $0.format.relative != nil } }
    func testGoldenGBNumbers() throws {
        try golden {
            $0.name.hasPrefix("en-GB") && $0.format.date == nil && $0.format.time == nil && $0.format.relative == nil
        }
    }

    func testGoldenGBDatesAndTimes() throws {
        try golden { $0.name.hasPrefix("en-GB") && ($0.format.date != nil || $0.format.time != nil) }
    }

    func testGoldenGBRelative() throws { try golden { $0.name.hasPrefix("en-GB") && $0.format.relative != nil } }
    func testGoldenOtherLocalesAndInvalidInputs() throws {
        try golden { !$0.name.hasPrefix("en-US") && !$0.name.hasPrefix("en-GB") }
    }

    private func golden(where include: (Golden.Case) -> Bool) throws {
        let fixture = try JSONDecoder().decode(Golden.self, from: Data(
            contentsOf:
            PrototypeSpecFixtures.directory.appendingPathComponent("derive/formatters.json")
        ))
        for entry in fixture.cases where include(entry) {
            let env = try PrototypeFormatEnvironment(
                locale: Locale(identifier: entry.locale ?? fixture.environment.locale),
                timeZone: XCTUnwrap(TimeZone(identifier: entry.timeZone ?? fixture.environment.timeZone)),
                now: Date(timeIntervalSince1970: fixture.environment.nowMs / 1000)
            )
            let actual = FoundationPrototypeValueFormatter().format(entry.of, format: entry.format, environment: env)
            let expected = entry.engines?["ios"] ?? entry.expected
            func normalized(_ text: String) -> String {
                text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
            }
            if entry.exact || entry.engines?["ios"] != nil {
                XCTAssertEqual(normalized(actual), normalized(expected), entry.name)
            } else if let pattern = entry.matches {
                XCTAssertNotNil(normalized(actual).range(of: pattern, options: .regularExpression), entry.name)
            } else {
                XCTAssertEqual(entry.nonEmpty, true, entry.name)
                XCTAssertFalse(actual.isEmpty, entry.name)
            }
            if normalized(actual) !=
                normalized(entry.expected) { print("IOS FORMAT DIFFERENCE \(entry.name): \(actual)") }
        }
    }

    func testDerivedValidationParity() throws {
        let directory = PrototypeSpecFixtures.directory.appendingPathComponent("invalid")
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            where url.lastPathComponent.hasPrefix("derive-")
        {
            let fixture = try JSONDecoder().decode(PrototypeSpecFixtures.Invalid.self, from: Data(contentsOf: url))
            XCTAssertThrowsError(
                try PrototypeSpecStrictValidator
                    .validate(data: JSONEncoder().encode(fixture.spec))
            ) { error in
                XCTAssertEqual(error as? PrototypeLoadError, .invalidSpec(
                    path: fixture.expectedPath,
                    message: fixture.expectedMessage ?? ""
                ), url.lastPathComponent)
            }
        }
    }
}

private struct FakePrototypeValueFormatter: PrototypeValueFormatter {
    var output: String?
    func format(
        _ input: JSONValue?,
        format _: PrototypeValueFormat,
        environment _: PrototypeFormatEnvironment
    )
        -> String
    {
        output ?? "formatted:\(input?.displayString ?? "missing")"
    }
}

extension PrototypeValueFormatterTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private var environment: PrototypeFormatEnvironment {
        PrototypeFormatEnvironment(
            locale: Locale(identifier: "en-US"),
            timeZone: TimeZone(secondsFromGMT: 0) ?? .gmt,
            now: Date(timeIntervalSince1970: 1_767_268_800)
        )
    }

    func testDerivedInterpolationTracksSessionState() throws {
        let spec = try decode(PrototypeSpec.self, #"""
        {"id":"formats","window":{"placement":{"type":"fullscreen"}},"state":{"ratio":0.25},
         "derive":{"ratioText":{"of":{"state":"ratio"},"format":{"percent":{}},"locale":"en-US"}},
         "root":{"type":"text","text":"{derived:ratioText}"}}
        """#)
        var session = PrototypeSession()
        session.show(spec)
        let context = PrototypeDerivedContext(
            entries: spec.derive ?? [:],
            data: session.data,
            formatter: FoundationPrototypeValueFormatter(),
            environment: environment
        )
        XCTAssertEqual(spec.root.plainText(state: session.state, pager: nil, derived: context), "25%")
        _ = session.setStates([("ratio", .number(0.5))])
        XCTAssertEqual(spec.root.plainText(state: session.state, pager: nil, derived: context), "50%")
    }

    func testDerivedDataUpdatesAfterRebuildAndRichTextBinds() throws {
        let spec = try decode(PrototypeSpec.self, #"""
        {"id":"formats","window":{"placement":{"type":"fullscreen"}},"data":{"price":12},
         "derive":{"priceText":{"of":{"data":"/price"},"format":{"number":{}}}},
         "root":{"type":"text","spans":[{"text":"{derived:priceText}"}]}}
        """#)
        func rendered(_ spec: PrototypeSpec) -> String? {
            PrototypeRichText.runs(
                node: spec.root,
                state: [:],
                pager: nil,
                nodeKey: "price",
                derived:
                PrototypeDerivedContext(
                    entries: spec.derive ?? [:],
                    data: spec.data,
                    formatter: FakePrototypeValueFormatter(),
                    environment: environment
                )
            )?.first?
                .text
        }
        XCTAssertEqual(rendered(spec), "formatted:12")
        XCTAssertEqual(try rendered(spec.replacingData(["price": .number(34)])), "formatted:34")
    }

    func testUnknownMalformedAndInsertedPlaceholdersStayLiteral() throws {
        let entries = try decode(
            [String: PrototypeDerivedEntry].self,
            #"{"x":{"of":{"value":1},"format":{"number":{}}}}"#
        )
        let context = PrototypeDerivedContext(
            entries: entries,
            data: nil,
            formatter: FakePrototypeValueFormatter(output: "{derived:x}{state}"),
            environment: environment
        )
        XCTAssertEqual(
            interpolatePrototypeText(
                "{derived:x} {derived:missing} {derived:bad-name}",
                state: ["state": .string("expanded")],
                pager: nil,
                derived: context
            ),
            "{derived:x}{state} {derived:missing} {derived:bad-name}"
        )
    }

    func testDerivedSubstitutionSharesStateTextBudget() throws {
        let entries = try decode(
            [String: PrototypeDerivedEntry].self,
            #"{"x":{"of":{"value":1},"format":{"number":{}}}}"#
        )
        let context = PrototypeDerivedContext(
            entries: entries,
            data: nil,
            formatter: FakePrototypeValueFormatter(output: String(
                repeating: "x",
                count: PrototypeLimits.maxSubstitutedTextLength
            )),
            environment: environment
        )
        let text = interpolatePrototypeText("{s}{derived:x}", state: ["s": .string("a")], pager: nil, derived: context)
        XCTAssertEqual(text, "a{derived:x}")
        let root = try decode(JSONValue.self, #"{"type":"text","text":"{derived:x}{derived:x}"}"#)
        XCTAssertThrowsError(try PrototypeLimits.guardSubstitutedText(root, data: nil, derived: context))
    }

    func testRepeatDerivedProjectionUsesOriginalRowAndAlias() throws {
        let root = try decode(JSONValue.self, #"""
        {"type":"column","repeat":{"as":"row","items":[{"n":12}],"derive":{
          "shown":{"of":{"item":"n"},"format":{"number":{}}},
          "noChain":{"of":{"item":"shown"},"format":{"number":{}}}}},
          "children":[{"type":"button","label":"{row.shown}/{row.noChain}","onTap":[
            {"type":"emit","name":"row_{row.shown}"}]}]}
        """#)
        let expanded = PrototypeRepeat.expand(root, formatter: FakePrototypeValueFormatter(), environment: environment)
        guard case let .array(children)? = expanded.objectFields?["children"] else { return XCTFail("No rows") }
        XCTAssertEqual(children.first?.objectFields?["label"], .string("formatted:12/formatted:missing"))
        guard case let .array(actions)? = children.first?.objectFields?["onTap"] else { return XCTFail("No actions") }
        XCTAssertEqual(actions.first?.objectFields?["name"], .string("row_formatted:12"))
    }

    func testEnvironmentOverridesAndRelativeSnapshot() throws {
        let entries = try decode([String: PrototypeDerivedEntry].self, #"""
        {"x":{"of":{"value":"2026-01-01T12:01:59.999Z"},"format":{"relative":{}},"locale":"en-US","timeZone":"UTC"}}
        """#)
        let entry = try XCTUnwrap(entries["x"])
        XCTAssertEqual(entry.environment(environment)?.locale.identifier, "en-US")
        XCTAssertEqual(entry.environment(environment)?.timeZone.secondsFromGMT(), 0)
        XCTAssertEqual(PrototypeDerivedValues.resolve(
            entry,
            state: [:],
            data: nil,
            formatter: FoundationPrototypeValueFormatter(),
            environment: environment
        ), "in 1 minute")
    }

    func testMissingSourcesAndInvalidTimezoneDisplayEmpty() throws {
        let entries = try decode([String: PrototypeDerivedEntry].self, #"""
        {"missing":{"of":{"data":"/missing"},"format":{"number":{}}},
         "zone":{"of":{"value":0},"format":{"date":{}},"timeZone":"No_Such/Zone"}}
        """#)
        let context = PrototypeDerivedContext(entries: entries, data: nil, environment: environment)
        XCTAssertEqual(
            interpolatePrototypeText("{derived:missing}{derived:zone}", state: [:], pager: nil, derived: context),
            ""
        )
    }

    func testEmptyDeriveMapsRequireCapabilitiesIncludingBundleComponents() throws {
        let raw = try decode(JSONValue.self, #"""
        {"id":"x","derive":{},"root":{"type":"column","repeat":{"items":[],"as":"item","derive":{}}}}
        """#)
        XCTAssertEqual(PrototypeStrictCapabilities.required(raw.objectFields ?? [:]), ["prototype_format_v1"])
        XCTAssertEqual(try PrototypeBundleCapabilities.required(JSONEncoder().encode(raw)), ["prototype_format_v1"])
        let component = try decode(JSONValue.self, #"""
        {"components":{"unused":{"root":{"type":"column","repeat":{"items":[],"as":"item","derive":{}}}}},
         "root":{"type":"spacer"}}
        """#)
        XCTAssertEqual(
            try PrototypeBundleCapabilities.required(JSONEncoder().encode(component)),
            ["prototype_format_v1"]
        )
    }
}

extension PrototypeValueFormatterTests {
    func testDerivedRepeatIdentitiesAreCheckedAtBuildTime() throws {
        let root = try decode(JSONValue.self, #"""
        {"type":"column","repeat":{"as":"row","items":[{"n":1},{"n":2}],"key":"shown","derive":{
          "shown":{"of":{"item":"n"},"format":{"number":{}}}}},"children":[{"type":"text","text":"{row.shown}"}]}
        """#)
        XCTAssertNoThrow(try PrototypeRepeat.validateDerivedRows(
            root,
            formatter: FakePrototypeValueFormatter(),
            environment: environment
        ))
        XCTAssertThrowsError(try PrototypeRepeat.validateDerivedRows(
            root,
            formatter: FakePrototypeValueFormatter(output: "same"),
            environment: environment
        ))
    }

    func testDerivedRepeatEmitNamesCannotExpandToEmpty() throws {
        let root = try decode(JSONValue.self, #"""
        {"type":"column","repeat":{"as":"row","items":[{}],"derive":{
          "shown":{"of":{"item":"missing"},"format":{"number":{}}}}},
          "children":[{"type":"button","label":"Go","onTap":[{"type":"emit","name":"{row.shown}"}]}]}
        """#)
        XCTAssertThrowsError(try PrototypeRepeat.validateDerivedRows(
            root,
            formatter: FakePrototypeValueFormatter(output: ""),
            environment: environment
        ))
    }
}

extension PrototypeValueFormatterTests {
    func testStrictValidationDefersDeviceDependentRepeatKeys() throws {
        let json = #"""
        {"id":"derivedKeys","window":{"placement":{"type":"fullscreen"}},"state":{"s1":true},
         "root":{"type":"column","repeat":{"as":"item","items":[{"n":1}],"derive":{
          "shown":{"of":{"item":"n"},"format":{"number":{}},"locale":"en-US"}}},
          "children":[{"type":"checkbox","stateKey":"s{item.shown}"}]}}
        """#
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: Data(json.utf8)))
        XCTAssertEqual(try decode(PrototypeSpec.self, json).root.children?.first?.stateKey, "s1")
    }
}
