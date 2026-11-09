@testable import CtrlProxy
import Foundation
import XCTest

@MainActor
final class SplitViewBackGestureTests: XCTestCase {
    private typealias Element = SplitViewBackGesture.ElementSnapshot
    private let size = GestureSize(width: 951, height: 669)
    private let buttonFrame = CGRect(x: 884, y: 125, width: 38, height: 38)

    /// Flattened Settings > General > Screen Capture capture. Variants change only the geometry,
    /// kind, or presence of captured nodes; no extra identifiers or labels are invented.
    private func capturedTree(
        root: Bool = false, sidebar: Bool = true, sidebarKind: SplitViewBackGesture.ElementKind = .collectionLike,
        sidebarFrame: CGRect = CGRect(x: 0, y: 0, width: 320, height: 669), detailBar: Bool = true,
        backFrame: CGRect? = CGRect(x: 884, y: 125, width: 38, height: 38)
    )
        -> [Element]
    {
        let panel = CGRect(x: 0, y: 0, width: 951, height: 669)
        var elements: [Element] = [
            .init(kind: .other, label: "Settings", identifier: "", frame: panel),
            .init(
                kind: .navigationBar,
                label: "",
                identifier: "Settings",
                frame: CGRect(x: 0, y: 24, width: 320, height: 58)
            ),
        ]
        if sidebar {
            elements.append(.init(
                kind: sidebarKind,
                label: "Sidebar",
                identifier: "com.apple.settings.sidebar.collectionView",
                frame: sidebarFrame
            ))
        }
        elements.append(.init(
            kind: .toolbar,
            label: "Toolbar",
            identifier: "Toolbar",
            frame: CGRect(x: 0, y: 0, width: 320, height: 669)
        ))
        if detailBar {
            elements.append(.init(
                kind: .navigationBar,
                label: "",
                identifier: root ? "General" : "Screen Capture",
                frame: CGRect(x: 0, y: 24, width: 951, height: 58)
            ))
            if !root {
                elements.append(.init(
                    kind: .other,
                    label: "Screen Capture",
                    identifier: "",
                    frame: CGRect(x: 340, y: 37, width: 124, height: 21)
                ))
            }
        }
        elements.append(.init(kind: .collectionLike, label: "", identifier: "", frame: panel))
        for _ in 0 ..< 2 {
            elements.append(.init(kind: .toolbar, label: "Toolbar", identifier: "", frame: panel))
        }
        if !root, let backFrame {
            elements.append(.init(kind: .button, label: "", identifier: "BackButton", frame: backFrame))
        }
        elements.append(.init(
            kind: .other,
            label: "Search",
            identifier: "",
            frame: CGRect(x: 20, y: 607, width: 280, height: 28)
        ))
        return elements
    }

    private func provider(rotation: Int) -> FakeDisplayGestureProvider {
        let provider = FakeDisplayGestureProvider(geometry: GestureCoordinateGeometry(
            app: rotation == 0 ? size : GestureSize(width: 669, height: 951),
            screen: GestureSize(width: 466, height: 678), observation: size, rotation: rotation
        ))
        provider.inventory = GestureDisplayInventory(
            screens: [.init(displayId: 1, isMain: true), .init(displayId: 2, isMain: false)],
            applicationDisplayId: nil, isPhoneIdiom: true
        )
        return provider
    }

    func testCapturedBackButtonCentreAndDisplayMappings() throws {
        let decision = SplitViewBackGesture.decision(capturedTree(), size: size)
        XCTAssertEqual(decision, .tapBackButton(GesturePoint(x: 903, y: 144)))
        for (rotation, expected) in [
            (1, GesturePoint(x: 144, y: 48)),
            (3, GesturePoint(x: 525, y: 903)),
            (0, GesturePoint(x: 903, y: 144)),
        ] {
            let provider = provider(rotation: rotation)
            let factory = try DisplayGestureFactory(provider: provider)
            XCTAssertTrue(try SplitViewBackGesture.perform(decision) { point in
                let delivery = try factory.deliver(start: point, press: 0.05)
                XCTAssertEqual(delivery.selection.strategy, .displayTargeted)
            })
            XCTAssertEqual(provider.touches.count, 1)
            let touch = try XCTUnwrap(provider.touches.first)
            XCTAssertEqual(touch.start, expected)
            XCTAssertEqual(touch.end, expected)
            XCTAssertEqual(touch.pressDuration, 0.05)
            XCTAssertEqual(touch.moveDuration, 0)
            XCTAssertEqual(touch.holdDuration, 0)
            XCTAssertEqual(touch.displayId, 2)
            XCTAssertEqual(touch.interfaceOrientation, 1)
            XCTAssertTrue(provider.actions.isEmpty)
        }
    }

    func testAnotherPanelUsesItsObservedButtonFrame() {
        let otherSize = GestureSize(width: 678, height: 466)
        let elements = capturedTree().map { element in
            Element(
                kind: element.kind,
                label: element.label,
                identifier: element.identifier,
                frame: CGRect(
                    x: element.frame.minX * 678 / 951,
                    y: element.frame.minY * 466 / 669,
                    width: element.frame.width * 678 / 951,
                    height: element.frame.height * 466 / 669
                )
            )
        }
        guard case let .tapBackButton(point) = SplitViewBackGesture.decision(elements, size: otherSize) else {
            return XCTFail("Expected the scaled captured button")
        }
        XCTAssertEqual(point.x, 903 * 678 / 951.0, accuracy: 1e-9)
        XCTAssertEqual(point.y, 144 * 466 / 669.0, accuracy: 1e-9)
    }

    func testRootHasNothingToGoBackAndSendsNoTouches() throws {
        let decision = SplitViewBackGesture.decision(capturedTree(root: true), size: size)
        XCTAssertEqual(decision, .nothingToGoBack)
        let provider = provider(rotation: 1)
        let factory = try DisplayGestureFactory(provider: provider)
        XCTAssertThrowsError(try SplitViewBackGesture.perform(decision) { point in
            _ = try factory.deliver(start: point, press: 0.05)
        }) { error in
            guard case GesturePerformer.GestureError.nothingToGoBack = error else {
                return XCTFail("Expected nothingToGoBack, got \(error)")
            }
        }
        XCTAssertTrue(provider.touches.isEmpty)
        XCTAssertTrue(provider.actions.isEmpty)
    }

    func testSingleColumnBackButtonKeepsExistingRoute() throws {
        let decision = SplitViewBackGesture.decision(capturedTree(sidebar: false), size: size)
        XCTAssertEqual(decision, .notSplitView)
        XCTAssertFalse(try SplitViewBackGesture.perform(decision) { _ in
            XCTFail("Must retain the existing back route")
        })
    }

    func testRejectsSidebarLabelWithoutSplitViewStructure() {
        let invalidTrees = [
            capturedTree(sidebarKind: .other),
            capturedTree(sidebarFrame: CGRect(x: 0, y: 0, width: 40, height: 669)),
            capturedTree(sidebarFrame: CGRect(x: 0, y: 0, width: 320, height: 500)),
            capturedTree(sidebarFrame: CGRect(x: 3, y: 0, width: 320, height: 669)),
            capturedTree(sidebarFrame: CGRect(x: 0, y: 0, width: 475.5, height: 669)),
            capturedTree(detailBar: false),
            capturedTree().filter { $0.kind != .navigationBar || $0.identifier != "Settings" },
        ]
        for elements in invalidTrees {
            XCTAssertEqual(SplitViewBackGesture.decision(elements, size: size), .notSplitView)
        }
        let sameTitle = capturedTree().map { element in
            Element(
                kind: element.kind,
                label: element.label,
                identifier: element.kind == .navigationBar ? "Settings" : element.identifier,
                frame: element.frame
            )
        }
        XCTAssertEqual(SplitViewBackGesture.decision(sameTitle, size: size), .notSplitView)
    }

    func testAcceptsLeftEdgeAndHeightTolerance() {
        let elements = capturedTree(sidebarFrame: CGRect(x: 2, y: 0, width: 320, height: 669 * 0.9))
        XCTAssertEqual(SplitViewBackGesture.decision(elements, size: size), .tapBackButton(.init(x: 903, y: 144)))
    }

    func testRejectsBackButtonInsideSidebarEmptyOrOffPanel() {
        for frame in [
            CGRect(x: 100, y: 125, width: 38, height: 38),
            CGRect(x: 300, y: 125, width: 38, height: 38),
            CGRect(x: 940, y: 125, width: 38, height: 38),
            CGRect(x: -1, y: 125, width: 38, height: 38),
            CGRect(x: 884, y: 650, width: 38, height: 38),
            CGRect(x: 884, y: 125, width: 0, height: 38),
        ] {
            XCTAssertEqual(SplitViewBackGesture.decision(capturedTree(backFrame: frame), size: size), .nothingToGoBack)
        }
        XCTAssertEqual(SplitViewBackGesture.decision(capturedTree(backFrame: nil), size: size), .nothingToGoBack)
        let wrongKind = capturedTree().map { element in
            Element(
                kind: element.identifier == "BackButton" ? .other : element.kind,
                label: element.label,
                identifier: element.identifier,
                frame: element.frame
            )
        }
        XCTAssertEqual(SplitViewBackGesture.decision(wrongKind, size: size), .nothingToGoBack)
    }

    func testScreenSignatureDetectsNavigationTitleChange() throws {
        let elements = capturedTree()
        let before = SplitViewBackGesture.screenSignature(elements, size: size)
        // Only change the captured navigation title, retaining every other element.
        let after = SplitViewBackGesture.screenSignature(elements.map { element in
            Element(
                kind: element.kind,
                label: element.label,
                identifier: element.identifier == "Screen Capture" ? "General" : element.identifier,
                frame: element.frame
            )
        }, size: size)
        XCTAssertEqual(before.detailNavigationIdentifier, "Screen Capture")
        XCTAssertEqual(after.detailNavigationIdentifier, "General")
        XCTAssertTrue(SplitViewBackGesture.didChange(before: before, after: after))
        XCTAssertNoThrow(try SplitViewBackGesture.requireChange(before: before, after: after))
    }

    func testSignatureIsAMultisetAndIgnoresToolbarChanges() {
        let elements = capturedTree()
        let before = SplitViewBackGesture.screenSignature(elements, size: size)
        let reordered = SplitViewBackGesture.screenSignature(Array(elements.reversed()), size: size)
        XCTAssertFalse(SplitViewBackGesture.didChange(before: before, after: reordered))
        let withoutToolbars = SplitViewBackGesture.screenSignature(elements.filter { $0.kind != .toolbar }, size: size)
        XCTAssertFalse(SplitViewBackGesture.didChange(before: before, after: withoutToolbars))
        let duplicate = SplitViewBackGesture.screenSignature(elements + [elements[0]], size: size)
        XCTAssertTrue(SplitViewBackGesture.didChange(before: before, after: duplicate))
        let moved = SplitViewBackGesture.screenSignature(
            capturedTree(backFrame: buttonFrame.offsetBy(dx: 1, dy: 0)),
            size: size
        )
        XCTAssertTrue(SplitViewBackGesture.didChange(before: before, after: moved))
        let root = SplitViewBackGesture.screenSignature(capturedTree(root: true), size: size)
        XCTAssertTrue(SplitViewBackGesture.didChange(before: before, after: root))
    }

    func testIdenticalSignatureMapsToBackNoEffect() {
        let before = SplitViewBackGesture.screenSignature(capturedTree(), size: size)
        let after = SplitViewBackGesture.screenSignature(capturedTree(), size: size)
        XCTAssertFalse(SplitViewBackGesture.didChange(before: before, after: after))
        XCTAssertThrowsError(try SplitViewBackGesture.requireChange(before: before, after: after)) { error in
            guard case GesturePerformer.GestureError.backNoEffect = error else {
                return XCTFail("Expected backNoEffect, got \(error)")
            }
        }
    }

    func testBackErrorDescriptionsAndWireCodes() {
        let root = GesturePerformer.GestureError
            .nothingToGoBack("already at the root of the detail pane; nothing to go back to")
        XCTAssertEqual(
            root.errorDescription,
            "back was not sent: already at the root of the detail pane; nothing to go back to; select another item in the sidebar to navigate"
        )
        let unchanged = GesturePerformer.GestureError
            .backNoEffect("the detail pane did not visibly change after tapping BackButton")
        XCTAssertEqual(
            unchanged.errorDescription,
            "back had no verified effect: the detail pane did not visibly change after tapping BackButton; observe the screen and choose a navigation control before retrying"
        )
        XCTAssertNil(root.wireCode)
        XCTAssertNil(unchanged.wireCode)
    }
}
