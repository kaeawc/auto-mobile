@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeBarScrollTests: XCTestCase {
    func testBottomNavigationRoutesFullInsetsInsideFillAndNoneToStyledWrapper() {
        let insets = PrototypeSafeInsets(top: 10, left: 12, bottom: 34, right: 16)
        let layout = PrototypeNodeSafeInsets(nodeType: "bottomNav", safeInsets: insets)
        XCTAssertEqual(layout.navInsets, insets)
        XCTAssertEqual(layout.styledInsets, PrototypeSafeInsets())
        for showsLabel in [true, false] {
            let sizing = layout.navigationSizing(showsLabel: showsLabel)
            XCTAssertEqual(sizing.itemMinHeight, showsLabel ? 64 : 56)
            XCTAssertEqual(sizing.topPadding, showsLabel ? 22 : 10)
            XCTAssertEqual(sizing.bottomPadding, showsLabel ? 38 : 34)
            XCTAssertEqual(sizing.containerMinHeight, showsLabel ? 124 : 100)
            XCTAssertEqual(
                sizing.containerMinHeight + layout.styledInsets.top + layout.styledInsets.bottom,
                showsLabel ? 124 : 100
            )
        }
    }

    func testOtherNodesKeepSafeInsetsInStyledWrapper() {
        let insets = PrototypeSafeInsets(top: 10, left: 12, bottom: 34, right: 16)
        for nodeType in ["tabBar", "topAppBar", "row", "column", "box", "text", "bottomSheet"] {
            let layout = PrototypeNodeSafeInsets(nodeType: nodeType, safeInsets: insets)
            XCTAssertEqual(layout.styledInsets, insets, nodeType)
            XCTAssertEqual(layout.navInsets, PrototypeSafeInsets(), nodeType)
        }
    }

    func testNavigationSizingIncludesBottomSafeAreaWithoutIncreasingItemHeight() {
        let insets = prototypeEffectiveSafeInsets(
            viewFrameInWindow: CGRect(x: 0, y: 147, width: 440, height: 809),
            windowBounds: CGRect(x: 0, y: 0, width: 440, height: 956),
            windowInsets: PrototypeSafeInsets(top: 62, bottom: 34),
            viewInsets: PrototypeSafeInsets()
        )
        XCTAssertEqual(insets, PrototypeSafeInsets(bottom: 34))
        for showsLabel in [true, false] {
            let base = PrototypeBarScroll.navigationSizing(showsLabel: showsLabel)
            let padded = PrototypeNodeSafeInsets(nodeType: "bottomNav", safeInsets: insets)
                .navigationSizing(showsLabel: showsLabel)
            XCTAssertEqual(padded.itemMinHeight, base.itemMinHeight)
            XCTAssertEqual(padded.topPadding, base.topPadding)
            XCTAssertEqual(padded.bottomPadding, base.bottomPadding + 34)
            XCTAssertEqual(padded.containerMinHeight, base.containerMinHeight + 34)
            XCTAssertEqual(
                padded.itemMinHeight + padded.topPadding + padded.bottomPadding,
                padded.containerMinHeight
            )
        }
    }

    func testNavigationDoesNotAddPaddingWhenHostEndsAboveHomeIndicator() {
        let insets = prototypeEffectiveSafeInsets(
            viewFrameInWindow: CGRect(x: 0, y: 147, width: 440, height: 775),
            windowBounds: CGRect(x: 0, y: 0, width: 440, height: 956),
            windowInsets: PrototypeSafeInsets(top: 62, bottom: 34),
            viewInsets: PrototypeSafeInsets()
        )
        XCTAssertEqual(insets, PrototypeSafeInsets())
        let layout = PrototypeNodeSafeInsets(nodeType: "bottomNav", safeInsets: insets)
        XCTAssertEqual(layout.navInsets, PrototypeSafeInsets())
        XCTAssertEqual(layout.styledInsets, PrototypeSafeInsets())
        let sizing = layout.navigationSizing(showsLabel: true)
        XCTAssertEqual(sizing.containerMinHeight, 80)
        XCTAssertEqual(sizing.bottomPadding, 4)
    }

    func testNavigationIncludesTopAndBottomInsetsExactlyOnce() {
        let sizing = PrototypeBarScroll.navigationSizing(
            showsLabel: true, safeInsets: PrototypeSafeInsets(top: 10, bottom: 34)
        )
        XCTAssertEqual(sizing.itemMinHeight, 64)
        XCTAssertEqual(sizing.topPadding, 22)
        XCTAssertEqual(sizing.bottomPadding, 38)
        XCTAssertEqual(sizing.containerMinHeight, 124)
    }

    func testNavigationSizingTracksLabelVisibility() {
        for fraction in [0.0, 0.01, 1.0] {
            let showsLabel = PrototypeBarScroll.showsNavigationLabel(behavior: "minimize", fraction: fraction)
            let sizing = PrototypeBarScroll.navigationSizing(showsLabel: showsLabel)
            XCTAssertEqual(sizing.itemMinHeight, fraction == 0 ? 64 : 56)
            XCTAssertEqual(sizing.containerMinHeight, fraction == 0 ? 80 : 56)
            XCTAssertEqual(sizing.topPadding, fraction == 0 ? 12 : 0)
            XCTAssertEqual(sizing.bottomPadding, fraction == 0 ? 4 : 0)
            XCTAssertEqual(sizing.itemMinHeight + sizing.topPadding + sizing.bottomPadding, sizing.containerMinHeight)
        }
    }

    func testMinimizedNavigationHidesLabelsAtAnyPositiveFraction() {
        XCTAssertTrue(PrototypeBarScroll.showsNavigationLabel(behavior: "minimize", fraction: 0))
        XCTAssertFalse(PrototypeBarScroll.showsNavigationLabel(behavior: "minimize", fraction: 0.01))
        XCTAssertFalse(PrototypeBarScroll.showsNavigationLabel(behavior: "minimize", fraction: 1))
        for behavior in [nil, "none", "pinned", "hide", "enterAlways", "exitUntilCollapsed"] {
            XCTAssertTrue(PrototypeBarScroll.showsNavigationLabel(behavior: behavior, fraction: 1))
        }
    }

    func testExitUntilCollapsedAndPinned() {
        var state = PrototypeBarScrollState()
        state.update(offset: 200)
        XCTAssertEqual(state.collapse("exitUntilCollapsed", extent: 88, reduced: false), 1)
        XCTAssertEqual(state.collapse("pinned", extent: 88, reduced: false), 0)
        state.update(offset: 44)
        XCTAssertEqual(state.collapse("exitUntilCollapsed", extent: 88, reduced: false), 0.5)
    }

    func testDirectionalHideAndEnterAlways() {
        var state = PrototypeBarScrollState()
        state.update(offset: 200)
        XCTAssertEqual(state.collapse("hide", extent: 64, reduced: false), 1)
        state.update(offset: 168)
        XCTAssertEqual(state.collapse("enterAlways", extent: 64, reduced: false), 0.5)
        state.update(offset: 120)
        XCTAssertEqual(state.collapse("hide", extent: 64, reduced: false), 0)
        state.update(offset: -20)
        XCTAssertEqual(state.offset, 0)
        XCTAssertEqual(state.collapse("none", extent: 64, reduced: false), 0)
    }

    func testLargeEnterAlwaysTracksItsFullHeight() {
        let extent = PrototypeBarScrollState.extent(variant: "large", behavior: "enterAlways")
        XCTAssertEqual(extent, 152)
        var state = PrototypeBarScrollState()
        state.update(offset: 200, extent: extent)
        state.update(offset: 124, extent: extent)
        XCTAssertEqual(state.collapse("enterAlways", extent: extent, reduced: false), 0.5)
    }

    func testReducedProfileSnapsAndMinimizeUsesDirectionalTravel() {
        var state = PrototypeBarScrollState()
        state.update(offset: 1)
        XCTAssertEqual(state.collapse("minimize", extent: 64, reduced: true), 1)
        XCTAssertEqual(state.collapse("exitUntilCollapsed", extent: 88, reduced: true), 1)
        state.update(offset: 200)
        state.update(offset: 199)
        XCTAssertEqual(state.collapse("hide", extent: 64, reduced: true), 0)
        state.update(offset: 0)
        XCTAssertEqual(state.collapse("hide", extent: 64, reduced: true), 0)
    }
}
