#if DEBUG && !os(watchOS)
    @testable import AutoMobileSDK
    import XCTest

    @MainActor
    private final class FakeFocusElement: AccessibilityFocusElement {
        var focusIdentifier: String?
        var focusLabel: String?
        var focusValue: String?
        var focusEligible = true
        var focusChildren: [any AccessibilityFocusElement] = []
    }

    @MainActor
    final class SdkAccessibilityFocusTests: XCTestCase {
        func testMatchesIdentifierLabelAndValueInHierarchyOrder() {
            let root = FakeFocusElement()
            root.focusEligible = false
            let first = FakeFocusElement()
            first.focusIdentifier = "save"
            first.focusLabel = "Save"
            first.focusValue = "Ready"
            let second = FakeFocusElement()
            second.focusIdentifier = "save"
            second.focusLabel = "Save"
            root.focusChildren = [first, second]
            // A vended element can lead back to a containing view; never loop on it.
            second.focusChildren = [root]
            let selectors = [
                SdkAccessibilityFocusSelector(resourceId: "save"),
                SdkAccessibilityFocusSelector(text: "Save"),
                SdkAccessibilityFocusSelector(text: "Ready"),
                SdkAccessibilityFocusSelector(contentDesc: "Save"),
                SdkAccessibilityFocusSelector(contentDesc: "Ready"),
                SdkAccessibilityFocusSelector(resourceId: "save", text: "ignored"),
            ]
            for selector in selectors {
                XCTAssertTrue(SdkAccessibilityFocus.firstMatch(selector: selector, roots: [root]) === first)
            }
            XCTAssertNil(SdkAccessibilityFocus.firstMatch(selector: .init(text: "missing"), roots: [root]))
            XCTAssertNil(SdkAccessibilityFocus.firstMatch(selector: .init(text: "save"), roots: [root]))
        }

        func testVoiceOverOffPrecedesSelectorValidationAndNeverWalksOrPosts() {
            let result = SdkAccessibilityFocus.perform(
                selector: .init(), voiceOverRunning: false,
                roots: { XCTFail("must not walk"); return [] },
                post: { _ in XCTFail("must not post") }
            )
            XCTAssertEqual(result.errorCode, "voiceover_off")
        }

        func testInvalidMissingAndSuccessfulSelectors() {
            let element = FakeFocusElement()
            element.focusIdentifier = "save"
            var posted: (any AccessibilityFocusElement)?
            func perform(_ selector: SdkAccessibilityFocusSelector) -> SdkAccessibilityFocusResult {
                SdkAccessibilityFocus.perform(
                    selector: selector, voiceOverRunning: true,
                    roots: { [element] }, post: { posted = $0 }
                )
            }
            XCTAssertEqual(perform(.init()).errorCode, "invalid_selector")
            XCTAssertEqual(perform(.init(resourceId: "")).errorCode, "invalid_selector")
            XCTAssertEqual(perform(.init(text: "missing")).errorCode, "element_not_found")
            XCTAssertNil(posted)
            let success = perform(.init(resourceId: "save"))
            XCTAssertEqual(success.status, "ok")
            XCTAssertNil(success.errorCode)
            XCTAssertTrue(posted === element)
        }
    }
#endif
