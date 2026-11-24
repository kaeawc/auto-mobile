@testable import CtrlProxy
import XCTest

/// #10858: a tap or swipe on a foreground app the runner did not pin is synthesized in screen
/// space instead of waiting on the rebound `XCUIApplication`.
final class GestureDeliveryRouteTests: XCTestCase {
    private let unpinned = GestureApplicationTarget.rebind(bundleId: "com.apple.Preferences")
    private let phone = GestureSize(width: 402, height: 874)

    private func geometry(
        app: GestureSize? = nil, screen: GestureSize? = nil, rotation: Int? = 0
    )
        -> GestureCoordinateGeometry
    {
        GestureCoordinateGeometry(
            app: app ?? phone, screen: screen ?? phone, observation: app ?? phone, rotation: rotation
        )
    }

    func testDoubleTapUsesTwoSynthesizedContactsWithAnInjectedGap() throws {
        var events: [String] = []
        let delivered = try UnpinnedGestureSynthesis.tap(doubleTap: true, deliver: {
            events.append("tap")
            return GestureDeliveryRoute.resolve(target: self.unpinned, forced: nil, geometry: self.geometry())
                == .synthesizedEventRecord(interfaceOrientation: 1)
        }, wait: { gap in
            XCTAssertEqual(gap, 0.05)
            events.append("gap")
        })
        XCTAssertTrue(delivered)
        XCTAssertEqual(events, ["tap", "gap", "tap"])
    }

    func testDoubleTapKeepsCoordinateRouteWhenSynthesisDoesNotApply() throws {
        var contacts = 0
        XCTAssertFalse(try UnpinnedGestureSynthesis.tap(doubleTap: true, deliver: {
            contacts += 1
            return GestureDeliveryRoute.resolve(target: .keepPinned, forced: nil, geometry: self.geometry())
                != .xcuiCoordinate
        }, wait: { _ in XCTFail("coordinate route must not wait") }))
        XCTAssertEqual(contacts, 1)
    }

    func testDoubleTapDoesNotFallbackAfterFirstSynthesizedContact() {
        var contacts = 0
        XCTAssertThrowsError(try UnpinnedGestureSynthesis.tap(doubleTap: true, deliver: {
            contacts += 1
            return contacts == 1
        }, wait: { _ in }))
        XCTAssertEqual(contacts, 2)
    }

    func testSynthesizesForUnpinnedFullScreenPortraitApp() {
        XCTAssertEqual(
            GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: geometry()),
            .synthesizedEventRecord(interfaceOrientation: 1)
        )
    }

    func testMapsObservedRotationToInterfaceOrientation() {
        let landscape = GestureSize(width: 874, height: 402)
        for (rotation, orientation) in [(1, 4), (2, 2), (3, 3)] {
            XCTAssertEqual(
                GestureDeliveryRoute.resolve(
                    target: unpinned, forced: nil,
                    geometry: geometry(app: rotation == 2 ? phone : landscape, rotation: rotation)
                ),
                .synthesizedEventRecord(interfaceOrientation: orientation),
                "rotation \(rotation)"
            )
        }
    }

    func testKeepsXCUICoordinateForPinnedApp() {
        XCTAssertEqual(
            GestureDeliveryRoute.resolve(target: .keepPinned, forced: nil, geometry: geometry()), .xcuiCoordinate
        )
    }

    func testKeepsXCUICoordinateWhenAStrategyIsForced() {
        for forced in [TapCoordinateStrategy.legacy, .appRelative, .displayTargetedObserved] {
            XCTAssertEqual(
                GestureDeliveryRoute.resolve(target: unpinned, forced: forced, geometry: geometry()),
                .xcuiCoordinate, "\(forced)"
            )
        }
    }

    func testKeepsXCUICoordinateWithoutAnObservationOfTheApp() {
        XCTAssertEqual(GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: nil), .xcuiCoordinate)
    }

    func testKeepsXCUICoordinateForMultiPanelOrInsetWindow() {
        let inset = geometry(app: GestureSize(width: 600, height: 700), screen: GestureSize(width: 1024, height: 1366))
        XCTAssertEqual(GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: inset), .xcuiCoordinate)
    }

    func testKeepsXCUICoordinateForInvalidSizesOrUnknownRotation() {
        let zero = GestureSize(width: 0, height: 0)
        for candidate in [geometry(app: zero), geometry(screen: zero), geometry(rotation: nil), geometry(rotation: 7)] {
            XCTAssertEqual(
                GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: candidate), .xcuiCoordinate
            )
        }
    }

    // MARK: - launchApp, then an external launch (#10858 original order)

    private let playground = "dev.jasonpearson.automobile.Playground"
    private let settings = "com.apple.Preferences"

    /// `launchApp` pins Playground; `simctl launch` brings Settings forward and observe moves the
    /// tracker. Every later gesture on Settings, not just the first, takes the synthesized route.
    func testExternallyLaunchedAppStaysUnpinnedAcrossGestures() {
        var pinned = GesturePinnedApplication()
        var tracker = ForegroundTracker()
        pinned.pin(playground)
        _ = tracker.switchForeground(app: nil, bundleId: playground, observe: true, now: 1)
        XCTAssertEqual(pinned.target(trackedBundleId: tracker.bundleId), .keepPinned)

        _ = tracker.switchForeground(app: nil, bundleId: settings, observe: true, now: 2)
        for gesture in ["tapOn General", "swipeOn up", "tapOn About"] {
            let target = pinned.target(trackedBundleId: tracker.bundleId)
            XCTAssertEqual(target, .rebind(bundleId: settings), gesture)
            XCTAssertEqual(
                GestureDeliveryRoute.decide(target: target, forced: nil, geometry: geometry()),
                .init(route: .synthesizedEventRecord(interfaceOrientation: 1), fallback: nil), gesture
            )
        }
        XCTAssertEqual(pinned.bundleId, playground, "resolving a gesture target must not re-pin")
    }

    /// Back on the pinned app the `XCUICoordinate` path returns; a new `launchApp` re-pins.
    func testPinnedAppKeepsXCUICoordinateAndRelaunchRepins() {
        var pinned = GesturePinnedApplication()
        pinned.pin(playground)
        XCTAssertEqual(
            GestureDeliveryRoute.decide(
                target: pinned.target(trackedBundleId: playground), forced: nil, geometry: geometry()
            ),
            .init(route: .xcuiCoordinate, fallback: .pinnedApp)
        )
        pinned.pin(settings)
        XCTAssertEqual(pinned.target(trackedBundleId: settings), .keepPinned)
        pinned.clear()
        XCTAssertEqual(pinned.target(trackedBundleId: settings), .rebind(bundleId: settings))
        XCTAssertEqual(pinned.target(trackedBundleId: nil), .keepPinned)
    }

    /// The startup app is injected with its bundle id (`CtrlProxy.start`): it is pinned, so its
    /// gestures resolve `.keepPinned`; an injection without one clears the pin (#10995).
    func testStartupAppWithBundleIdIsPinned() {
        var pinned = GesturePinnedApplication()
        pinned.inject(bundleId: playground)
        XCTAssertEqual(pinned.bundleId, playground)
        XCTAssertEqual(pinned.target(trackedBundleId: playground), .keepPinned)
        XCTAssertEqual(pinned.target(trackedBundleId: settings), .rebind(bundleId: settings))
        pinned.inject(bundleId: nil)
        XCTAssertNil(pinned.bundleId)
        XCTAssertEqual(pinned.target(trackedBundleId: settings), .rebind(bundleId: settings))
    }

    // MARK: - Inset iPadOS windows (#18960)

    private let iPad = GestureSize(width: 1032, height: 1376)
    private let floatingWindow = GestureSize(width: 640, height: 720)

    private func floating(translation: GesturePoint? = GesturePoint(x: 196, y: 320)) -> GestureCoordinateGeometry {
        GestureCoordinateGeometry(
            app: floatingWindow, screen: iPad, observation: iPad, rotation: 0, windowTranslation: translation
        )
    }

    func testPinnedAppInFloatingWindowSynthesizes() {
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: .keepPinned, forced: nil, geometry: floating()),
            .init(route: .synthesizedEventRecord(interfaceOrientation: 1), fallback: nil)
        )
    }

    func testUnpinnedAppInFloatingWindowSynthesizes() {
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: unpinned, forced: nil, geometry: floating()),
            .init(route: .synthesizedEventRecord(interfaceOrientation: 1), fallback: nil)
        )
    }

    func testPinnedFullScreenAppKeepsCoordinateRoute() {
        let fullScreen = GestureCoordinateGeometry(app: iPad, screen: iPad, observation: iPad, rotation: 0)
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: .keepPinned, forced: nil, geometry: fullScreen),
            .init(route: .xcuiCoordinate, fallback: .pinnedApp)
        )
    }

    func testMultiPanelWithoutWindowTranslationKeepsCoordinateRoute() {
        let multiPanel = floating(translation: nil)
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: unpinned, forced: nil, geometry: multiPanel),
            .init(route: .xcuiCoordinate, fallback: .multiPanel)
        )
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: .keepPinned, forced: nil, geometry: multiPanel),
            .init(route: .xcuiCoordinate, fallback: .pinnedApp)
        )
    }

    func testFloatingWindowStillHonoursForcedStrategyAndRotation() {
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: .keepPinned, forced: .legacy, geometry: floating()).fallback,
            .forcedStrategy
        )
        let noRotation = GestureCoordinateGeometry(
            app: floatingWindow, screen: iPad, observation: iPad, rotation: nil,
            windowTranslation: GesturePoint(x: 196, y: 320)
        )
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: .keepPinned, forced: nil, geometry: noRotation).fallback,
            .unknownRotation
        )
    }

    func testFallbackNamesWhyTheSynthesizedRouteWasSkipped() {
        let cases: [(GestureCoordinateGeometry?, TapCoordinateStrategy?, GestureDeliveryRoute.Fallback)] = [
            (nil, nil, .noObservation),
            (geometry(), .legacy, .forcedStrategy),
            (geometry(app: GestureSize(width: 0, height: 0)), nil, .invalidSize),
            (
                geometry(app: GestureSize(width: 600, height: 700), screen: GestureSize(width: 1024, height: 1366)),
                nil,
                .multiPanel
            ),
            (geometry(rotation: nil), nil, .unknownRotation),
        ]
        for (candidate, forced, fallback) in cases {
            XCTAssertEqual(
                GestureDeliveryRoute.decide(target: unpinned, forced: forced, geometry: candidate),
                .init(route: .xcuiCoordinate, fallback: fallback), "\(fallback)"
            )
        }
    }

    // MARK: - Windows tiled at the origin and moved windows (#19050)

    func testWindowTiledAtTheOriginSynthesizesForPinnedAndUnpinnedApps() {
        var originTile = floating(translation: nil)
        originTile.insetWindow = true
        for target in [GestureApplicationTarget.keepPinned, unpinned] {
            XCTAssertEqual(
                GestureDeliveryRoute.decide(target: target, forced: nil, geometry: originTile),
                .init(route: .synthesizedEventRecord(interfaceOrientation: 1), fallback: nil)
            )
        }
        XCTAssertEqual(originTile.replacingScreen(iPad).insetWindow, true)
    }

    private let iPadFrame = CGRect(x: 0, y: 0, width: 1032, height: 1376)
    private let windowSize = CGSize(width: 640, height: 720)

    private func placement(windowAt origin: CGPoint?) -> ObservedWindowPlacement {
        guard let origin else { return ObservedWindowPlacement(appFrame: iPadFrame, windowFrame: nil) }
        return ObservedWindowPlacement(
            appFrame: CGRect(origin: .zero, size: windowSize), windowFrame: CGRect(origin: origin, size: windowSize)
        )
    }

    private func observed(_ geometry: GestureCoordinateGeometry, windowAt origin: CGPoint?) -> ObservedGestureGeometry {
        ObservedGestureGeometry(
            geometry: geometry, bundleId: playground, generation: 1, placement: placement(windowAt: origin)
        )
    }

    func testMovedWindowGetsItsNewTranslation() {
        let cached = observed(floating(), windowAt: CGPoint(x: 196, y: 320))
        let refreshed = cached.refreshed(to: placement(windowAt: CGPoint(x: 300, y: 100)))
        XCTAssertEqual(refreshed.geometry.windowTranslation, GesturePoint(x: 300, y: 100))
        XCTAssertTrue(refreshed.geometry.insetWindow)
        XCTAssertEqual(refreshed.placement, placement(windowAt: CGPoint(x: 300, y: 100)))
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: .keepPinned, forced: nil, geometry: refreshed.geometry).fallback, nil
        )
    }

    func testWindowMovedToTheOriginStaysInsetWithoutTranslation() {
        let cached = observed(floating(), windowAt: CGPoint(x: 196, y: 320))
        let refreshed = cached.refreshed(to: placement(windowAt: .zero))
        XCTAssertNil(refreshed.geometry.windowTranslation)
        XCTAssertTrue(refreshed.geometry.insetWindow)
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: .keepPinned, forced: nil, geometry: refreshed.geometry),
            .init(route: .synthesizedEventRecord(interfaceOrientation: 1), fallback: nil)
        )
    }

    func testWindowReturnedToFullScreenDropsTheTranslation() {
        let cached = observed(floating(), windowAt: CGPoint(x: 196, y: 320))
        let refreshed = cached.refreshed(to: placement(windowAt: nil))
        XCTAssertEqual(refreshed.geometry.app, iPad)
        XCTAssertNil(refreshed.geometry.windowTranslation)
        XCTAssertFalse(refreshed.geometry.insetWindow)
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: .keepPinned, forced: nil, geometry: refreshed.geometry).fallback,
            .pinnedApp
        )
    }

    func testFullScreenWindowTiledLaterRoutesAsInset() {
        let fullScreen = GestureCoordinateGeometry(app: iPad, screen: iPad, observation: iPad, rotation: 0)
        let refreshed = observed(fullScreen, windowAt: nil).refreshed(to: placement(windowAt: CGPoint(x: 392, y: 0)))
        XCTAssertEqual(refreshed.geometry.windowTranslation, GesturePoint(x: 392, y: 0))
        XCTAssertEqual(
            GestureDeliveryRoute.decide(target: .keepPinned, forced: nil, geometry: refreshed.geometry).fallback, nil
        )
    }

    func testUnchangedOrUntrackedPlacementKeepsTheCache() {
        let cached = observed(floating(), windowAt: CGPoint(x: 196, y: 320))
        let jitter = placement(windowAt: CGPoint(x: 196.2, y: 319.9))
        XCTAssertEqual(cached.refreshed(to: jitter).geometry, cached.geometry)
        XCTAssertEqual(cached.refreshed(to: jitter).placement, cached.placement)
        var untracked = cached
        untracked.placement = nil
        XCTAssertEqual(untracked.refreshed(to: placement(windowAt: nil)).geometry, cached.geometry)
        var panel = observed(floating(), windowAt: CGPoint(x: 196, y: 320))
        panel.geometry.pinnedToObservation = true
        XCTAssertEqual(panel.refreshed(to: placement(windowAt: nil)).geometry, panel.geometry)
    }

    // MARK: - One route decision per command, no live read on the synthesized route (#19050)

    func testDoubleTapDecidesItsRouteOnceForBothContacts() throws {
        var routes = 0
        var contacts: [Int] = []
        let delivered = try UnpinnedGestureSynthesis.tap(
            doubleTap: true,
            route: {
                routes += 1
                return 1
            },
            deliver: { orientation in
                contacts.append(orientation)
                return true
            },
            wait: { _ in }
        )
        XCTAssertTrue(delivered)
        XCTAssertEqual(routes, 1)
        XCTAssertEqual(contacts, [1, 1])
    }

    func testRoutedTapWithoutASynthesizedRouteDeliversNothing() throws {
        XCTAssertFalse(try UnpinnedGestureSynthesis.tap(
            doubleTap: true, route: { nil },
            deliver: { _ in
                XCTFail("no contact without a route")
                return true
            },
            wait: { _ in XCTFail("no gap without a route") }
        ))
    }

    private func synthesizes(_ target: GestureApplicationTarget) -> (GestureCoordinateGeometry) -> Bool {
        { geometry in
            if case .synthesizedEventRecord = GestureDeliveryRoute.decide(
                target: target, forced: nil, geometry: geometry
            ).route { return true }
            return false
        }
    }

    func testGestureAfterASynthesizedOneNeverQueriesTheApp() {
        // The first gesture may have backgrounded the app; a live query could block ~90 s (#10624).
        var cached = observed(floating(), windowAt: CGPoint(x: 196, y: 320))
        cached.usedByGesture = true
        for target in [GestureApplicationTarget.keepPinned, unpinned] {
            let next = cached.routed(synthesizes: synthesizes(target)) { _ in
                XCTFail("synthesized route must not read the app window")
                return nil
            }
            XCTAssertEqual(next.geometry, cached.geometry)
        }
        var fullScreen = observed(
            GestureCoordinateGeometry(app: iPad, screen: iPad, observation: iPad, rotation: 0), windowAt: nil
        )
        fullScreen.usedByGesture = true
        _ = fullScreen.routed(synthesizes: synthesizes(unpinned)) { _ in
            XCTFail("an unpinned full-screen app must not be re-read")
            return nil
        }
    }

    func testFirstGestureUsesTheObservationAndMarksItUsed() {
        let cached = observed(
            GestureCoordinateGeometry(app: iPad, screen: iPad, observation: iPad, rotation: 0), windowAt: nil
        )
        let next = cached.routed(synthesizes: synthesizes(.keepPinned)) { _ in
            XCTFail("the first gesture routes on the observation")
            return nil
        }
        XCTAssertTrue(next.usedByGesture)
        XCTAssertEqual(next.geometry, cached.geometry)
    }

    func testCoordinateRouteReReadsAndPicksUpAWindowTiledSinceObserve() {
        var cached = observed(
            GestureCoordinateGeometry(app: iPad, screen: iPad, observation: iPad, rotation: 0), windowAt: nil
        )
        cached.usedByGesture = true
        var reads = 0
        let next = cached.routed(synthesizes: synthesizes(.keepPinned)) { screen in
            reads += 1
            XCTAssertEqual(screen, self.iPad)
            return self.placement(windowAt: CGPoint(x: 392, y: 0))
        }
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(next.geometry.windowTranslation, GesturePoint(x: 392, y: 0))
        XCTAssertTrue(synthesizes(.keepPinned)(next.geometry))
    }

    // MARK: - Drag and pinch (#10858)

    func testEveryGestureKindSharesTheSameDecisionInputs() {
        XCTAssertEqual(GestureKind.allCases, [.tap, .swipe, .drag, .pinch])
        for kind in GestureKind.allCases {
            XCTAssertEqual(
                GestureDeliveryRoute.decide(target: unpinned, forced: nil, geometry: geometry()),
                .init(route: .synthesizedEventRecord(interfaceOrientation: 1), fallback: nil), kind.rawValue
            )
            XCTAssertEqual(
                GestureDeliveryRoute.decide(target: .keepPinned, forced: nil, geometry: geometry()),
                .init(route: .xcuiCoordinate, fallback: .pinnedApp), kind.rawValue
            )
            XCTAssertEqual(
                GestureDeliveryRoute.decide(target: unpinned, forced: nil, geometry: nil).fallback,
                .noObservation, kind.rawValue
            )
        }
    }

    func testDragTouchKeepsPressMoveHoldTimingAndPoints() {
        let touch = UnpinnedGestureSynthesis.drag(
            start: GesturePoint(x: 10, y: 20), end: GesturePoint(x: 300, y: 400),
            press: 0.5, move: 1.2, hold: 0.3, displayId: 7, interfaceOrientation: 4
        )
        XCTAssertEqual(touch, DisplayTouch(
            start: GesturePoint(x: 10, y: 20), end: GesturePoint(x: 300, y: 400), pressDuration: 0.5,
            moveDuration: 1.2, holdDuration: 0.3, displayId: 7, interfaceOrientation: 4
        ))
    }

    func testDragTouchClampsNonFiniteAndNegativeDurations() {
        let touch = UnpinnedGestureSynthesis.drag(
            start: GesturePoint(x: 0, y: 0), end: GesturePoint(x: 1, y: 1),
            press: -1, move: .nan, hold: .infinity, displayId: 1, interfaceOrientation: 1
        )
        XCTAssertEqual([touch.pressDuration, touch.moveDuration, touch.holdDuration], [0, 0, 0])
    }

    func testMainDisplayIdComesFromTheMainScreenOnly() {
        typealias Screen = TapDiagnostics.DisplayScreen
        XCTAssertEqual(
            UnpinnedGestureSynthesis.mainDisplayId(screens: [
                Screen(displayId: 2, isMain: false), Screen(displayId: 1, isMain: true),
            ]),
            1
        )
        XCTAssertNil(UnpinnedGestureSynthesis.mainDisplayId(screens: [Screen(displayId: 2, isMain: false)]))
        XCTAssertNil(UnpinnedGestureSynthesis.mainDisplayId(screens: []))
    }
}
