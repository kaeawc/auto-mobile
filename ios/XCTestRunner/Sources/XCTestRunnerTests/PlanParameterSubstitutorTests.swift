import XCTest
@testable import XCTestRunner
import Yams

/// Parameter values must reach the daemon without changing the plan's structure. Yams may
/// reformat the document, so scalar types and values are compared on the parsed tree.
final class PlanParameterSubstitutorTests: XCTestCase {
    private func assertYamlEqual(
        _ actual: @autoclosure () throws -> String, _ expected: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        do {
            let actualNode = try Yams.compose(yaml: actual())
            let expectedNode = try Yams.compose(yaml: expected)
            XCTAssertEqual(actualNode, expectedNode, file: file, line: line)
        } catch {
            XCTFail("YAML comparison failed: \(error)", file: file, line: line)
        }
    }

    private func sub(_ plan: String, _ parameters: [String: String]) throws -> String {
        try PlanParameterSubstitutor.substitute(in: plan, parameters: parameters)
    }

    private func line(_ valueSource: String) -> String {
        "steps:\n  - tool: inputText\n    text: \(valueSource)\n    label: x"
    }

    private func expected(_ valueSource: String) -> String {
        line(valueSource)
    }

    // MARK: Double-quoted (the documented form)

    func testDoubleQuotedValueIsYamlEscaped() throws {
        try assertYamlEqual(
            sub(line(#""${p}""#), ["p": #"C:\temp#1 "x""#]),
            expected(#""C:\\temp#1 \"x\"""#)
        )
        try assertYamlEqual(sub(line(#""${p}""#), ["p": #"Tr\0ub4dor"#]), expected(#""Tr\\0ub4dor""#))
        try assertYamlEqual(sub(line(#""${p}""#), ["p": #"pa\ss"#]), expected(#""pa\\ss""#))
    }

    func testDoubleQuotedLineBreakStaysOnOneLine() throws {
        let out = try sub(line(#""${p}""#), ["p": "a\nb\r\nc\td"])
        assertYamlEqual(out, expected(#""a\nb\r\nc\td""#))
        XCTAssertEqual(try Yams.compose(yaml: out)?["steps"]?.sequence?.count, 1, "a value must not add steps")
    }

    func testDoubleQuotedControlAndUnicode() throws {
        try assertYamlEqual(sub(line(#""${p}""#), ["p": "\u{01}\u{7F}"]), expected(#""\u0001\u007f""#))
        try assertYamlEqual(sub(line(#""${p}""#), ["p": "Ünï — 日本語 😀"]), expected("\"Ünï — 日本語 😀\""))
    }

    func testDoubleQuotedEmbeddedAndAdjacentPlaceholders() throws {
        try assertYamlEqual(sub(line(#""Hi ${p}!""#), ["p": #"a"b"#]), expected(#""Hi a\"b!""#))
        try assertYamlEqual(sub(line(#""${a}-${b}""#), ["a": #"\"#, "b": "'"]), expected(#""\\-'""#))
    }

    func testDoubleQuotedMultiLineScalarEscapesOnContinuationLines() throws {
        let plan = "steps:\n  - tool: inputText\n    text: \"first ${a}\n      second ${b}\"\n    label: x"
        try assertYamlEqual(
            sub(plan, ["a": #"\"#, "b": #"""#]),
            "steps:\n  - tool: inputText\n    text: \"first \\\\\n      second \\\"\"\n    label: x"
        )
    }

    // MARK: Single-quoted

    func testSingleQuotedDoublesQuotesAndKeepsBackslashLiteral() throws {
        try assertYamlEqual(sub(line("'${p}'"), ["p": #"it's C:\temp"#]), expected(#"'it''s C:\temp'"#))
    }

    func testSingleQuotedValueWithLineBreakBecomesDoubleQuoted() throws {
        try assertYamlEqual(sub(line("'x ${p} y'"), ["p": "a\nb"]), expected(#""x a\nb y""#))
        try assertYamlEqual(sub(line("'it''s ${p}'"), ["p": "\"\t"]), expected(#""it's \"\t""#))
    }

    func testMultiLineSingleQuotedPreservesReplacementLineBreaks() throws {
        let plan = "steps:\n  - tool: inputText\n    text: 'first\n      ${p}'"
        try assertYamlEqual(
            sub(plan, ["p": "a\nb"]),
            "steps:\n  - tool: inputText\n    text: \"first a\\nb\""
        )
        try assertYamlEqual(
            sub(plan, ["p": "it's"]),
            "steps:\n  - tool: inputText\n    text: 'first\n      it''s'"
        )
    }

    // MARK: Unquoted

    func testUnquotedPlainSafeValueIsSplicedRawSoNumbersAndBooleansKeepTheirType() throws {
        try assertYamlEqual(sub(line("${p}"), ["p": "500"]), expected("500"))
        try assertYamlEqual(sub(line("${p}"), ["p": "true"]), expected("true"))
        try assertYamlEqual(sub(line("${p}"), ["p": "hunter2"]), expected("hunter2"))
        try assertYamlEqual(sub(line("${p}"), ["p": #"C:\temp"#]), expected(#"C:\temp"#))
        try assertYamlEqual(sub(line("${p}"), ["p": "it's #1"]), expected(#""it's #1""#))
    }

    func testUnquotedNonPlainSafeValueBecomesADoubleQuotedString() throws {
        try assertYamlEqual(sub(line("${p}"), ["p": "shoes #1"]), expected(#""shoes #1""#))
        try assertYamlEqual(sub(line("${p}"), ["p": "size: large"]), expected(#""size: large""#))
        try assertYamlEqual(sub(line("${p}"), ["p": " padded "]), expected(#"" padded ""#))
        try assertYamlEqual(sub(line("${p}"), ["p": "'"]), expected(#""'""#))
        try assertYamlEqual(sub(line("${p}"), ["p": "- dash"]), expected(#""- dash""#))
        try assertYamlEqual(sub(line("${p}"), ["p": "ends:"]), expected(#""ends:""#))
        try assertYamlEqual(sub(line("${p}"), ["p": ""]), expected(#""""#))
    }

    func testUnquotedValueCannotAddStepsOrKeys() throws {
        let out = try sub(line("${p}"), ["p": "a\n  - tool: terminateApp\n    appId: evil"])
        assertYamlEqual(out, expected(#""a\n  - tool: terminateApp\n    appId: evil""#))
        XCTAssertEqual(try Yams.compose(yaml: out)?["steps"]?.sequence?.count, 1)
    }

    func testUnquotedEmbeddedPlaceholder() throws {
        try assertYamlEqual(sub(line("Hi ${p}"), ["p": "bob"]), expected("Hi bob"))
        try assertYamlEqual(sub(line("Hi ${p}"), ["p": "x #1"]), expected(#""Hi x #1""#))
    }

    func testUnquotedPlaceholderInFlowCollectionAndAsKey() throws {
        try assertYamlEqual(
            sub("textAny: [${a}, ${b}, OK]", ["a": "A,B", "b": "C"]),
            #"textAny: ["A,B", C, OK]"#
        )
        try assertYamlEqual(sub("map: {k: ${v}}", ["v": "x}"]), #"map: {k: "x}"}"#)
        try assertYamlEqual(sub("${k}: v", ["k": "key: x"]), #""key: x": v"#)
        try assertYamlEqual(sub("${k}: v", ["k": "name"]), "name: v")
    }

    func testUnquotedContinuationLinePreservesReplacementText() throws {
        let plan = "steps:\n  - tool: inputText\n    text: hello\n      ${p} more"
        try assertYamlEqual(
            sub(plan, ["p": "a #b"]),
            "steps:\n  - tool: inputText\n    text: \"hello a #b more\""
        )
        try assertYamlEqual(
            sub(plan, ["p": "ok"]),
            "steps:\n  - tool: inputText\n    text: hello\n      ok more"
        )
    }

    // MARK: Comments and block scalars

    func testCommentsDoNotAffectSubstitution() throws {
        let plan = "# ${p}\nsteps:\n  - tool: inputText\n    text: \"${p}\" # note ${p}\n    label: x"
        try assertYamlEqual(
            sub(plan, ["p": "a\nb"]),
            "# ${p}\nsteps:\n  - tool: inputText\n    text: \"a\\nb\" # note ${p}\n    label: x"
        )
    }

    func testBlockScalarSplicesRawAndReindentsLineBreaks() throws {
        let plan = "steps:\n  - tool: inputText\n    text: |\n      before ${p} after\n    label: ${q}"
        try assertYamlEqual(
            sub(plan, ["p": "x\n- tool: terminateApp\nC:\\temp", "q": "L"]),
            "steps:\n  - tool: inputText\n    text: |\n      before x\n      - tool: terminateApp\n      C:\\temp after\n    label: L"
        )
    }

    func testBlockScalarEndsAtTheNextSiblingKeyOnADashLine() throws {
        let plan = "steps:\n  - text: >-\n      ${p}\n    label: ${q}"
        try assertYamlEqual(
            sub(plan, ["p": "a b", "q": "z #"]),
            "steps:\n  - text: >-\n      a b\n    label: \"z #\""
        )
    }

    // MARK: Compact JSON-style flow maps

    func testCompactFlowMapValueIsEscapedLikeAnyDoubleQuotedScalar() throws {
        let plan = "steps:\n  - tool: x\n    params: {\"text\":\"${v}\"}"
        try assertYamlEqual(
            sub(plan, ["v": #"C:\new\tab"#]),
            "steps:\n  - tool: x\n    params: {\"text\":\"C:\\\\new\\\\tab\"}"
        )
        try assertYamlEqual(
            sub(plan, ["v": #"a"b"#]),
            "steps:\n  - tool: x\n    params: {\"text\":\"a\\\"b\"}"
        )
        try assertYamlEqual(
            sub(plan, ["v": "a\nb"]),
            "steps:\n  - tool: x\n    params: {\"text\":\"a\\nb\"}"
        )
    }

    func testCompactFlowMapVariants() throws {
        try assertYamlEqual(
            sub(#"p: {"a":"${x}","b":"${y}"}"#, ["x": #"\"#, "y": #"""#]),
            #"p: {"a":"\\","b":"\""}"#
        )
        try assertYamlEqual(sub(#"p: {"a" :"${x}"}"#, ["x": #"\"#]), #"p: {"a" :"\\"}"#)
        try assertYamlEqual(sub(#"p: [{"a":"${x}"}, {"b":"${x}"}]"#, ["x": #"\"#]), #"p: [{"a":"\\"}, {"b":"\\"}]"#)
        try assertYamlEqual(sub("p: {'a':'${x}'}", ["x": "it's"]), "p: {'a':'it''s'}")
        try assertYamlEqual(sub("p: {'a':'${x}'}", ["x": "a\nb"]), #"p: {'a':"a\nb"}"#)
        // The spaced spelling keeps working.
        try assertYamlEqual(sub(#"p: {"a": "${x}"}"#, ["x": #"\"#]), #"p: {"a": "\\"}"#)
    }

    func testUnspacedFlowKeyBeforeAQuoteIsOnePlainKey() throws {
        let mapping = try XCTUnwrap(Yams.compose(yaml: #"p: {a:"v"}"#)?["p"]?.mapping)
        XCTAssertEqual(mapping.count, 1)
        XCTAssertEqual(mapping.first?.key.scalar?.string, #"a:"v""#)
        XCTAssertEqual(mapping.first?.key.scalar?.style, .plain)
        XCTAssertEqual(mapping.first?.value.scalar?.string, "")
        // Substitution changes the plain key while preserving its empty value.
        try assertYamlEqual(sub(#"p: {a:"${x}"}"#, ["x": "v"]), #"p: {a:"v"}"#)
        try assertYamlEqual(sub(#"p: {a: "${x}"}"#, ["x": #"v"quoted"#]), #"p: {a: "v\"quoted"}"#)
        // The key stays unchanged; tree serialization drops the comment and its placeholder.
        try assertYamlEqual(sub(#"p: {a:"x"} # ${x}"#, ["x": "v"]), #"p: {a:"x"}"#)
    }

    // MARK: Plain-scalar continuation lines and flow state

    func testContinuationLineStartingWithAQuoteIsPlainText() throws {
        let plan = "steps:\n  - tool: x\n    text: hello\n      \"${p}\" more\n    label: ${q}"
        try assertYamlEqual(
            sub(plan, ["p": #"a\b"#, "q": "L"]),
            "steps:\n  - tool: x\n    text: hello\n      \"a\\b\" more\n    label: L"
        )
        let single = "steps:\n  - tool: x\n    text: hello\n      '${p}' more"
        try assertYamlEqual(
            sub(single, ["p": "it's"]),
            "steps:\n  - tool: x\n    text: hello\n      'it's' more"
        )
    }

    func testUnbalancedBracketOnAContinuationLineDoesNotLeakFlowModeIntoTheRestOfTheFile() throws {
        let plan = "steps:\n  - tool: x\n    text: hello\n      {x ${p}\n    label: ${q}\n    other: ${q}"
        try assertYamlEqual(
            sub(plan, ["p": "v", "q": "a,b"]),
            "steps:\n  - tool: x\n    text: hello\n      {x v\n    label: a,b\n    other: a,b"
        )
        let bracket = "steps:\n  - tool: x\n    text: hello\n      [x ${p}\n    label: ${q}"
        try assertYamlEqual(
            sub(bracket, ["p": "v", "q": "a,b"]),
            "steps:\n  - tool: x\n    text: hello\n      [x v\n    label: a,b"
        )
    }

    func testAFlowCollectionThatIsNeverClosedIsRejectedAtTheLineThatCannotContinueIt() throws {
        let plan = "steps:\n  - tool: x\n    params: {a: 1\n    label: ${q}"
        XCTAssertThrowsError(try sub(plan, ["q": "a,b"])) { error in
            guard case let AutoMobilePlanExecutor.ExecutorError.invalidPlan(message) = error else {
                return XCTFail("expected invalidPlan, got \(error)")
            }
            XCTAssertTrue(message.contains("4:"), message)
            XCTAssertTrue(message.contains("line 3"), message)
        }
    }

    func testAMultiLineFlowCollectionStillSubstitutes() throws {
        let plan = "steps:\n  - tool: x\n    textAny: [\n      ${a},\n      ${b}\n    ]\n    label: ${a}"
        try assertYamlEqual(
            sub(plan, ["a": "A", "b": "C"]),
            "steps:\n  - tool: x\n    textAny: [\n      A,\n      C\n    ]\n    label: A"
        )
    }

    func testAMultiLinePlainScalarBeginningWithPlaceholderPreservesText() throws {
        let plan = "steps:\n  - tool: x\n    text: ${p}\n      more"
        try assertYamlEqual(
            sub(plan, ["p": "a #b"]),
            "steps:\n  - tool: x\n    text: \"a #b more\""
        )
        try assertYamlEqual(
            sub(plan, ["p": "ok"]),
            "steps:\n  - tool: x\n    text: ok\n      more"
        )
    }

    // MARK: Folded block scalars

    func testFoldedBlockScalarAppliesYamlFoldingToReplacementLineBreaks() throws {
        let plan = "steps:\n  - tool: x\n    text: >\n      before ${p} after\n    label: ${q}"
        for value in ["a\nb", "a\rb"] {
            try assertYamlEqual(
                sub(plan, ["p": value, "q": "L"]),
                "steps:\n  - tool: x\n    text: >\n      before a b after\n    label: L"
            )
        }
        try assertYamlEqual(
            sub(plan, ["p": "a b", "q": "L"]),
            "steps:\n  - tool: x\n    text: >\n      before a b after\n    label: L"
        )
        // A literal block keeps the line break, so it stays accepted.
        let literal = "steps:\n  - tool: x\n    text: |\n      before ${p}\n    label: ${q}"
        try assertYamlEqual(
            sub(literal, ["p": "a\nb", "q": "L"]),
            "steps:\n  - tool: x\n    text: |\n      before a\n      b\n    label: L"
        )
    }

    // MARK: Empty string (parity with the Android runner)

    func testAnEmptyParameterIsAnEmptyStringNotNullInEveryUnquotedPosition() throws {
        try assertYamlEqual(sub(line("${p}"), ["p": ""]), expected(#""""#))
        try assertYamlEqual(sub("textAny: [${p}, OK]", ["p": ""]), #"textAny: ["", OK]"#)
        try assertYamlEqual(sub(line(#""${p}""#), ["p": ""]), expected(#""""#))
        try assertYamlEqual(sub(line("'${p}'"), ["p": ""]), expected("''"))
    }

    // MARK: Single pass and identity

    func testSubstitutedValueIsNotExpandedAgainWhateverTheKeyOrder() throws {
        try assertYamlEqual(sub(line(#""${a}-${b}""#), ["a": "${b}", "b": "x"]), expected(#""${b}-x""#))
        try assertYamlEqual(sub(line(#""${b}-${a}""#), ["a": "${b}", "b": "x"]), expected(#""x-${b}""#))
        try assertYamlEqual(sub(line("${a}"), ["a": "${b}", "b": "x"]), expected("${b}"))
    }

    func testSubstituteTextIsASinglePassAndLeavesUnknownPlaceholdersLiteral() {
        XCTAssertEqual(
            PlanParameterSubstitutor.substituteText(in: "${a}|${b}|${nope}", parameters: ["a": "${b}", "b": "x"]),
            "${b}|x|${nope}"
        )
        XCTAssertEqual(PlanParameterSubstitutor.substituteText(in: "same", parameters: [:]), "same")
        XCTAssertEqual(PlanParameterSubstitutor.substituteText(in: "${p}\u{301}", parameters: ["p": "e"]), "e\u{301}")
    }

    func testFlowSequenceResolvesPlainTypesAndKeepsQuotedStrings() throws {
        try assertYamlEqual(
            sub(#"values: [${n}, ${b}, "${n}", ${unknown}]"#, ["n": "500", "b": "true"]),
            #"values: [500, true, "500", "${unknown}"]"#
        )
    }

    func testMappingKeyReplacementCannotInjectStructure() throws {
        try assertYamlEqual(
            sub("${key}: {nested: value}", ["key": "other: key\nextra"]),
            #""other: key\nextra": {nested: value}"#
        )
    }

    func testLiteralBlockReplacementKeepsMultilineStringValue() throws {
        try assertYamlEqual(sub("text: |-\n  ${p}", ["p": "one\ntwo"]), #"text: "one\ntwo""#)
    }

    func testPlaceholderInCommentDoesNotMakeFlowYamlInvalid() throws {
        try assertYamlEqual(
            sub("# [${comment}]\nvalues: [${p}]", ["p": "yes", "comment": "["]),
            "values: [yes]"
        )
    }

    func testReplacementContainingAnotherPlaceholderIsNotExpandedInFlowSequence() throws {
        try assertYamlEqual(
            sub("values: [${a}, ${b}]", ["a": "${b}", "b": "done"]),
            #"values: ["${b}", done]"#
        )
    }

    func testAnchorsAndAliasesKeepSubstitutedValues() throws {
        let plan = "original: &shared {text: '${p}'}\ncopy: *shared"
        try assertYamlEqual(
            sub(plan, ["p": "500"]),
            #"{original: {text: "500"}, copy: {text: "500"}}"#
        )
    }

    func testPrivateUseInputAndInsertedSentinelsRemainLiteral() throws {
        let plan = "text: \"\u{E000} ${p}\""
        let out = try sub(plan, ["p": "\u{E000}\u{E000}0\u{E001}"])
        XCTAssertEqual(
            try Yams.compose(yaml: out)?["text"]?.scalar?.string,
            "\u{E000} \u{E000}\u{E000}0\u{E001}"
        )
    }

    func testEscapedPrivateUseLiteralCannotBecomeAPlaceholderSentinel() throws {
        let out = try sub(#"{literal: "\uE0000\uE001", value: "${p}"}"#, ["p": "replacement"])
        XCTAssertEqual(try Yams.compose(yaml: out)?["literal"]?.scalar?.string, "\u{E000}0\u{E001}")
        XCTAssertEqual(try Yams.compose(yaml: out)?["value"]?.scalar?.string, "replacement")
    }

    func testPlanWithoutAKnownPlaceholderIsUnchanged() throws {
        let plan = "name: p # c\nsteps:\n  - tool: inputText\n    text:   'x'\n    note: ${unknown}\n"
        XCTAssertEqual(try sub(plan, ["other": "v"]), plan)
        XCTAssertEqual(try sub(plan, [:]), plan)
    }
}
