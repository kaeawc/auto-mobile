import XCTest
@testable import XCTestRunner

/// Issue #10093: a parameter value must reach the daemon as exactly the text the test supplied and
/// must not be able to change the plan's structure. There is no YAML parser in the package, so the
/// assertions pin the exact YAML text the substitutor emits for each scalar context.
final class PlanParameterSubstitutorTests: XCTestCase {
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
        XCTAssertEqual(
            try sub(line(#""${p}""#), ["p": #"C:\temp#1 "x""#]),
            expected(#""C:\\temp#1 \"x\"""#)
        )
        XCTAssertEqual(try sub(line(#""${p}""#), ["p": #"Tr\0ub4dor"#]), expected(#""Tr\\0ub4dor""#))
        XCTAssertEqual(try sub(line(#""${p}""#), ["p": #"pa\ss"#]), expected(#""pa\\ss""#))
    }

    func testDoubleQuotedLineBreakStaysOnOneLine() throws {
        let out = try sub(line(#""${p}""#), ["p": "a\nb\r\nc\td"])
        XCTAssertEqual(out, expected(#""a\nb\r\nc\td""#))
        XCTAssertEqual(out.components(separatedBy: "\n").count, 4, "a value must not add lines to the plan")
    }

    func testDoubleQuotedControlAndUnicode() throws {
        XCTAssertEqual(try sub(line(#""${p}""#), ["p": "\u{01}\u{7F}"]), expected(#""\u0001\u007f""#))
        XCTAssertEqual(try sub(line(#""${p}""#), ["p": "Ünï — 日本語 😀"]), expected("\"Ünï — 日本語 😀\""))
    }

    func testDoubleQuotedEmbeddedAndAdjacentPlaceholders() throws {
        XCTAssertEqual(try sub(line(#""Hi ${p}!""#), ["p": #"a"b"#]), expected(#""Hi a\"b!""#))
        XCTAssertEqual(try sub(line(#""${a}-${b}""#), ["a": #"\"#, "b": "'"]), expected(#""\\-'""#))
    }

    func testDoubleQuotedMultiLineScalarEscapesOnContinuationLines() throws {
        let plan = "steps:\n  - tool: inputText\n    text: \"first ${a}\n      second ${b}\"\n    label: x"
        XCTAssertEqual(
            try sub(plan, ["a": #"\"#, "b": #"""#]),
            "steps:\n  - tool: inputText\n    text: \"first \\\\\n      second \\\"\"\n    label: x"
        )
    }

    // MARK: Single-quoted

    func testSingleQuotedDoublesQuotesAndKeepsBackslashLiteral() throws {
        XCTAssertEqual(try sub(line("'${p}'"), ["p": #"it's C:\temp"#]), expected(#"'it''s C:\temp'"#))
    }

    func testSingleQuotedValueWithLineBreakBecomesDoubleQuoted() throws {
        XCTAssertEqual(try sub(line("'x ${p} y'"), ["p": "a\nb"]), expected(#""x a\nb y""#))
        XCTAssertEqual(try sub(line("'it''s ${p}'"), ["p": "\"\t"]), expected(#""it's \"\t""#))
    }

    func testMultiLineSingleQuotedRejectsAValueItCannotCarry() {
        let plan = "steps:\n  - tool: inputText\n    text: 'first\n      ${p}'"
        XCTAssertThrowsError(try sub(plan, ["p": "a\nb"]))
        XCTAssertEqual(
            try sub(plan, ["p": "it's"]),
            "steps:\n  - tool: inputText\n    text: 'first\n      it''s'"
        )
    }

    // MARK: Unquoted

    func testUnquotedPlainSafeValueIsSplicedRawSoNumbersAndBooleansKeepTheirType() throws {
        XCTAssertEqual(try sub(line("${p}"), ["p": "500"]), expected("500"))
        XCTAssertEqual(try sub(line("${p}"), ["p": "true"]), expected("true"))
        XCTAssertEqual(try sub(line("${p}"), ["p": "hunter2"]), expected("hunter2"))
        XCTAssertEqual(try sub(line("${p}"), ["p": #"C:\temp"#]), expected(#"C:\temp"#))
        XCTAssertEqual(try sub(line("${p}"), ["p": "it's #1"]), expected(#""it's #1""#))
    }

    func testUnquotedNonPlainSafeValueBecomesADoubleQuotedString() throws {
        XCTAssertEqual(try sub(line("${p}"), ["p": "shoes #1"]), expected(#""shoes #1""#))
        XCTAssertEqual(try sub(line("${p}"), ["p": "size: large"]), expected(#""size: large""#))
        XCTAssertEqual(try sub(line("${p}"), ["p": " padded "]), expected(#"" padded ""#))
        XCTAssertEqual(try sub(line("${p}"), ["p": "'"]), expected(#""'""#))
        XCTAssertEqual(try sub(line("${p}"), ["p": "- dash"]), expected(#""- dash""#))
        XCTAssertEqual(try sub(line("${p}"), ["p": "ends:"]), expected(#""ends:""#))
        XCTAssertEqual(try sub(line("${p}"), ["p": ""]), expected(#""""#))
    }

    func testUnquotedValueCannotAddStepsOrKeys() throws {
        let out = try sub(line("${p}"), ["p": "a\n  - tool: terminateApp\n    appId: evil"])
        XCTAssertEqual(out, expected(#""a\n  - tool: terminateApp\n    appId: evil""#))
        XCTAssertEqual(out.components(separatedBy: "\n").count, 4)
    }

    func testUnquotedEmbeddedPlaceholder() throws {
        XCTAssertEqual(try sub(line("Hi ${p}"), ["p": "bob"]), expected("Hi bob"))
        XCTAssertEqual(try sub(line("Hi ${p}"), ["p": "x #1"]), expected(#""Hi x #1""#))
    }

    func testUnquotedPlaceholderInFlowCollectionAndAsKey() throws {
        XCTAssertEqual(
            try sub("textAny: [${a}, ${b}, OK]", ["a": "A,B", "b": "C"]),
            #"textAny: ["A,B", C, OK]"#
        )
        XCTAssertEqual(try sub("map: {k: ${v}}", ["v": "x}"]), #"map: {k: "x}"}"#)
        XCTAssertEqual(try sub("${k}: v", ["k": "key: x"]), #""key: x": v"#)
        XCTAssertEqual(try sub("${k}: v", ["k": "name"]), "name: v")
    }

    func testUnquotedContinuationLineRejectsAValueItCannotRewrite() throws {
        let plan = "steps:\n  - tool: inputText\n    text: hello\n      ${p} more"
        XCTAssertThrowsError(try sub(plan, ["p": "a #b"])) { error in
            guard case AutoMobilePlanExecutor.ExecutorError.invalidPlan = error else {
                return XCTFail("expected invalidPlan, got \(error)")
            }
        }
        XCTAssertEqual(
            try sub(plan, ["p": "ok"]),
            "steps:\n  - tool: inputText\n    text: hello\n      ok more"
        )
    }

    // MARK: Comments and block scalars

    func testCommentsAreLeftUntouched() throws {
        let plan = "# ${p}\nsteps:\n  - tool: inputText\n    text: \"${p}\" # note ${p}\n    label: x"
        XCTAssertEqual(
            try sub(plan, ["p": "a\nb"]),
            "# ${p}\nsteps:\n  - tool: inputText\n    text: \"a\\nb\" # note ${p}\n    label: x"
        )
    }

    func testBlockScalarSplicesRawAndReindentsLineBreaks() throws {
        let plan = "steps:\n  - tool: inputText\n    text: |\n      before ${p} after\n    label: ${q}"
        XCTAssertEqual(
            try sub(plan, ["p": "x\n- tool: terminateApp\nC:\\temp", "q": "L"]),
            "steps:\n  - tool: inputText\n    text: |\n      before x\n      - tool: terminateApp\n      C:\\temp after\n    label: L"
        )
    }

    func testBlockScalarEndsAtTheNextSiblingKeyOnADashLine() throws {
        let plan = "steps:\n  - text: >-\n      ${p}\n    label: ${q}"
        XCTAssertEqual(
            try sub(plan, ["p": "a b", "q": "z #"]),
            "steps:\n  - text: >-\n      a b\n    label: \"z #\""
        )
    }

    // MARK: Compact JSON-style flow maps

    func testCompactFlowMapValueIsEscapedLikeAnyDoubleQuotedScalar() throws {
        let plan = "steps:\n  - tool: x\n    params: {\"text\":\"${v}\"}"
        XCTAssertEqual(
            try sub(plan, ["v": #"C:\new\tab"#]),
            "steps:\n  - tool: x\n    params: {\"text\":\"C:\\\\new\\\\tab\"}"
        )
        XCTAssertEqual(
            try sub(plan, ["v": #"a"b"#]),
            "steps:\n  - tool: x\n    params: {\"text\":\"a\\\"b\"}"
        )
        XCTAssertEqual(
            try sub(plan, ["v": "a\nb"]),
            "steps:\n  - tool: x\n    params: {\"text\":\"a\\nb\"}"
        )
    }

    func testCompactFlowMapVariants() throws {
        XCTAssertEqual(
            try sub(#"p: {"a":"${x}","b":"${y}"}"#, ["x": #"\"#, "y": #"""#]),
            #"p: {"a":"\\","b":"\""}"#
        )
        XCTAssertEqual(try sub(#"p: {"a" :"${x}"}"#, ["x": #"\"#]), #"p: {"a" :"\\"}"#)
        XCTAssertEqual(try sub(#"p: [{"a":"${x}"}, {"b":"${x}"}]"#, ["x": #"\"#]), #"p: [{"a":"\\"}, {"b":"\\"}]"#)
        XCTAssertEqual(try sub("p: {'a':'${x}'}", ["x": "it's"]), "p: {'a':'it''s'}")
        XCTAssertEqual(try sub("p: {'a':'${x}'}", ["x": "a\nb"]), #"p: {'a':"a\nb"}"#)
        // The spaced spelling keeps working.
        XCTAssertEqual(try sub(#"p: {"a": "${x}"}"#, ["x": #"\"#]), #"p: {"a": "\\"}"#)
    }

    func testUnquotedFlowKeyDirectlyBeforeAQuoteIsRejectedNotGuessed() throws {
        XCTAssertThrowsError(try sub(#"p: {a:"${x}"}"#, ["x": "v"])) { error in
            guard case let AutoMobilePlanExecutor.ExecutorError.invalidPlan(message) = error else {
                return XCTFail("expected invalidPlan, got \(error)")
            }
            XCTAssertTrue(message.contains("line 1"), message)
        }
        // No placeholder in it: copied through untouched.
        XCTAssertEqual(try sub(#"p: {a:"x"} # ${x}"#, ["x": "v"]), #"p: {a:"x"} # ${x}"#)
    }

    // MARK: Plain-scalar continuation lines and flow state

    func testContinuationLineStartingWithAQuoteIsPlainText() throws {
        let plan = "steps:\n  - tool: x\n    text: hello\n      \"${p}\" more\n    label: ${q}"
        XCTAssertEqual(
            try sub(plan, ["p": #"a\b"#, "q": "L"]),
            "steps:\n  - tool: x\n    text: hello\n      \"a\\b\" more\n    label: L"
        )
        let single = "steps:\n  - tool: x\n    text: hello\n      '${p}' more"
        XCTAssertEqual(
            try sub(single, ["p": "it's"]),
            "steps:\n  - tool: x\n    text: hello\n      'it's' more"
        )
    }

    func testUnbalancedBracketOnAContinuationLineDoesNotLeakFlowModeIntoTheRestOfTheFile() throws {
        let plan = "steps:\n  - tool: x\n    text: hello\n      {x ${p}\n    label: ${q}\n    other: ${q}"
        XCTAssertEqual(
            try sub(plan, ["p": "v", "q": "a,b"]),
            "steps:\n  - tool: x\n    text: hello\n      {x v\n    label: a,b\n    other: a,b"
        )
        let bracket = "steps:\n  - tool: x\n    text: hello\n      [x ${p}\n    label: ${q}"
        XCTAssertEqual(
            try sub(bracket, ["p": "v", "q": "a,b"]),
            "steps:\n  - tool: x\n    text: hello\n      [x v\n    label: a,b"
        )
    }

    func testAFlowCollectionThatIsNeverClosedIsRejectedAtTheLineThatCannotContinueIt() throws {
        let plan = "steps:\n  - tool: x\n    params: {a: 1\n    label: ${q}"
        XCTAssertThrowsError(try sub(plan, ["q": "a,b"])) { error in
            guard case let AutoMobilePlanExecutor.ExecutorError.invalidPlan(message) = error else {
                return XCTFail("expected invalidPlan, got \(error)")
            }
            XCTAssertTrue(message.contains("line 4"), message)
            XCTAssertTrue(message.contains("line 3"), message)
        }
    }

    func testAMultiLineFlowCollectionStillSubstitutes() throws {
        let plan = "steps:\n  - tool: x\n    textAny: [\n      ${a},\n      ${b}\n    ]\n    label: ${a}"
        XCTAssertEqual(
            try sub(plan, ["a": "A", "b": "C"]),
            "steps:\n  - tool: x\n    textAny: [\n      A,\n      C\n    ]\n    label: A"
        )
    }

    func testAMultiLinePlainScalarWhoseFirstLineWasRewrittenAsQuotedIsRejected() throws {
        let plan = "steps:\n  - tool: x\n    text: ${p}\n      more"
        XCTAssertThrowsError(try sub(plan, ["p": "a #b"])) { error in
            guard case AutoMobilePlanExecutor.ExecutorError.invalidPlan = error else {
                return XCTFail("expected invalidPlan, got \(error)")
            }
        }
        XCTAssertEqual(
            try sub(plan, ["p": "ok"]),
            "steps:\n  - tool: x\n    text: ok\n      more"
        )
    }

    // MARK: Folded block scalars

    func testFoldedBlockScalarRejectsAMultiLineValueButTakesASingleLineOne() throws {
        let plan = "steps:\n  - tool: x\n    text: >\n      before ${p} after\n    label: ${q}"
        XCTAssertThrowsError(try sub(plan, ["p": "a\nb", "q": "L"])) { error in
            guard case let AutoMobilePlanExecutor.ExecutorError.invalidPlan(message) = error else {
                return XCTFail("expected invalidPlan, got \(error)")
            }
            XCTAssertTrue(message.contains("line 4"), message)
        }
        XCTAssertThrowsError(try sub(plan, ["p": "a\rb", "q": "L"]))
        XCTAssertEqual(
            try sub(plan, ["p": "a b", "q": "L"]),
            "steps:\n  - tool: x\n    text: >\n      before a b after\n    label: L"
        )
        // A literal block keeps the line break, so it stays accepted.
        let literal = "steps:\n  - tool: x\n    text: |\n      before ${p}\n    label: ${q}"
        XCTAssertEqual(
            try sub(literal, ["p": "a\nb", "q": "L"]),
            "steps:\n  - tool: x\n    text: |\n      before a\n      b\n    label: L"
        )
    }

    // MARK: Empty string (parity with the Android runner)

    func testAnEmptyParameterIsAnEmptyStringNotNullInEveryUnquotedPosition() throws {
        XCTAssertEqual(try sub(line("${p}"), ["p": ""]), expected(#""""#))
        XCTAssertEqual(try sub("textAny: [${p}, OK]", ["p": ""]), #"textAny: ["", OK]"#)
        XCTAssertEqual(try sub(line(#""${p}""#), ["p": ""]), expected(#""""#))
        XCTAssertEqual(try sub(line("'${p}'"), ["p": ""]), expected("''"))
    }

    // MARK: Single pass and identity

    func testSubstitutedValueIsNotExpandedAgainWhateverTheKeyOrder() throws {
        XCTAssertEqual(try sub(line(#""${a}-${b}""#), ["a": "${b}", "b": "x"]), expected(#""${b}-x""#))
        XCTAssertEqual(try sub(line(#""${b}-${a}""#), ["a": "${b}", "b": "x"]), expected(#""x-${b}""#))
        XCTAssertEqual(try sub(line("${a}"), ["a": "${b}", "b": "x"]), expected("${b}"))
    }

    func testSubstituteTextIsASinglePassAndLeavesUnknownPlaceholdersLiteral() {
        XCTAssertEqual(
            PlanParameterSubstitutor.substituteText(in: "${a}|${b}|${nope}", parameters: ["a": "${b}", "b": "x"]),
            "${b}|x|${nope}"
        )
        XCTAssertEqual(PlanParameterSubstitutor.substituteText(in: "same", parameters: [:]), "same")
        XCTAssertEqual(PlanParameterSubstitutor.substituteText(in: "${p}\u{301}", parameters: ["p": "e"]), "e\u{301}")
    }

    func testPlanWithoutAKnownPlaceholderIsUnchanged() throws {
        let plan = "name: p # c\nsteps:\n  - tool: inputText\n    text:   'x'\n    note: ${unknown}\n"
        XCTAssertEqual(try sub(plan, ["other": "v"]), plan)
        XCTAssertEqual(try sub(plan, [:]), plan)
    }
}
