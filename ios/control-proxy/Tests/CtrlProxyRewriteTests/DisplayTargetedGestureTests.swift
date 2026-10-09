@testable import CtrlProxyRewrite
import Foundation
import XCTest

@MainActor
final class DisplayTargetedGestureTests: XCTestCase {
    private let unfolded = GestureCoordinateGeometry(
        app: GestureSize(width: 669, height: 951), screen: GestureSize(width: 466, height: 678),
        observation: GestureSize(width: 951, height: 669), rotation: 1
    )
    private let folded = GestureCoordinateGeometry(
        app: GestureSize(width: 466, height: 678), screen: GestureSize(width: 466, height: 678),
        observation: GestureSize(width: 466, height: 678), rotation: 0
    )
    private let point = GesturePoint(x: 443, y: 202)
    private let main = TapDiagnostics.DisplayScreen(displayId: 1, isMain: true)
    private let inner = TapDiagnostics.DisplayScreen(displayId: 2, isMain: false)

    private func provider(geometry: GestureCoordinateGeometry? = nil) -> FakeDisplayGestureProvider {
        let provider = FakeDisplayGestureProvider(geometry: geometry ?? unfolded)
        provider.inventory = GestureDisplayInventory(
            screens: [main, inner], applicationDisplayId: nil, isPhoneIdiom: true
        )
        return provider
    }

    func testDisplayChoiceRules() {
        for (screens, app, isPhoneIdiom, expected) in [
            ([main, inner], UInt64(3), true, (UInt64(3), "appDisplay")),
            ([main, inner], UInt64(1), true, (UInt64(2), "soleNonMainScreen")),
            ([main, inner], UInt64(0), true, (UInt64(2), "soleNonMainScreen")),
            ([main, inner], nil, true, (UInt64(2), "soleNonMainScreen")),
            ([], nil, true, (nil, "noScreens")),
            ([], UInt64(3), true, (nil, "noScreens")),
            ([main], nil, true, (nil, "noNonMainScreen")),
            ([main, inner, .init(displayId: 3, isMain: false)], nil, true, (nil, "ambiguousNonMainScreens")),
            ([main, inner, .init(displayId: 3, isMain: false)], UInt64(3), true, (UInt64(3), "appDisplay")),
            ([inner], UInt64(3), true, (UInt64(2), "soleNonMainScreen")),
            ([main, inner], UInt64(3), false, (UInt64(3), "appDisplay")),
            ([main, inner], UInt64(1), false, (nil, "nonPhoneIdiom")),
            ([main, inner], UInt64(0), false, (nil, "nonPhoneIdiom")),
            ([main, inner], nil, false, (nil, "nonPhoneIdiom")),
            ([], nil, false, (nil, "noScreens")),
            ([main], nil, false, (nil, "noNonMainScreen")),
            ([main, inner, .init(displayId: 3, isMain: false)], nil, false, (nil, "ambiguousNonMainScreens")),
        ] as [([TapDiagnostics.DisplayScreen], UInt64?, Bool, (UInt64?, String))] {
            let inventory = GestureDisplayInventory(
                screens: screens, applicationDisplayId: app, isPhoneIdiom: isPhoneIdiom
            )
            XCTAssertEqual(inventory.target.displayId, expected.0)
            XCTAssertEqual(inventory.target.reason, expected.1)
        }
    }

    func testFoldedAndOrdinaryLandscapeStayLegacyWithZeroInventoryReads() throws {
        let landscape = GestureCoordinateGeometry(
            app: GestureSize(width: 678, height: 466), screen: folded.screen,
            observation: GestureSize(width: 678, height: 466), rotation: 1
        )
        for geometry in [folded, landscape] {
            let provider = provider(geometry: geometry)
            let factory = try DisplayGestureFactory(provider: provider)
            let requested = GesturePoint(x: 201, y: 222)
            let delivery = try factory.deliver(start: requested, press: 0)
            XCTAssertEqual(delivery.selection, GestureCoordinateSelection(
                strategy: .legacy, reason: "singlePanel", normalized: .zero, offset: requested
            ))
            XCTAssertEqual(provider.inventoryReads, 0)
            XCTAssertEqual(provider.actions, ["tap"])
            XCTAssertTrue(provider.touches.isEmpty)
            XCTAssertEqual(provider.selections, [delivery.selection])
        }
    }

    func testFoldedDiagnosticsInventoryDoesNotSelectDisplayRoute() throws {
        let provider = provider(geometry: folded)
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliver(start: GesturePoint(x: 201, y: 222), press: 0)
        var diagnostics = TapDiagnostics(requested: .init(x: 201, y: 222, durationMs: 0))
        factory.annotate(&diagnostics, delivery: delivery)
        XCTAssertEqual(provider.inventoryReads, 0)
        XCTAssertEqual(delivery.selection.strategy, .legacy)
        XCTAssertEqual(delivery.selection.reason, "singlePanel")
        XCTAssertEqual(provider.actions, ["tap"])
        XCTAssertTrue(provider.touches.isEmpty)
        XCTAssertEqual(diagnostics.route, .xcuiCoordinate)
        XCTAssertEqual(diagnostics.targetDisplayReason, "notSampled")
        XCTAssertNil(diagnostics.targetDisplayId)
        XCTAssertNil(diagnostics.mainDisplayId)
        XCTAssertNil(diagnostics.applicationDisplayId)
        XCTAssertNil(diagnostics.screens)
        XCTAssertNil(diagnostics.deviceIdiom)
        XCTAssertNil(diagnostics.deliveryWarning)
        XCTAssertTrue(
            diagnostics.logLine()
                .contains(
                    "route=xcuiCoordinate targetDisplayId=nil targetDisplayReason=notSampled deviceIdiom=nil mainDisplayId=nil applicationDisplayId=nil"
                )
        )
    }

    func testMismatchInventoryIsReadOnceAcrossDeliveryAndAnnotation() throws {
        for end in [nil, GesturePoint(x: 500, y: 250)] as [GesturePoint?] {
            let provider = provider()
            let factory = try DisplayGestureFactory(provider: provider)
            let delivery = try factory.deliver(start: point, end: end, press: 0.05, move: 0.3)
            var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: 50))
            factory.annotate(&diagnostics, delivery: delivery)
            XCTAssertEqual(provider.inventoryReads, 1)
            XCTAssertEqual(delivery.route, .displayTargetedRecord)
            XCTAssertEqual(provider.touches.count, 1)
            XCTAssertEqual(diagnostics.targetDisplayId, 2)
            XCTAssertEqual(diagnostics.targetDisplayReason, "soleNonMainScreen")
            XCTAssertEqual(diagnostics.mainDisplayId, 1)
            XCTAssertNil(diagnostics.applicationDisplayId)
            XCTAssertEqual(diagnostics.screens, [main, inner])
            XCTAssertEqual(diagnostics.deviceIdiom, "phone")
        }
    }

    func testBeforeActionRunsAfterBothCoordinatesForDirectTapAndSwipe() throws {
        for end in [nil, GesturePoint(x: 500, y: 250)] as [GesturePoint?] {
            let provider = provider(geometry: folded)
            let factory = try DisplayGestureFactory(provider: provider)
            _ = try factory.deliver(start: point, end: end, press: 0) { delivery in
                XCTAssertEqual(delivery.route, .xcuiCoordinate)
                XCTAssertEqual(provider.selections.count, end == nil ? 1 : 2)
                XCTAssertTrue(provider.actions.isEmpty)
                provider.actions.append("beforeAction")
            }
            XCTAssertEqual(provider.actions, ["beforeAction", end == nil ? "tap" : "drag"])
            XCTAssertTrue(provider.touches.isEmpty)
        }
    }

    func testBeforeActionRunsOnceForSynthesisAndTwiceForUnavailableSymbolsFallback() throws {
        for available in [true, false] {
            for end in [nil, GesturePoint(x: 500, y: 250)] as [GesturePoint?] {
                let provider = provider()
                provider.symbolsAvailable = available
                let factory = try DisplayGestureFactory(provider: provider)
                _ = try factory.deliver(start: point, end: end, press: 0) { delivery in
                    if delivery.route == .displayTargetedRecord {
                        XCTAssertTrue(provider.touches.isEmpty)
                        XCTAssertTrue(provider.selections.isEmpty)
                        XCTAssertTrue(provider.actions.isEmpty)
                        provider.actions.append("beforeSynthesis")
                    } else {
                        XCTAssertEqual(provider.touches.count, 1)
                        XCTAssertEqual(provider.selections.count, end == nil ? 1 : 2)
                        XCTAssertEqual(provider.actions, ["beforeSynthesis"])
                        provider.actions.append("beforeCoordinate")
                    }
                }
                XCTAssertEqual(provider.touches.count, 1)
                XCTAssertEqual(provider.actions, available ? ["beforeSynthesis"] : [
                    "beforeSynthesis", "beforeCoordinate", end == nil ? "tap" : "drag",
                ])
            }
        }
    }

    func testUnfoldedTargetsInnerPortraitPointAndPressDuration() throws {
        let provider = provider()
        provider.inventory = GestureDisplayInventory(
            screens: [main, inner], applicationDisplayId: 1, isPhoneIdiom: true
        )
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliver(start: point, press: 0.2)
        XCTAssertEqual(delivery.selection.strategy, .displayTargeted)
        XCTAssertEqual(delivery.selection.reason, "multiPanelMismatch")
        let touch = try XCTUnwrap(provider.touches.first)
        XCTAssertEqual(touch.start.x, 202, accuracy: 1e-9)
        XCTAssertEqual(touch.start.y, 508, accuracy: 1e-9)
        XCTAssertEqual(touch.end, touch.start)
        XCTAssertEqual(touch.pressDuration, 0.2)
        XCTAssertEqual(touch.moveDuration, 0)
        XCTAssertEqual(touch.displayId, 2)
        XCTAssertEqual(touch.interfaceOrientation, 1)
        XCTAssertEqual(delivery.route, .displayTargetedRecord)
        XCTAssertEqual(provider.inventoryReads, 1)
        XCTAssertTrue(provider.selections.isEmpty)
        XCTAssertTrue(provider.actions.isEmpty)
        var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: 200))
        factory.annotate(&diagnostics, delivery: delivery)
        XCTAssertEqual(diagnostics.targetDisplayReason, "soleNonMainScreen")
        XCTAssertEqual(diagnostics.deviceIdiom, "phone")
    }

    func testLongPressTargetsInnerDisplayAndAnnotatesDelivery() throws {
        for duration in [0.8, 2.5] {
            let provider = provider()
            let factory = try DisplayGestureFactory(provider: provider)
            let delivery = try factory.deliver(start: point, press: duration)
            XCTAssertEqual(provider.touches.count, 1)
            let touch = try XCTUnwrap(provider.touches.first)
            XCTAssertEqual(touch.start, GesturePoint(x: 202, y: 508))
            XCTAssertEqual(touch.end, touch.start)
            XCTAssertEqual(touch.displayId, 2)
            XCTAssertEqual(touch.interfaceOrientation, 1)
            XCTAssertEqual(touch.pressDuration, duration)
            XCTAssertEqual(touch.moveDuration, 0)
            XCTAssertEqual(delivery.route, .displayTargetedRecord)
            XCTAssertTrue(provider.actions.isEmpty)
            XCTAssertTrue(provider.selections.isEmpty)
            var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: Int(duration * 1000)))
            factory.annotate(&diagnostics, delivery: delivery)
            XCTAssertEqual(diagnostics.route, .displayTargetedRecord)
            XCTAssertEqual(diagnostics.targetDisplayId, 2)
            XCTAssertEqual(diagnostics.targetDisplayReason, "soleNonMainScreen")
            XCTAssertEqual(diagnostics.synthesizedPoint, .init(x: 202, y: 508))
            XCTAssertEqual(diagnostics.synthesizedInterfaceOrientation, 1)
            XCTAssertNil(diagnostics.fallbackFrom)
            XCTAssertNil(diagnostics.deliveryWarning)
            XCTAssertTrue(diagnostics.logLine(gesture: "longPress").contains("gesture=longPress"))
        }
    }

    func testFoldedLongPressRetainsCoordinatePressDuration() throws {
        for duration in [0.8, 2.5] {
            let provider = provider(geometry: folded)
            let factory = try DisplayGestureFactory(provider: provider)
            let delivery = try factory.deliver(start: point, press: duration)
            XCTAssertEqual(delivery.route, .xcuiCoordinate)
            XCTAssertEqual(delivery.selection, GestureCoordinateSelection.choose(point: point, geometry: folded))
            XCTAssertEqual(provider.selections, [delivery.selection])
            XCTAssertEqual(provider.actions, ["tapPress"])
            XCTAssertEqual(provider.tapDurations, [duration])
            XCTAssertEqual(provider.inventoryReads, 0)
            XCTAssertTrue(provider.touches.isEmpty)
        }
    }

    func testDoubleTapRequestsTargetInnerDisplayAsTwoDurationTaps() throws {
        let provider = provider()
        let factory = try DisplayGestureFactory(provider: provider)
        for _ in 0 ..< 2 {
            let delivery = try factory.deliver(start: point, press: 0.05)
            XCTAssertEqual(delivery.route, .displayTargetedRecord)
        }
        XCTAssertEqual(provider.touches.count, 2)
        let touch = try XCTUnwrap(provider.touches.first)
        XCTAssertEqual(provider.touches, [touch, touch])
        XCTAssertEqual(touch.displayId, 2)
        XCTAssertEqual(touch.start, GesturePoint(x: 202, y: 508))
        XCTAssertEqual(touch.end, touch.start)
        XCTAssertEqual(touch.pressDuration, 0.05)
        XCTAssertEqual(touch.moveDuration, 0)
        XCTAssertTrue(provider.actions.isEmpty)
        XCTAssertTrue(provider.selections.isEmpty)
    }

    func testFoldedDoubleTapRequestsRemainTwoCoordinateDurationTaps() throws {
        let provider = provider(geometry: folded)
        let factory = try DisplayGestureFactory(provider: provider)
        let selection = GestureCoordinateSelection.choose(point: point, geometry: folded)
        for _ in 0 ..< 2 {
            let delivery = try factory.deliver(start: point, press: 0.05)
            XCTAssertEqual(delivery.route, .xcuiCoordinate)
            XCTAssertEqual(delivery.selection, selection)
        }
        XCTAssertEqual(provider.selections, [selection, selection])
        XCTAssertEqual(provider.actions, ["tapPress", "tapPress"])
        XCTAssertEqual(provider.tapDurations, [0.05, 0.05])
        XCTAssertEqual(provider.inventoryReads, 0)
        XCTAssertTrue(provider.touches.isEmpty)
    }

    func testLongPressUnavailableSymbolsRetainCoordinateDuration() throws {
        let provider = provider()
        provider.symbolsAvailable = false
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliver(start: point, press: 0.8)
        XCTAssertEqual(provider.tapDurations, [0.8])
        XCTAssertEqual(provider.actions, ["tapPress"])
        XCTAssertEqual(provider.touches.count, 1)
        XCTAssertEqual(provider.selections, [delivery.selection])
        XCTAssertEqual(delivery.fallbackFrom, .displayTargeted)
        XCTAssertEqual(delivery.selection.strategy, .appRelative)
        var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: 800))
        factory.annotate(&diagnostics, delivery: delivery)
        XCTAssertEqual(diagnostics.route, .xcuiCoordinate)
        XCTAssertEqual(diagnostics.targetDisplayId, 2)
        XCTAssertEqual(diagnostics.deliveryWarning, .eventDisplayMismatch)
        XCTAssertEqual(diagnostics.fallbackFrom, TapCoordinateStrategy.displayTargeted.rawValue)
        XCTAssertNil(diagnostics.synthesizedPoint)
    }

    func testPadMainDisplayKeepsAppRelativeAndWarnsWithoutTargetedSynthesis() throws {
        let provider = provider()
        provider.inventory = GestureDisplayInventory(
            screens: [main, inner], applicationDisplayId: 1, isPhoneIdiom: false
        )
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliver(start: point, press: 0)
        XCTAssertEqual(delivery.route, .xcuiCoordinate)
        XCTAssertEqual(delivery.selection.strategy, .appRelative)
        XCTAssertEqual(delivery.selection.reason, "multiPanelMismatch")
        XCTAssertEqual(provider.selections, [delivery.selection])
        XCTAssertEqual(delivery.coordinate, delivery.selection)
        XCTAssertEqual(provider.actions, ["tap"])
        XCTAssertTrue(provider.touches.isEmpty)
        var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: 0))
        factory.annotate(&diagnostics, delivery: delivery)
        XCTAssertEqual(diagnostics.deliveryWarning, .eventDisplayMismatch)
        XCTAssertNil(diagnostics.targetDisplayId)
        XCTAssertEqual(diagnostics.targetDisplayReason, "nonPhoneIdiom")
        XCTAssertEqual(diagnostics.deviceIdiom, "other")
        XCTAssertEqual(diagnostics.route, .xcuiCoordinate)
    }

    func testUnresolvedDisplayKeepsAppRelativeAndWarns() throws {
        let provider = provider()
        provider.inventory = GestureDisplayInventory(screens: [main], applicationDisplayId: 1, isPhoneIdiom: true)
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliver(start: point, press: 0)
        XCTAssertEqual(delivery.selection.strategy, .appRelative)
        XCTAssertEqual(provider.actions, ["tap"])
        var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: 0))
        factory.annotate(&diagnostics, delivery: delivery)
        XCTAssertEqual(diagnostics.deliveryWarning, .eventDisplayMismatch)
        XCTAssertEqual(diagnostics.targetDisplayReason, "noNonMainScreen")
        XCTAssertEqual(diagnostics.route, .xcuiCoordinate)
    }

    func testForcedVariantsAndLegacyUsesOnlyCachedGeometry() throws {
        for forced in [
            TapCoordinateStrategy.legacy,
            .appRelative,
            .appRelativeObserved,
            .displayTargeted,
            .displayTargetedObserved,
        ] {
            let provider = provider()
            let factory = try DisplayGestureFactory(provider: provider, forced: forced)
            let delivery = try factory.deliver(start: point, press: 0, forced: forced)
            XCTAssertEqual(delivery.selection.strategy, forced)
            XCTAssertEqual(delivery.selection.reason, "forced")
            if forced == .legacy {
                XCTAssertEqual(provider.geometryReads, 0)
                XCTAssertEqual(delivery.coordinate?.offset, point)
                var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: 0))
                factory.annotate(&diagnostics, delivery: delivery)
                XCTAssertEqual(diagnostics.deliveryWarning, .eventDisplayMismatch)
            }
            if forced == .displayTargetedObserved {
                XCTAssertEqual(provider.touches.first?.start, point)
                XCTAssertEqual(provider.touches.first?.interfaceOrientation, 4)
            }
        }
    }

    func testForcedDisplayOnFoldedAndPortraitAndMirrorMappings() throws {
        let foldedProvider = provider(geometry: folded)
        let portrait = try DisplayGestureFactory(provider: foldedProvider, forced: .displayTargeted)
        let point = GesturePoint(x: 201, y: 222)
        _ = try portrait.deliver(start: point, press: 0, forced: .displayTargeted)
        let touch = try XCTUnwrap(foldedProvider.touches.first)
        XCTAssertEqual(touch.start.x, point.x, accuracy: 1e-9)
        XCTAssertEqual(touch.start.y, point.y, accuracy: 1e-9)
        XCTAssertEqual(foldedProvider.inventoryReads, 1)
        let mirrorGeometry = GestureCoordinateGeometry(
            app: unfolded.app, screen: unfolded.screen, observation: unfolded.observation, rotation: 3
        )
        let mirrorProvider = provider(geometry: mirrorGeometry)
        let mirror = try DisplayGestureFactory(provider: mirrorProvider)
        _ = try mirror.deliver(start: self.point, press: 0)
        let mirrored = try XCTUnwrap(mirrorProvider.touches.first)
        XCTAssertEqual(mirrored.start.x, 467, accuracy: 1e-9)
        XCTAssertEqual(mirrored.start.y, 443, accuracy: 1e-9)
        XCTAssertEqual(DeviceRotation.gestureInterfaceOrientationRawValue(rotation: 3), 3)
    }

    func testUndefinedMappingKeepsPreviousAutomaticReason() throws {
        let provider = provider(geometry: GestureCoordinateGeometry(
            app: unfolded.app, screen: unfolded.screen, observation: unfolded.observation, rotation: 2
        ))
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliver(start: point, press: 0)
        XCTAssertEqual(delivery.selection.strategy, .legacy)
        XCTAssertTrue(delivery.selection.reason.hasPrefix("mappingUndefined(rotation=2"))
        XCTAssertTrue(provider.touches.isEmpty)
    }

    func testUnavailableSymbolsFallBackFromBothDisplayVariants() throws {
        for forced in [TapCoordinateStrategy?.none, .displayTargetedObserved] {
            let provider = provider()
            provider.symbolsAvailable = false
            let factory = try DisplayGestureFactory(provider: provider, forced: forced)
            let delivery = try factory.deliver(start: point, press: 0.05, forced: forced)
            XCTAssertEqual(delivery.selection.strategy, .appRelative)
            XCTAssertEqual(delivery.fallbackFrom, forced ?? .displayTargeted)
            XCTAssertEqual(provider.actions, ["tapPress"])
            var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: 50))
            factory.annotate(&diagnostics, delivery: delivery)
            XCTAssertEqual(diagnostics.deliveryWarning, .eventDisplayMismatch)
            XCTAssertEqual(diagnostics.route, .xcuiCoordinate)
            XCTAssertNil(diagnostics.synthesizedPoint)
            XCTAssertEqual(diagnostics.fallbackFrom, (forced ?? .displayTargeted).rawValue)
        }
    }

    func testSynthesisFailurePropagatesWithoutCoordinateFallback() throws {
        for error in [
            GesturePerformer.GestureError.gestureFailed("synthesizeWithError returned NO"),
            ObjCExceptionError(name: "synthesis", reason: "exception"),
        ] as [Error] {
            let provider = provider()
            provider.synthesisError = error
            let factory = try DisplayGestureFactory(provider: provider)
            XCTAssertThrowsError(try factory.deliver(start: point, press: 0) { _ in
                XCTAssertTrue(provider.touches.isEmpty)
                provider.actions.append("beforeSynthesis")
            }) { caught in
                XCTAssertEqual(caught.localizedDescription, error.localizedDescription)
            }
            XCTAssertEqual(provider.actions, ["beforeSynthesis"])
            XCTAssertTrue(provider.selections.isEmpty)
        }
    }

    func testFoldedSwipeRetainsLegacyDragAndZeroInventoryReads() throws {
        let provider = provider(geometry: folded)
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliver(
            start: GesturePoint(x: 201, y: 222), end: GesturePoint(x: 250, y: 300),
            press: 0.05, move: 0.3, velocity: 300
        )
        XCTAssertEqual(delivery.selection.strategy, .legacy)
        XCTAssertEqual(delivery.selection.reason, "singlePanel")
        XCTAssertEqual(provider.inventoryReads, 0)
        XCTAssertEqual(provider.actions, ["drag"])
        XCTAssertEqual(provider.selections.map(\.offset), [GesturePoint(x: 201, y: 222), GesturePoint(x: 250, y: 300)])
        XCTAssertTrue(provider.touches.isEmpty)
    }

    func testForcedDisplayWithoutTargetOrDefinedOrientationFallsBack() throws {
        for forced in [TapCoordinateStrategy.displayTargeted, .displayTargetedObserved] {
            let provider = provider()
            provider.inventory = GestureDisplayInventory(screens: [], applicationDisplayId: nil, isPhoneIdiom: true)
            let factory = try DisplayGestureFactory(provider: provider, forced: forced)
            XCTAssertEqual(try factory.deliver(start: point, press: 0, forced: forced).selection.strategy, .appRelative)
            XCTAssertTrue(provider.touches.isEmpty)
            XCTAssertEqual(provider.inventoryReads, 1)
        }
        let provider = provider(geometry: GestureCoordinateGeometry(
            app: unfolded.app, screen: unfolded.screen, observation: unfolded.observation, rotation: nil
        ))
        let factory = try DisplayGestureFactory(provider: provider, forced: .displayTargetedObserved)
        let delivery = try factory.deliver(start: point, press: 0, forced: .displayTargetedObserved)
        XCTAssertEqual(delivery.selection.strategy, .legacy)
        XCTAssertTrue(provider.touches.isEmpty)
    }

    func testSwipeTargetsBothEndpointsAndUnavailableSymbolsUseDrag() throws {
        for available in [true, false] {
            let provider = provider()
            provider.symbolsAvailable = available
            let factory = try DisplayGestureFactory(provider: provider)
            let delivery = try factory.deliver(
                start: point, end: GesturePoint(x: 500, y: 250), press: 0.05, move: 0.3, velocity: 300
            )
            let touch = try XCTUnwrap(provider.touches.first)
            XCTAssertEqual(touch.end.x, 250, accuracy: 1e-9)
            XCTAssertEqual(touch.end.y, 451, accuracy: 1e-9)
            XCTAssertEqual(touch.pressDuration, 0.05)
            XCTAssertEqual(touch.moveDuration, 0.3)
            XCTAssertEqual(provider.actions, available ? [] : ["drag"])
            XCTAssertEqual(delivery.route, available ? .displayTargetedRecord : .xcuiCoordinate)
        }
    }

    func testDragTargetsInnerDisplayWithPressMoveAndHold() throws {
        let provider = provider()
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliver(
            start: point, end: GesturePoint(x: 500, y: 250), press: 0.6, move: 0.3, hold: 0.1, velocity: 200
        )
        let touch = try XCTUnwrap(provider.touches.first)
        XCTAssertEqual(touch.start.x, 202, accuracy: 1e-9)
        XCTAssertEqual(touch.start.y, 508, accuracy: 1e-9)
        XCTAssertEqual(touch.end.x, 250, accuracy: 1e-9)
        XCTAssertEqual(touch.end.y, 451, accuracy: 1e-9)
        XCTAssertEqual(touch.pressDuration, 0.6)
        XCTAssertEqual(touch.moveDuration, 0.3)
        XCTAssertEqual(touch.holdDuration, 0.1)
        XCTAssertEqual(touch.displayId, 2)
        XCTAssertEqual(delivery.route, .displayTargetedRecord)
        XCTAssertTrue(provider.actions.isEmpty)
    }

    func testDragUnavailableSymbolsAndFoldedKeepCoordinateDragWithHold() throws {
        for (geometry, available) in [(unfolded, false), (folded, true)] {
            let provider = provider(geometry: geometry)
            provider.symbolsAvailable = available
            let factory = try DisplayGestureFactory(provider: provider)
            let delivery = try factory.deliver(
                start: GesturePoint(x: 201, y: 222), end: GesturePoint(x: 250, y: 300),
                press: 0.6, move: 0.3, hold: 0.1, velocity: 200
            )
            XCTAssertEqual(provider.actions, ["drag"])
            XCTAssertEqual(provider.dragHolds, [0.1])
            XCTAssertEqual(provider.dragPresses, [0.6])
            XCTAssertEqual(delivery.route, .xcuiCoordinate)
        }
    }

    // MARK: - Pinch (#8379 follow-up)

    private func assertPath(
        _ path: DisplayFingerPath, start: (Double, Double), end: (Double, Double),
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(path.start.x, start.0, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(path.start.y, start.1, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(path.end.x, end.0, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(path.end.y, end.1, accuracy: 1e-9, file: file, line: line)
    }

    func testUnfoldedPinchTargetsInnerDisplayWithEachFingerMappedToPortrait() throws {
        let provider = provider()
        let factory = try DisplayGestureFactory(provider: provider)
        var before = 0
        let delivery = try factory.deliverPinch(
            center: point, distanceStart: 100, distanceEnd: 300, rotationDegrees: 0, duration: 0.4
        ) { _ in
            XCTAssertTrue(provider.pinches.isEmpty)
            before += 1
        }
        XCTAssertEqual(before, 1)
        let pinch = try XCTUnwrap(provider.pinches.first)
        XCTAssertEqual(provider.pinches.count, 1)
        // Observed fingers (393,202)->(293,202) and (493,202)->(593,202) on the landscape panel
        // map to (y, appHeight - x): the horizontal observed spread is vertical on the display.
        assertPath(pinch.first, start: (202, 558), end: (202, 658))
        assertPath(pinch.second, start: (202, 458), end: (202, 358))
        XCTAssertEqual(pinch.duration, 0.4)
        XCTAssertEqual(pinch.displayId, 2)
        XCTAssertEqual(pinch.interfaceOrientation, 1)
        XCTAssertEqual(delivery.route, .displayTargetedRecord)
        XCTAssertEqual(delivery.selection.strategy, .displayTargeted)
        XCTAssertEqual(delivery.selection.reason, "multiPanelMismatch")
        XCTAssertEqual(delivery.synthesizedPoint, GesturePoint(x: 202, y: 508))
        XCTAssertNil(delivery.fallbackFrom)
        XCTAssertTrue(provider.touches.isEmpty)
        XCTAssertTrue(provider.selections.isEmpty)
        XCTAssertTrue(provider.actions.isEmpty)
        XCTAssertEqual(provider.inventoryReads, 1)
        var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: 400, mode: "pinch"))
        factory.annotate(&diagnostics, delivery: delivery)
        XCTAssertEqual(diagnostics.route, .displayTargetedRecord)
        XCTAssertEqual(diagnostics.targetDisplayId, 2)
        XCTAssertNil(diagnostics.deliveryWarning)
        XCTAssertTrue(diagnostics.logLine(gesture: "pinch").contains("mode=pinch"))
    }

    func testPinchMappingPreservesSpreadAndRotationSense() throws {
        let provider = provider()
        let factory = try DisplayGestureFactory(provider: provider)
        _ = try factory.deliverPinch(
            center: point, distanceStart: 120, distanceEnd: 300, rotationDegrees: 90, duration: 0.3
        )
        let pinch = try XCTUnwrap(provider.pinches.first)
        func spread(_ a: GesturePoint, _ b: GesturePoint) -> Double { hypot(a.x - b.x, a.y - b.y) }
        XCTAssertEqual(spread(pinch.first.start, pinch.second.start), 120, accuracy: 1e-9)
        XCTAssertEqual(spread(pinch.first.end, pinch.second.end), 300, accuracy: 1e-9)
        // Observed end axis is vertical (443,52)/(443,352); the 90-degree map makes it horizontal
        // through the mapped center, keeping the turn's direction (the map is a proper rotation).
        assertPath(pinch.first, start: (202, 568), end: (52, 508))
        assertPath(pinch.second, start: (202, 448), end: (352, 508))
        let observed = observedPinchPaths(center: point, distanceStart: 120, distanceEnd: 300, rotationDegrees: 90)
        func cross(_ path: (first: DisplayFingerPath, second: DisplayFingerPath)) -> Double {
            let start = (path.second.start.x - path.first.start.x, path.second.start.y - path.first.start.y)
            let end = (path.second.end.x - path.first.end.x, path.second.end.y - path.first.end.y)
            return start.0 * end.1 - start.1 * end.0
        }
        XCTAssertEqual(cross(observed).sign, cross((pinch.first, pinch.second)).sign)
    }

    func testMirroredUnfoldedPinchUsesRotationThreeMapping() throws {
        let provider = provider(geometry: GestureCoordinateGeometry(
            app: unfolded.app, screen: unfolded.screen, observation: unfolded.observation, rotation: 3
        ))
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliverPinch(
            center: point, distanceStart: 100, distanceEnd: 300, rotationDegrees: 0, duration: 0.3
        )
        let pinch = try XCTUnwrap(provider.pinches.first)
        // (x, y) -> (appWidth - y, x)
        assertPath(pinch.first, start: (467, 393), end: (467, 293))
        assertPath(pinch.second, start: (467, 493), end: (467, 593))
        XCTAssertEqual(delivery.synthesizedPoint, GesturePoint(x: 467, y: 443))
        XCTAssertEqual(pinch.interfaceOrientation, 1)
    }

    func testDegeneratePinchDistancesKeepTheOnePointFloor() throws {
        let provider = provider()
        let factory = try DisplayGestureFactory(provider: provider)
        _ = try factory.deliverPinch(
            center: point, distanceStart: 0, distanceEnd: -5, rotationDegrees: 0, duration: 0.3
        )
        let pinch = try XCTUnwrap(provider.pinches.first)
        assertPath(pinch.first, start: (202, 508.5), end: (202, 508.5))
        assertPath(pinch.second, start: (202, 507.5), end: (202, 507.5))
    }

    func testFoldedPinchKeepsMainScreenPathWithZeroInventoryReads() throws {
        let provider = provider(geometry: folded)
        let factory = try DisplayGestureFactory(provider: provider)
        var before = 0
        let delivery = try factory.deliverPinch(
            center: point, distanceStart: 100, distanceEnd: 300, rotationDegrees: 0, duration: 0.3
        ) { _ in before += 1 }
        XCTAssertEqual(before, 0)
        XCTAssertNil(delivery.synthesizedPoint)
        XCTAssertNil(delivery.fallbackFrom)
        XCTAssertEqual(delivery.route, .xcuiCoordinate)
        XCTAssertEqual(delivery.selection.strategy, .legacy)
        XCTAssertFalse(factory.mismatch)
        XCTAssertEqual(provider.inventoryReads, 0)
        XCTAssertTrue(provider.pinches.isEmpty)
        XCTAssertTrue(provider.selections.isEmpty)
        XCTAssertTrue(provider.actions.isEmpty)
    }

    func testPinchWithoutAResolvedDisplayKeepsMainScreenPathAndWarns() throws {
        let provider = provider()
        provider.inventory = GestureDisplayInventory(screens: [main], applicationDisplayId: 1, isPhoneIdiom: true)
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliverPinch(
            center: point, distanceStart: 100, distanceEnd: 300, rotationDegrees: 0, duration: 0.3
        )
        XCTAssertNil(delivery.synthesizedPoint)
        XCTAssertNil(delivery.fallbackFrom)
        XCTAssertTrue(provider.pinches.isEmpty)
        var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: 300, mode: "pinch"))
        factory.annotate(&diagnostics, delivery: delivery)
        XCTAssertEqual(diagnostics.deliveryWarning, .eventDisplayMismatch)
        XCTAssertEqual(diagnostics.targetDisplayReason, "noNonMainScreen")
    }

    func testPinchUnavailableSymbolsFallBackToMainScreenPath() throws {
        let provider = provider()
        provider.symbolsAvailable = false
        let factory = try DisplayGestureFactory(provider: provider)
        let delivery = try factory.deliverPinch(
            center: point, distanceStart: 100, distanceEnd: 300, rotationDegrees: 0, duration: 0.3
        )
        XCTAssertEqual(provider.pinches.count, 1)
        XCTAssertNil(delivery.synthesizedPoint)
        XCTAssertEqual(delivery.fallbackFrom, .displayTargeted)
        XCTAssertEqual(delivery.selection.strategy, .appRelative)
        XCTAssertTrue(provider.selections.isEmpty)
        var diagnostics = TapDiagnostics(requested: .init(x: point.x, y: point.y, durationMs: 300, mode: "pinch"))
        factory.annotate(&diagnostics, delivery: delivery)
        XCTAssertEqual(diagnostics.route, .xcuiCoordinate)
        XCTAssertEqual(diagnostics.fallbackFrom, TapCoordinateStrategy.displayTargeted.rawValue)
        XCTAssertEqual(diagnostics.deliveryWarning, .eventDisplayMismatch)
    }

    func testPinchSynthesisErrorPropagates() throws {
        struct Failure: Error {}
        let provider = provider()
        provider.synthesisError = Failure()
        let factory = try DisplayGestureFactory(provider: provider)
        XCTAssertThrowsError(try factory.deliverPinch(
            center: point, distanceStart: 100, distanceEnd: 300, rotationDegrees: 0, duration: 0.3
        )) { XCTAssertTrue($0 is Failure) }
    }
}
