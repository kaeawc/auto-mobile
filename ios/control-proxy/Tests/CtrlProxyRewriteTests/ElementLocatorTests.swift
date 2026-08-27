@testable import CtrlProxyRewrite
import XCTest

/// Rewrite parity coverage for `ElementLocator`'s platform-independent helpers.
///
/// The macOS SPM gate builds for the host, so the `#if canImport(XCTest) && os(iOS)` block
/// (the XCUITest capture, `findElement`, foreground detection) is excluded and compile-verified
/// only in Xcode at Phase 7. What is exercised here is exactly what the host compiles: the
/// `nonisolated static` pure helpers and the main-actor `ForegroundTracker` value.
///
/// Diverges from the reference `CtrlProxyTests/ElementLocatorTests` by dropping tests for
/// scaffolding the rewrite deleted: `ThreadSafeCache` (the element cache is now a plain
/// main-actor dictionary) and `FakeElementLocator`-based `foregroundBundleId` contract tests
/// (that fake arrives with the Phase 6 CommandHandler port). The `ForegroundTracker` tests use
/// `var` because the reference's lock-guarded class became a `mutating`-method struct.
final class ElementLocatorTests: XCTestCase {
    func testCopyingPreservesSemanticLinksOnRetainedLink() {
        let link = UIElementInfo(
            text: "Terms of Service",
            clickable: "true",
            semanticLinks: [SemanticLink(text: "Terms of Service", occurrence: 0)],
            role: "link"
        )
        let optimized = ElementLocator.copying(link, node: nil)

        XCTAssertEqual(optimized.semanticLinks, link.semanticLinks)
    }

    // MARK: - SpringBoard fallback lookup (#4014)

    func testFirstMatchingElement_prefersForegroundApplication() {
        var springBoardQueried = false

        let result: String? = ElementLocator.firstMatchingElement(
            foregroundLookup: { "app OK" },
            springBoardLookup: {
                springBoardQueried = true
                return "SpringBoard OK"
            }
        )

        XCTAssertEqual(result, "app OK")
        XCTAssertFalse(springBoardQueried)
    }

    func testFirstMatchingElement_fallsBackToSpringBoardAfterForegroundMiss() {
        var foregroundQueries = 0
        var springBoardQueries = 0

        let result: String? = ElementLocator.firstMatchingElement(
            foregroundLookup: {
                foregroundQueries += 1
                return nil
            },
            springBoardLookup: {
                springBoardQueries += 1
                return "SpringBoard OK"
            }
        )

        XCTAssertEqual(result, "SpringBoard OK")
        XCTAssertEqual(foregroundQueries, 1)
        XCTAssertEqual(springBoardQueries, 1)
    }

    func testFirstMatchingElement_returnsNilWhenNeitherApplicationHasMatch() {
        let result: String? = ElementLocator.firstMatchingElement(
            foregroundLookup: { nil },
            springBoardLookup: { nil }
        )

        XCTAssertNil(result)
    }

    // MARK: - hasUniqueIdentifyingProperties

    func testHasUniqueProperties_withText() {
        let element = UIElementInfo(text: "Hello")
        XCTAssertTrue(ElementLocator.hasUniqueIdentifyingProperties(element))
    }

    func testHasUniqueProperties_withResourceId() {
        let element = UIElementInfo(resourceId: "my_field")
        XCTAssertTrue(ElementLocator.hasUniqueIdentifyingProperties(element))
    }

    func testHasUniqueProperties_withContentDesc() {
        let element = UIElementInfo(contentDesc: "Description")
        XCTAssertTrue(ElementLocator.hasUniqueIdentifyingProperties(element))
    }

    func testHasUniqueProperties_withHintText() {
        let element = UIElementInfo(hintText: "Enter name")
        XCTAssertTrue(ElementLocator.hasUniqueIdentifyingProperties(element))
    }

    func testHasUniqueProperties_emptyElement() {
        let element = UIElementInfo(className: "UIView", bounds: ElementBounds(left: 0, top: 0, right: 100, bottom: 50))
        XCTAssertFalse(ElementLocator.hasUniqueIdentifyingProperties(element))
    }

    func testHasUniqueProperties_onlyBooleanFlags() {
        let element = UIElementInfo(clickable: "true", focused: "true")
        XCTAssertFalse(ElementLocator.hasUniqueIdentifyingProperties(element))
    }

    // MARK: - collapseSameTypeTextInputChildren

    func testCollapse_textFieldInTextField_noUniqueProps() {
        let grandchild = UIElementInfo(text: "Cursor", className: "UIView")
        let innerTextField = UIElementInfo(
            className: "UITextField",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44),
            node: [grandchild]
        )
        let sibling = UIElementInfo(text: "Label", className: "UILabel")

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [innerTextField, sibling]
        )

        // Inner UITextField collapsed — its grandchild promoted, sibling kept
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].text, "Cursor")
        XCTAssertEqual(result[0].className, "UIView")
        XCTAssertEqual(result[1].text, "Label")
    }

    func testCollapse_textFieldInTextField_emptyInner() {
        let innerTextField = UIElementInfo(
            className: "UITextField",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [innerTextField]
        )

        // Empty inner UITextField discarded entirely
        XCTAssertEqual(result.count, 0)
    }

    func testCollapse_preserves_childWithUniqueId() {
        let innerWithId = UIElementInfo(
            resourceId: "search_input",
            className: "UITextField",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [innerWithId]
        )

        // Child has a resourceId — it's a distinct element, not collapsed
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].resourceId, "search_input")
    }

    func testCollapse_preserves_childWithText() {
        let innerWithText = UIElementInfo(
            text: "Search",
            className: "UITextField",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [innerWithText]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].text, "Search")
    }

    func testCollapse_secureTextField() {
        let inner = UIElementInfo(
            className: "UISecureTextField",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UISecureTextField",
            children: [inner]
        )

        XCTAssertEqual(result.count, 0)
    }

    func testCollapse_textView() {
        let grandchild = UIElementInfo(text: "Content", className: "UILabel")
        let inner = UIElementInfo(
            className: "UITextView",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 200),
            node: [grandchild]
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextView",
            children: [inner]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].text, "Content")
    }

    func testCollapse_searchBar() {
        let inner = UIElementInfo(
            className: "UISearchBar",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UISearchBar",
            children: [inner]
        )

        XCTAssertEqual(result.count, 0)
    }

    func testCollapse_skipsNonTextInputParent() {
        // UIButton parent with UIButton child — should NOT collapse
        let innerButton = UIElementInfo(
            className: "UIButton",
            bounds: ElementBounds(left: 0, top: 0, right: 100, bottom: 44)
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UIButton",
            children: [innerButton]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].className, "UIButton")
    }

    func testCollapse_differentClassName_notCollapsed() {
        // UILabel child inside UITextField parent — different type, keep it
        let label = UIElementInfo(
            className: "UILabel",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [label]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].className, "UILabel")
    }

    func testCollapse_multipleNestedLevels() {
        // UITextField > UITextField (no props) > UITextField (no props) > UILabel
        let label = UIElementInfo(text: "Deep", className: "UILabel")
        let innermost = UIElementInfo(
            className: "UITextField",
            node: [label]
        )
        let middle = UIElementInfo(
            className: "UITextField",
            node: [innermost]
        )

        // First pass collapses middle → promotes innermost
        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [middle]
        )

        // Middle collapsed, innermost (still UITextField with no unique props) promoted
        // But collapseSameTypeTextInputChildren is single-level — the innermost
        // would be collapsed when buildElementInfoFromSnapshot processes it as a child
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].className, "UITextField")
        XCTAssertEqual(result[0].node?.count, 1)
        XCTAssertEqual(result[0].node?[0].text, "Deep")
    }

    // MARK: - deduplicateSiblings

    func testDedup_identicalBoundsAndType_noUniqueProps() {
        let bounds = ElementBounds(left: 10, top: 20, right: 310, bottom: 64)
        let a = UIElementInfo(className: "UIView", bounds: bounds)
        let b = UIElementInfo(className: "UIView", bounds: bounds)
        let c = UIElementInfo(className: "UIView", bounds: bounds)

        let result = ElementLocator.deduplicateSiblings([a, b, c])

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].className, "UIView")
    }

    // MARK: - XCTest/UIKit structural noise cleanup (#3317)

    func testCleanup_dedupesDuplicateScrollBarsWithTextAndBounds() {
        let bounds = ElementBounds(left: 383, top: 156, right: 390, bottom: 742)
        let first = UIElementInfo(text: "Vertical scroll bar, 1 page", className: "UIView", bounds: bounds)
        let duplicate = UIElementInfo(text: "Vertical scroll bar, 1 page", className: "UIView", bounds: bounds)
        let reminder = UIElementInfo(text: "Groceries", className: "UITableViewCell", bounds: ElementBounds(left: 0, top: 156, right: 393, bottom: 200))

        let result = ElementLocator.cleanupXCTestUIKitNoise(
            parent: UIElementInfo(className: "UITableView", scrollable: "true"),
            children: [first, duplicate, reminder]
        )

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result.filter { $0.text == "Vertical scroll bar, 1 page" }.count, 1)
        XCTAssertEqual(result[1].text, "Groceries")
    }

    func testCleanup_removesLabelChildDuplicatingActionableParentText() {
        let duplicateLabel = UIElementInfo(text: "New Reminder", className: "UILabel", bounds: ElementBounds(left: 16, top: 786, right: 201, bottom: 823), role: "text")
        let icon = UIElementInfo(resourceId: "plus", className: "UIImageView", bounds: ElementBounds(left: 16, top: 790, right: 36, bottom: 810))

        let result = ElementLocator.cleanupXCTestUIKitNoise(
            parent: UIElementInfo(text: "New Reminder", className: "UIButton", clickable: "true"),
            children: [duplicateLabel, icon]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].resourceId, "plus")
    }

    func testCleanup_removesStructuralWrapperContainingOnlyScrollbarNoise() {
        let scrollBar = UIElementInfo(text: "Horizontal scroll bar, 1 page", className: "UIView", bounds: ElementBounds(left: 30, top: 830, right: 363, bottom: 837))
        let wrapper = UIElementInfo(className: "UIView", bounds: ElementBounds(left: 0, top: 786, right: 393, bottom: 852), node: [scrollBar])
        let toolbarButton = UIElementInfo(text: "Lists", className: "UIButton", bounds: ElementBounds(left: 300, top: 786, right: 370, bottom: 823), clickable: "true")

        let result = ElementLocator.cleanupXCTestUIKitNoise(
            parent: UIElementInfo(className: "UIView"),
            children: [wrapper, toolbarButton]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].text, "Lists")
    }

    func testCleanup_dedupesRepeatedKeyboardAccessoryAndDictationNodes() {
        let bounds = ElementBounds(left: 0, top: 720, right: 393, bottom: 760)
        let first = UIElementInfo(text: "dictation", className: "UIButton", bounds: bounds, clickable: "true", role: "button")
        let duplicate = UIElementInfo(text: "dictation", className: "UIButton", bounds: bounds, clickable: "true", role: "button")
        let done = UIElementInfo(text: "Done", className: "UIButton", bounds: ElementBounds(left: 335, top: 720, right: 383, bottom: 760), clickable: "true")

        let result = ElementLocator.cleanupXCTestUIKitNoise(
            parent: UIElementInfo(className: "UIKeyboard"),
            children: [first, duplicate, done]
        )

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result.filter { $0.text == "dictation" }.count, 1)
        XCTAssertEqual(result[1].text, "Done")
    }

    func testCleanup_preservesKeyboardAccessoryNodesWithDistinctResourceIds() {
        let bounds = ElementBounds(left: 0, top: 720, right: 393, bottom: 760)
        let first = UIElementInfo(text: "dictation", resourceId: "dictation-primary", className: "UIButton", bounds: bounds, clickable: "true", role: "button")
        let second = UIElementInfo(text: "dictation", resourceId: "dictation-secondary", className: "UIButton", bounds: bounds, clickable: "true", role: "button")

        let result = ElementLocator.cleanupXCTestUIKitNoise(
            parent: UIElementInfo(className: "UIKeyboard"),
            children: [first, second]
        )

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].resourceId, "dictation-primary")
        XCTAssertEqual(result[1].resourceId, "dictation-secondary")
    }

    func testCleanup_preservesActionableControlEvenWhenTextDuplicatesParent() {
        let childButton = UIElementInfo(text: "New Reminder", resourceId: "new_reminder_child", className: "UIButton", clickable: "true")
        let result = ElementLocator.cleanupXCTestUIKitNoise(
            parent: UIElementInfo(text: "New Reminder", className: "UIButton", clickable: "true"),
            children: [childButton]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].resourceId, "new_reminder_child")
        XCTAssertEqual(result[0].clickable, "true")
    }

    func testCleanup_preservesLongClickableNodeThatLooksLikeDuplicateNoise() {
        let bounds = ElementBounds(left: 12, top: 120, right: 380, bottom: 164)
        let first = UIElementInfo(text: "More", className: "UIView", bounds: bounds, longClickable: "true")
        let second = UIElementInfo(text: "More", className: "UIView", bounds: bounds, longClickable: "true")

        let result = ElementLocator.cleanupXCTestUIKitNoise(
            parent: UIElementInfo(className: "UIView"),
            children: [first, second]
        )

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].longClickable, "true")
        XCTAssertEqual(result[1].longClickable, "true")
    }

    func testCleanup_preservesRoleBearingContainerAroundScrollBarText() {
        let scrollBar = UIElementInfo(text: "Vertical scroll bar, 1 page", className: "UIView", bounds: ElementBounds(left: 383, top: 156, right: 390, bottom: 704))
        let container = UIElementInfo(className: "UIView", bounds: ElementBounds(left: 0, top: 120, right: 393, bottom: 720), role: "listitem", node: [scrollBar])

        let result = ElementLocator.cleanupXCTestUIKitNoise(
            parent: UIElementInfo(className: "UIView"),
            children: [container]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].role, "listitem")
        XCTAssertEqual(result[0].node?.first?.text, "Vertical scroll bar, 1 page")
    }

    func testCleanup_preservesSdkOrCustomActionMetadata() {
        let bounds = ElementBounds(left: 0, top: 720, right: 393, bottom: 760)
        let withActions = UIElementInfo(text: "dictation", className: "UIButton", bounds: bounds, actions: ["custom_action"])
        let withExtras = UIElementInfo(text: "dictation", className: "UIButton", bounds: bounds, extras: ["sdk.gestureRecognizers": "UILongPressGestureRecognizer"])

        let result = ElementLocator.cleanupXCTestUIKitNoise(
            parent: UIElementInfo(className: "UIKeyboard"),
            children: [withActions, withExtras]
        )

        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].actions, ["custom_action"])
        XCTAssertEqual(result[1].extras?["sdk.gestureRecognizers"], "UILongPressGestureRecognizer")
    }

    func testDedup_sameType_differentBounds_kept() {
        let a = UIElementInfo(className: "UIView", bounds: ElementBounds(left: 0, top: 0, right: 100, bottom: 50))
        let b = UIElementInfo(className: "UIView", bounds: ElementBounds(left: 0, top: 50, right: 100, bottom: 100))

        let result = ElementLocator.deduplicateSiblings([a, b])

        XCTAssertEqual(result.count, 2)
    }

    func testDedup_sameBounds_differentType_kept() {
        let bounds = ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        let a = UIElementInfo(className: "UIView", bounds: bounds)
        let b = UIElementInfo(className: "UIImageView", bounds: bounds)

        let result = ElementLocator.deduplicateSiblings([a, b])

        XCTAssertEqual(result.count, 2)
    }

    func testDedup_preservesElementsWithUniqueProperties() {
        let bounds = ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        let a = UIElementInfo(text: "First", className: "UIView", bounds: bounds)
        let b = UIElementInfo(text: "Second", className: "UIView", bounds: bounds)

        let result = ElementLocator.deduplicateSiblings([a, b])

        // Both have unique text — both kept even with same bounds
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].text, "First")
        XCTAssertEqual(result[1].text, "Second")
    }

    func testDedup_mixedUniqueAndNonUnique() {
        let bounds = ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        let unique = UIElementInfo(resourceId: "my_id", className: "UIView", bounds: bounds)
        let dup1 = UIElementInfo(className: "UIView", bounds: bounds)
        let dup2 = UIElementInfo(className: "UIView", bounds: bounds)

        let result = ElementLocator.deduplicateSiblings([unique, dup1, dup2])

        // unique always kept, dup1 kept (first occurrence), dup2 deduped
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].resourceId, "my_id")
        XCTAssertNil(result[1].resourceId)
    }

    func testDedup_noBounds_sameClassName() {
        let a = UIElementInfo(className: "UIView")
        let b = UIElementInfo(className: "UIView")

        let result = ElementLocator.deduplicateSiblings([a, b])

        // Same className, no bounds → deduped via "UIView|nobounds" key
        XCTAssertEqual(result.count, 1)
    }

    func testDedup_noClassName_alwaysKept() {
        let a = UIElementInfo(bounds: ElementBounds(left: 0, top: 0, right: 100, bottom: 50))
        let b = UIElementInfo(bounds: ElementBounds(left: 0, top: 0, right: 100, bottom: 50))

        let result = ElementLocator.deduplicateSiblings([a, b])

        // No className — can't meaningfully dedup, both kept
        XCTAssertEqual(result.count, 2)
    }

    func testDedup_preservesElementsWithDistinctChildren() {
        let bounds = ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        let child1 = UIElementInfo(text: "Button A", className: "UIButton")
        let child2 = UIElementInfo(text: "Button B", className: "UIButton")
        // Two UIViews at same bounds, no unique props, but different children
        let a = UIElementInfo(className: "UIView", bounds: bounds, node: [child1])
        let b = UIElementInfo(className: "UIView", bounds: bounds, node: [child2])

        let result = ElementLocator.deduplicateSiblings([a, b])

        // Both kept — distinct subtrees must not be discarded
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].node?[0].text, "Button A")
        XCTAssertEqual(result[1].node?[0].text, "Button B")
    }

    func testDedup_emptyInput() {
        let result = ElementLocator.deduplicateSiblings([])
        XCTAssertEqual(result.count, 0)
    }

    // MARK: - Collapse edge cases

    func testCollapse_preserves_childWithHintText() {
        let inner = UIElementInfo(
            className: "UITextField",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44),
            hintText: "Enter email"
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [inner]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].hintText, "Enter email")
    }

    func testCollapse_preserves_childWithContentDesc() {
        let inner = UIElementInfo(
            contentDesc: "Email input",
            className: "UITextField",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [inner]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].contentDesc, "Email input")
    }

    func testCollapse_mixOfCollapsibleAndNonCollapsible() {
        let bounds = ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        // Collapsible: same type, no unique props, has grandchild
        let grandchild = UIElementInfo(text: "Icon", className: "UIImageView")
        let collapsible = UIElementInfo(className: "UITextField", bounds: bounds, node: [grandchild])
        // Not collapsible: has resourceId
        let withId = UIElementInfo(resourceId: "inner_field", className: "UITextField", bounds: bounds)
        // Not collapsible: different type
        let label = UIElementInfo(text: "Label", className: "UILabel", bounds: bounds)

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [collapsible, withId, label]
        )

        // collapsible → grandchild promoted; withId kept; label kept
        XCTAssertEqual(result.count, 3)
        XCTAssertEqual(result[0].text, "Icon")
        XCTAssertEqual(result[0].className, "UIImageView")
        XCTAssertEqual(result[1].resourceId, "inner_field")
        XCTAssertEqual(result[2].text, "Label")
    }

    func testCollapse_nilParentClassName_noOp() {
        let child = UIElementInfo(className: "UITextField")
        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: nil,
            children: [child]
        )
        XCTAssertEqual(result.count, 1)
    }

    func testCollapse_preserves_childWithFocusedState() {
        let focusedInner = UIElementInfo(
            className: "UITextField",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44),
            focused: "true"
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [focusedInner]
        )

        // Focused child is preserved even though it has no text/id/desc
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].focused, "true")
    }

    func testCollapse_preserves_childWithPasswordState() {
        let passwordInner = UIElementInfo(
            className: "UITextField",
            bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44),
            password: "true"
        )

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [passwordInner]
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].password, "true")
    }

    func testCollapse_searchFieldContainsTextField_notCollapsed() {
        // searchField (UISearchBar) containing a textField — different className, kept
        let inner = UIElementInfo(className: "UITextField", bounds: ElementBounds(left: 0, top: 0, right: 300, bottom: 44))

        let result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UISearchBar",
            children: [inner]
        )

        // UITextField != UISearchBar → not collapsed
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].className, "UITextField")
    }

    // MARK: - Dedup edge cases

    func testDedup_focusedElementPreservedNotDeduped() {
        let bounds = ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        let a = UIElementInfo(className: "UIView", bounds: bounds, focused: "true")
        let b = UIElementInfo(className: "UIView", bounds: bounds)

        let result = ElementLocator.deduplicateSiblings([a, b])

        // Focused element has state — always preserved, not deduped
        // b has no state and no unique props — deduped against other stateless elements
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].focused, "true")
    }

    func testDedup_passwordElementPreservedNotDeduped() {
        let bounds = ElementBounds(left: 0, top: 0, right: 300, bottom: 44)
        let a = UIElementInfo(className: "UISecureTextField", bounds: bounds, password: "true")
        let b = UIElementInfo(className: "UISecureTextField", bounds: bounds)

        let result = ElementLocator.deduplicateSiblings([a, b])

        // Password element has state — preserved
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].password, "true")
    }

    func testDedup_singleElement_noop() {
        let element = UIElementInfo(className: "UIView", bounds: ElementBounds(left: 0, top: 0, right: 100, bottom: 50))
        let result = ElementLocator.deduplicateSiblings([element])
        XCTAssertEqual(result.count, 1)
    }

    func testDedup_multipleGroupsDedupIndependently() {
        let bounds1 = ElementBounds(left: 0, top: 0, right: 100, bottom: 50)
        let bounds2 = ElementBounds(left: 0, top: 50, right: 100, bottom: 100)

        let a1 = UIElementInfo(className: "UIView", bounds: bounds1)
        let a2 = UIElementInfo(className: "UIView", bounds: bounds1)
        let b1 = UIElementInfo(className: "UIView", bounds: bounds2)
        let b2 = UIElementInfo(className: "UIView", bounds: bounds2)

        let result = ElementLocator.deduplicateSiblings([a1, a2, b1, b2])

        // Two distinct groups, each deduped to 1
        XCTAssertEqual(result.count, 2)
    }

    // MARK: - textInputClassNames coverage

    func testTextInputClassNames_containsExpectedTypes() {
        let expected: Set<String> = ["UITextField", "UISecureTextField", "UITextView", "UISearchBar"]
        XCTAssertEqual(ElementLocator.textInputClassNames, expected)
    }

    // MARK: - Integration: collapse + dedup together

    func testCollapseAndDedup_secureTextFieldWithInternalSubviews() {
        let bounds = ElementBounds(left: 16, top: 200, right: 359, bottom: 244)
        let innerSecure = UIElementInfo(className: "UISecureTextField", bounds: bounds)
        let bg = UIElementInfo(className: "UIView", bounds: bounds)

        var result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UISecureTextField",
            children: [innerSecure, bg]
        )

        // innerSecure collapsed (empty), bg kept
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].className, "UIView")

        result = ElementLocator.deduplicateSiblings(result)
        XCTAssertEqual(result.count, 1)
    }

    func testCollapseAndDedup_textFieldWithDuplicateInternalSubviews() {
        // Simulates a real UITextField hierarchy:
        // UITextField (parent)
        //   ├── UITextField (internal, no props, same bounds) — collapsed
        //   ├── UITextField (internal, no props, same bounds) — collapsed
        //   ├── UIView (background, same bounds) — deduped after first
        //   ├── UIView (background, same bounds) — deduped
        //   └── UILabel (placeholder text)
        let bounds = ElementBounds(left: 16, top: 100, right: 359, bottom: 144)
        let innerTF1 = UIElementInfo(className: "UITextField", bounds: bounds)
        let innerTF2 = UIElementInfo(className: "UITextField", bounds: bounds)
        let bg1 = UIElementInfo(className: "UIView", bounds: bounds)
        let bg2 = UIElementInfo(className: "UIView", bounds: bounds)
        let placeholder = UIElementInfo(text: "Enter name", className: "UILabel", bounds: bounds)

        // Step 1: collapse same-type text input children
        var result = ElementLocator.collapseSameTypeTextInputChildren(
            parentClassName: "UITextField",
            children: [innerTF1, innerTF2, bg1, bg2, placeholder]
        )

        // Both UITextField children collapsed (empty → discarded)
        // bg1, bg2, placeholder remain
        XCTAssertEqual(result.count, 3)

        // Step 2: dedup remaining siblings
        result = ElementLocator.deduplicateSiblings(result)

        // bg1 and bg2 are identical UIView at same bounds → deduped to 1
        // placeholder has text → kept
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].className, "UIView")
        XCTAssertEqual(result[1].text, "Enter name")
    }

    // MARK: - resolveScreenDimensions (issue #2683)

    func testResolveScreenDimensions_prefersRootBoundsOverStaleFallback() {
        // The runner can report a legacy 320x480 compatibility size; the
        // foreground app's root frame carries the true device size and wins.
        let root = ElementBounds(left: 0, top: 0, right: 402, bottom: 874)
        let resolved = ElementLocator.resolveScreenDimensions(
            rootBounds: root,
            fallbackWidth: 320,
            fallbackHeight: 480
        )
        XCTAssertEqual(resolved.width, 402)
        XCTAssertEqual(resolved.height, 874)
    }

    func testResolveScreenDimensions_usesRootBoundsWithNonZeroOrigin() {
        let root = ElementBounds(left: 10, top: 20, right: 410, bottom: 820)
        let resolved = ElementLocator.resolveScreenDimensions(
            rootBounds: root,
            fallbackWidth: 320,
            fallbackHeight: 480
        )
        XCTAssertEqual(resolved.width, 400)
        XCTAssertEqual(resolved.height, 800)
    }

    func testResolveScreenDimensions_fallsBackWhenRootBoundsMissing() {
        let resolved = ElementLocator.resolveScreenDimensions(
            rootBounds: nil,
            fallbackWidth: 402,
            fallbackHeight: 874
        )
        XCTAssertEqual(resolved.width, 402)
        XCTAssertEqual(resolved.height, 874)
    }

    func testResolveScreenDimensions_fallsBackWhenRootBoundsDegenerate() {
        let zero = ElementBounds(left: 0, top: 0, right: 0, bottom: 0)
        let resolved = ElementLocator.resolveScreenDimensions(
            rootBounds: zero,
            fallbackWidth: 402,
            fallbackHeight: 874
        )
        XCTAssertEqual(resolved.width, 402)
        XCTAssertEqual(resolved.height, 874)
    }

    // MARK: - Typed text input fallback (#4644)

    func testMergeMissingTextInputCandidates_appendsIdentifierlessTextViewWithNativeFields() {
        let root = UIElementInfo(
            className: "XCUIApplication",
            bounds: ElementBounds(left: 0, top: 0, right: 393, bottom: 852),
            node: [
                UIElementInfo(
                    resourceId: "standard-field",
                    className: "UITextField",
                    bounds: ElementBounds(left: 20, top: 100, right: 373, bottom: 144),
                    clickable: "true",
                    role: "textfield"
                ),
            ]
        )
        let missingTextView = UIElementInfo(
            text: "Message #sample",
            value: "draft",
            className: "UITextView",
            bounds: ElementBounds(left: 20, top: 180, right: 373, bottom: 260),
            clickable: "true",
            focused: "true",
            role: "textfield",
            hintText: "Write a message",
            viewId: "generated-view-id",
            actions: ["set_text", "clear_text"]
        )

        let result = ElementLocator.mergeMissingTextInputCandidates(
            into: root,
            candidates: [missingTextView]
        )

        let appended = result.node?.last
        XCTAssertEqual(result.node?.count, 2)
        XCTAssertEqual(appended?.resourceId, nil)
        XCTAssertEqual(appended?.className, "UITextView")
        XCTAssertEqual(appended?.bounds?.left, 20)
        XCTAssertEqual(appended?.bounds?.top, 180)
        XCTAssertEqual(appended?.bounds?.right, 373)
        XCTAssertEqual(appended?.bounds?.bottom, 260)
        XCTAssertEqual(appended?.clickable, "true")
        XCTAssertEqual(appended?.focused, "true")
        XCTAssertEqual(appended?.role, "textfield")
        XCTAssertEqual(appended?.hintText, "Write a message")
        XCTAssertEqual(appended?.value, "draft")
        XCTAssertEqual(appended?.actions, ["set_text", "clear_text"])
    }

    func testMergeMissingTextInputCandidates_doesNotDuplicateExistingStandardTextField() {
        let standardField = UIElementInfo(
            resourceId: "standard-field",
            className: "UITextField",
            bounds: ElementBounds(left: 20, top: 100, right: 373, bottom: 144),
            clickable: "true",
            role: "textfield"
        )
        let root = UIElementInfo(
            className: "XCUIApplication",
            bounds: ElementBounds(left: 0, top: 0, right: 393, bottom: 852),
            node: [standardField]
        )

        let result = ElementLocator.mergeMissingTextInputCandidates(
            into: root,
            candidates: [standardField]
        )

        XCTAssertEqual(result.node?.count, 1)
        XCTAssertEqual(result.node?.first?.resourceId, "standard-field")
    }

    func testMergeMissingTextInputCandidates_preservesMaskedSecureValue() {
        let maskedValue = String(repeating: "\u{2022}", count: 6)
        let secureField = UIElementInfo(
            text: "Password",
            value: maskedValue,
            resourceId: "password-field",
            className: "UISecureTextField",
            bounds: ElementBounds(left: 20, top: 280, right: 373, bottom: 324),
            clickable: "true",
            password: "true",
            role: "textfield",
            actions: ["set_text", "clear_text"]
        )
        let root = UIElementInfo(
            className: "XCUIApplication",
            bounds: ElementBounds(left: 0, top: 0, right: 393, bottom: 852)
        )

        let result = ElementLocator.mergeMissingTextInputCandidates(
            into: root,
            candidates: [secureField]
        )

        let appended = result.node?.first
        XCTAssertEqual(appended?.value, maskedValue)
        XCTAssertNotEqual(appended?.value, "secret")
        XCTAssertEqual(appended?.password, "true")
    }

    // MARK: - ForegroundTracker (#3614)

    func testForegroundTrackerSetAndSwitch() {
        var tracker = ForegroundTracker()
        XCTAssertNil(tracker.bundleId)
        XCTAssertFalse(tracker.didFallbackToSpringboard)

        tracker.setApplication(nil, bundleId: "com.example.app", observe: true)
        XCTAssertEqual(tracker.bundleId, "com.example.app")
        XCTAssertTrue(tracker.observedBundleIds.contains("com.example.app"))

        tracker.didFallbackToSpringboard = true
        XCTAssertTrue(tracker.didFallbackToSpringboard)

        // switchForeground returns the previous bundle id and resets the fallback flag.
        let previous = tracker.switchForeground(
            app: nil, bundleId: "com.example.other", observe: true, now: 123
        )
        XCTAssertEqual(previous, "com.example.app")
        XCTAssertEqual(tracker.bundleId, "com.example.other")
        XCTAssertEqual(tracker.lastSwitchTime, 123)
        XCTAssertFalse(tracker.didFallbackToSpringboard)
        XCTAssertEqual(tracker.observedBundleIds, ["com.example.app", "com.example.other"])
    }

    // MARK: - Scale reporting pixel dimensions (#4548)

    func testComputePixelDimensionsGoldenVectors() {
        // Inline copy of the scaleReporting section of
        // test/fixtures/coordinate-mapping-golden-vectors.json. The parity suite
        // (test/parity/coordinateMappingGoldenVectorParity.test.ts) parses this literal out
        // of the source text and verifies it against the canonical JSON, so a one-sided edit
        // of either side fails there. Keep the table purely numeric (no string literals).
        //
        // Rows: pointWidth, pointHeight, nativeScale, expectedPixelWidth, expectedPixelHeight.
        // Row 2 is the Display Zoom case: nativeScale 3.144 while UIScreen.scale stays 3.0 —
        // using scale would report 2436 instead of the screenshot's true 2553 pixels.
        // Row 3 is the iPhone Plus downsampling case: scale 3.0 but nativeScale 2.608696.
        // Row 5 pins the Float-vs-Double precision boundary at 2.61. Row 6 pins the .5
        // rounding tie (round half away from zero == JS Math.round here, all values positive).
        // Row 7 is the Android identity contract (nativeScale 1).
        let scaleReportingVectors: [[Double]] = [
            [393, 852, 3.0, 1179, 2556],
            [375, 812, 3.144, 1179, 2553],
            [414, 736, 2.608696, 1080, 1920],
            [320, 568, 2.0, 640, 1136],
            [450, 750, 2.61, 1175, 1958],
            [375, 811, 3.5, 1313, 2839],
            [1080, 2340, 1.0, 1080, 2340],
        ]

        for (index, row) in scaleReportingVectors.enumerated() {
            let result = ElementLocator.computePixelDimensions(
                pointWidth: Int(row[0]),
                pointHeight: Int(row[1]),
                nativeScale: row[2]
            )
            XCTAssertNotNil(result, "row \(index) unexpectedly degenerate")
            XCTAssertEqual(result?.pixelWidth, Int(row[3]), "row \(index) pixelWidth")
            XCTAssertEqual(result?.pixelHeight, Int(row[4]), "row \(index) pixelHeight")
        }
    }

    func testComputePixelDimensionsRejectsDegenerateInputs() {
        XCTAssertNil(ElementLocator.computePixelDimensions(pointWidth: 0, pointHeight: 812, nativeScale: 3.0))
        XCTAssertNil(ElementLocator.computePixelDimensions(pointWidth: 375, pointHeight: 0, nativeScale: 3.0))
        XCTAssertNil(ElementLocator.computePixelDimensions(pointWidth: 375, pointHeight: 812, nativeScale: 0))
        XCTAssertNil(ElementLocator.computePixelDimensions(pointWidth: 375, pointHeight: 812, nativeScale: -2.0))
        XCTAssertNil(ElementLocator.computePixelDimensions(pointWidth: -1, pointHeight: 812, nativeScale: 3.0))
        XCTAssertNil(
            ElementLocator.computePixelDimensions(pointWidth: 375, pointHeight: 812, nativeScale: .infinity)
        )
        XCTAssertNil(ElementLocator.computePixelDimensions(pointWidth: 375, pointHeight: 812, nativeScale: .nan))
    }

    // MARK: - Per-extraction device-load reduction (#5474)

    // AC1: the live keyboard-focus requery is skipped on the no-text-field path.
    func testShouldQueryKeyboardFocus_skipsWhenNoTextInputPresent() {
        XCTAssertFalse(ElementLocator.shouldQueryKeyboardFocus(textInputSnapshotCount: 0))
    }

    func testShouldQueryKeyboardFocus_runsWhenTextInputPresent() {
        XCTAssertTrue(ElementLocator.shouldQueryKeyboardFocus(textInputSnapshotCount: 1))
        XCTAssertTrue(ElementLocator.shouldQueryKeyboardFocus(textInputSnapshotCount: 5))
    }

    // AC2: the second SpringBoard full snapshot is gated behind a cheap precondition.
    func testShouldSnapshotSpringboardForAlerts_skipsWhenForegroundIsSpringboard() {
        // SpringBoard's tree is already the app snapshot — never take a second one,
        // regardless of whether it shows an alert.
        XCTAssertFalse(
            ElementLocator.shouldSnapshotSpringboardForAlerts(foregroundIsSpringboard: true, appHasAlert: false)
        )
        XCTAssertFalse(
            ElementLocator.shouldSnapshotSpringboardForAlerts(foregroundIsSpringboard: true, appHasAlert: true)
        )
    }

    func testShouldSnapshotSpringboardForAlerts_runsOnlyWhenAppShowsAlert() {
        // Common per-extraction case: real app, no alert in its tree → skip the
        // second serialization.
        XCTAssertFalse(
            ElementLocator.shouldSnapshotSpringboardForAlerts(foregroundIsSpringboard: false, appHasAlert: false)
        )
        // Real app whose own snapshot already shows an alert → a co-presented
        // system dialog may exist in SpringBoard's tree, so pay for the snapshot.
        XCTAssertTrue(
            ElementLocator.shouldSnapshotSpringboardForAlerts(foregroundIsSpringboard: false, appHasAlert: true)
        )
    }

    // AC3: the ~40-app foreground-detection sweep is bounded on the miss path.
    func testShouldRunSystemAppSweep_runsWhenNeverSwept() {
        // lastMissTime == 0 means the sweep has never cached a miss (or a
        // foreground switch invalidated it) — always run.
        XCTAssertTrue(
            ElementLocator.shouldRunSystemAppSweep(now: 5_000_000_000, lastMissTime: 0, ttlNanos: 1_000_000_000)
        )
    }

    func testShouldRunSystemAppSweep_skipsWithinTtlOfRecentMiss() {
        // A miss 100ms ago with a 1s TTL → skip the ~40-IPC fan-out.
        let ttl: UInt64 = 1_000_000_000
        let lastMiss: UInt64 = 5_000_000_000
        let now = lastMiss + 100_000_000
        XCTAssertFalse(
            ElementLocator.shouldRunSystemAppSweep(now: now, lastMissTime: lastMiss, ttlNanos: ttl)
        )
    }

    func testShouldRunSystemAppSweep_runsAfterTtlElapsed() {
        let ttl: UInt64 = 1_000_000_000
        let lastMiss: UInt64 = 5_000_000_000
        XCTAssertTrue(
            ElementLocator.shouldRunSystemAppSweep(now: lastMiss + ttl, lastMissTime: lastMiss, ttlNanos: ttl)
        )
        XCTAssertTrue(
            ElementLocator.shouldRunSystemAppSweep(now: lastMiss + ttl + 1, lastMissTime: lastMiss, ttlNanos: ttl)
        )
    }

    func testShouldRunSystemAppSweep_runsWhenClockAppearsToGoBackwards() {
        // Never wedge on a bad/backwards sample — run the sweep.
        XCTAssertTrue(
            ElementLocator.shouldRunSystemAppSweep(now: 10, lastMissTime: 5_000_000_000, ttlNanos: 1_000_000_000)
        )
    }

    // AC3: a foreground switch invalidates the cached negative sweep result so the
    // miss path does not stay wedged after the foreground app changes.
    func testForegroundTracker_systemAppSweepMissResetOnSwitch() {
        var tracker = ForegroundTracker()
        XCTAssertEqual(tracker.lastSystemAppSweepMiss, 0)

        tracker.lastSystemAppSweepMiss = 42
        XCTAssertEqual(tracker.lastSystemAppSweepMiss, 42)

        // An explicit foreground switch clears the negative cache.
        _ = tracker.switchForeground(app: nil, bundleId: "com.example.app", observe: true, now: 999)
        XCTAssertEqual(tracker.lastSystemAppSweepMiss, 0)
    }
}
