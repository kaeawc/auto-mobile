@testable import CtrlProxy
import XCTest

final class ClipboardResolutionTests: XCTestCase {
    func testGetReturnsLivePasteboardValueInsteadOfShadow() throws {
        let text = try GesturePerformer.resolveClipboardGet(
            readResult: .value("external")
        )

        XCTAssertEqual(text, "external")
    }

    func testGetReturnsEmptyWhenPasteboardHasNoStringInsteadOfShadow() throws {
        let text = try GesturePerformer.resolveClipboardGet(
            readResult: .empty
        )

        XCTAssertNil(text)
    }

    func testGetReturnsEmptyWhenLivePasteboardValueIsEmptyString() throws {
        let text = try GesturePerformer.resolveClipboardGet(
            readResult: .value("")
        )

        XCTAssertNil(text)
    }

    func testGetThrowsWhenLivePasteboardReadIsUnavailableInsteadOfReturningShadow() {
        XCTAssertThrowsError(try GesturePerformer.resolveClipboardGet(
            readResult: .unavailable
        )) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "Clipboard read unavailable; live pasteboard access may be restricted, so shadow clipboard content was not returned"
            )
        }
    }
}
