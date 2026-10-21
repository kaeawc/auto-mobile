@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeStackScreenValidatorTests: XCTestCase {
    private func decode(_ screen: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"stack-screen-validator","window":{"placement":{"type":"fullscreen"}},
         "state":{"open":true},"root":{"type":"stack","id":"nav","start":"home",
         "screens":{"home":\(screen)}}}
        """.utf8))
    }

    func testMenuValidationDescendsIntoScreens() {
        XCTAssertThrowsError(
            try decode(
                #"{"type":"menu","items":[{"label":"Open","extra":true}],"openWhen":{"key":"open","equals":true}}"#
            )
        ) { error in
            XCTAssertTrue(String(describing: error).contains("root.screens[\"home\"].items[0].extra"))
        }
        XCTAssertThrowsError(
            try decode(
                #"{"type":"select","stateKey":"choice","options":[{"value":"a","label":7},{"value":"b","label":"B"}]}"#
            )
        ) { error in
            XCTAssertTrue(String(describing: error).contains("root.screens[\"home\"].options[0].label"))
        }
    }

    func testPagerValidationDescendsIntoScreens() {
        XCTAssertThrowsError(try decode(
            #"{"type":"pager","pageSpacing":-1,"children":[{"type":"text","text":"x"}]}"#
        )) { error in
            XCTAssertTrue(String(describing: error).contains("root.screens[\"home\"].pageSpacing"))
        }
        XCTAssertThrowsError(
            try decode(
                #"{"type":"scroll","axis":"vertical","child":{"type":"pager","axis":"vertical","children":[{"type":"text","text":"x"}]}}"#
            )
        ) { error in
            XCTAssertTrue(String(describing: error).contains("root.screens[\"home\"].child.axis"))
            XCTAssertTrue(String(describing: error).contains("vertical pager cannot appear inside a vertical scroll"))
        }
    }

    func testPagerValidationPropagatesVerticalScrollThroughNestedStackScreens() throws {
        let nestedStack =
            #"{"type":"stack","id":"inner-nav","start":"inner","screens":{"inner":{"type":"pager","axis":"vertical","children":[{"type":"text","text":"Page"}]}}}"#
        XCTAssertThrowsError(try decode(#"{"type":"scroll","axis":"vertical","child":"# + nestedStack + "}")) { error in
            XCTAssertTrue(String(describing: error).contains("root.screens[\"home\"].child.screens[\"inner\"].axis"))
            XCTAssertTrue(String(describing: error).contains("vertical pager cannot appear inside a vertical scroll"))
        }
        _ = try decode(nestedStack)
    }

    func testAuthoredSelectTextValidationVisitsEmptyRepeatTemplatesInScreens() {
        XCTAssertThrowsError(
            try decode(
                #"{"type":"column","children":[{"type":"column","repeat":{"as":"row","items":[]},"children":[{"type":"select","stateKey":"choice","options":[{"value":"a","label":7},{"value":"b","label":"B"}]}]}]}"#
            )
        ) { error in
            XCTAssertTrue(
                String(describing: error)
                    .contains("root.screens[\"home\"].children[0].children[0].options[0].label")
            )
        }
    }

    func testSelectValidationChecksDuplicateOptionValuesInScreens() {
        XCTAssertThrowsError(
            try decode(
                #"{"type":"select","stateKey":"choice","options":[{"value":"same","label":"A"},{"value":"same","label":"B"}]}"#
            )
        ) { error in
            XCTAssertTrue(String(describing: error).contains("root.screens[\"home\"].options[1].value"))
            XCTAssertTrue(String(describing: error).contains("Duplicate select option value"))
        }
    }

    func testEmitContextValidationDescendsIntoScreens() {
        XCTAssertThrowsError(
            try decode(#"{"type":"button","onTap":[{"type":"emit","name":"save","context":{"row":{"item":"name"}}}]}"#)
        ) { error in
            XCTAssertTrue(String(describing: error).contains("root.screens[\"home\"].onTap[0].context.row"))
            XCTAssertTrue(String(describing: error).contains("Emit item/index binding outside a repeat template"))
        }
    }

    func testValidValidatorsInsideStackScreenDecode() throws {
        _ =
            try decode(
                #"{"type":"column","children":[{"type":"menu","items":[{"label":"Open"}],"openWhen":{"key":"open","equals":true}},{"type":"pager","children":[{"type":"text","text":"Page"}]},{"type":"button","onTap":[{"type":"emit","name":"save","context":{"label":{"value":"ready"}}}]}]}"#
            )
    }
}
