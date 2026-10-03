@testable import CtrlProxyRewrite
import Foundation
import XCTest

@MainActor
private final class FakeGestureCoordinateProvider: GestureCoordinateProviding {
    var sample: GestureCoordinateGeometry?
    var geometryCalls = 0
    var selections: [GestureCoordinateSelection] = []
    var actions: [String] = []
    var velocity: Double?

    init(sample: GestureCoordinateGeometry?) { self.sample = sample }

    func geometry() throws -> GestureCoordinateGeometry? {
        geometryCalls += 1
        return sample
    }

    func coordinate(selection: GestureCoordinateSelection) throws -> GestureCoordinateSelection {
        selections.append(selection)
        return selection
    }

    func tap(_: GestureCoordinateSelection, duration: TimeInterval) throws {
        actions.append(duration > 0 ? "tapPress" : "tap")
    }

    func drag(
        _: GestureCoordinateSelection, to _: GestureCoordinateSelection,
        press _: TimeInterval, velocity: Double?, hold _: TimeInterval
    )
        throws
    {
        actions.append("drag")
        self.velocity = velocity
    }
}

@MainActor
final class GestureCoordinateStrategyTests: XCTestCase {
    private let unfolded = GestureCoordinateGeometry(
        app: GestureSize(width: 669, height: 951), screen: GestureSize(width: 466, height: 678),
        observation: GestureSize(width: 951, height: 669), rotation: 1
    )
    private let folded = GestureCoordinateGeometry(
        app: GestureSize(width: 466, height: 678), screen: GestureSize(width: 466, height: 678),
        observation: GestureSize(width: 466, height: 678), rotation: 0
    )

    func testMismatchExcludesFoldedTransposeAndDegenerateSizes() {
        XCTAssertFalse(hasMultiPanelMismatch(app: folded.app, screen: folded.screen))
        XCTAssertTrue(hasMultiPanelMismatch(app: unfolded.app, screen: unfolded.screen))
        XCTAssertFalse(hasMultiPanelMismatch(
            app: GestureSize(width: 852, height: 393), screen: GestureSize(width: 393, height: 852)
        ))
        for size in [
            GestureSize(width: 0, height: 678), GestureSize(width: 466, height: 0),
            GestureSize(width: -1, height: 678), GestureSize(width: .nan, height: 678),
            GestureSize(width: 466, height: .infinity),
        ] {
            XCTAssertFalse(hasMultiPanelMismatch(app: size, screen: folded.screen))
            XCTAssertFalse(hasMultiPanelMismatch(app: folded.app, screen: size))
        }
    }

    func testMismatchToleranceIsInclusiveInBothOrientations() {
        XCTAssertFalse(hasMultiPanelMismatch(app: GestureSize(width: 467, height: 677), screen: folded.screen))
        XCTAssertTrue(hasMultiPanelMismatch(app: GestureSize(width: 467.001, height: 678), screen: folded.screen))
        XCTAssertFalse(hasMultiPanelMismatch(app: GestureSize(width: 679, height: 465), screen: folded.screen))
        XCTAssertTrue(hasMultiPanelMismatch(app: GestureSize(width: 679.001, height: 466), screen: folded.screen))
    }

    func testCapturedUnfoldedPointMapsToInnerPortraitFrame() throws {
        let mapped = try XCTUnwrap(GestureCoordinateSelection.mappedOffset(
            point: GesturePoint(x: 443, y: 202), geometry: unfolded, strategy: .appRelative
        ))
        XCTAssertEqual(mapped.x, 202.0 / 669, accuracy: 1e-9)
        XCTAssertEqual(mapped.y, 508.0 / 951, accuracy: 1e-9)
        XCTAssertEqual(mapped.x * 669, 202, accuracy: 1e-9)
        XCTAssertEqual(mapped.y * 951, 508, accuracy: 1e-9)
        let observed = try XCTUnwrap(GestureCoordinateSelection.mappedOffset(
            point: GesturePoint(x: 443, y: 202), geometry: unfolded, strategy: .appRelativeObserved
        ))
        XCTAssertEqual(observed.x, 443.0 / 951, accuracy: 1e-9)
        XCTAssertEqual(observed.y, 202.0 / 669, accuracy: 1e-9)
    }

    func testMirrorAndUndefinedMappings() throws {
        for rotation in [Int?.none, 0, 2, 4] {
            let geometry = GestureCoordinateGeometry(
                app: unfolded.app, screen: unfolded.screen, observation: unfolded.observation, rotation: rotation
            )
            XCTAssertNil(GestureCoordinateSelection.mappedOffset(
                point: GesturePoint(x: 443, y: 202), geometry: geometry, strategy: .appRelative
            ))
        }
        let mirror = GestureCoordinateGeometry(
            app: unfolded.app, screen: unfolded.screen, observation: unfolded.observation, rotation: 3
        )
        let mapped = try XCTUnwrap(GestureCoordinateSelection.mappedOffset(
            point: GesturePoint(x: 443, y: 202), geometry: mirror, strategy: .appRelative
        ))
        XCTAssertEqual(mapped.x, 467.0 / 669, accuracy: 1e-9)
        XCTAssertEqual(mapped.y, 443.0 / 951, accuracy: 1e-9)
        for point in [
            GesturePoint(x: -2, y: 202), GesturePoint(x: 952, y: 202), GesturePoint(x: 443, y: 670),
            GesturePoint(x: .nan, y: 202), GesturePoint(x: 443, y: .infinity),
        ] {
            for strategy in [TapCoordinateStrategy.appRelative, .appRelativeObserved] {
                XCTAssertNil(GestureCoordinateSelection.mappedOffset(
                    point: point, geometry: unfolded, strategy: strategy
                ))
            }
        }
        for size in [GestureSize(width: 0, height: 951), GestureSize(width: 669, height: .nan)] {
            let geometry = GestureCoordinateGeometry(
                app: size, screen: unfolded.screen, observation: unfolded.observation, rotation: 1
            )
            XCTAssertNil(GestureCoordinateSelection.mappedOffset(
                point: GesturePoint(x: 443, y: 202), geometry: geometry, strategy: .appRelative
            ))
        }
    }

    func testObservationRotationMatchesHostSizeFallback() {
        XCTAssertEqual(GestureCoordinateGeometry.observationRotation(nil, size: unfolded.observation), 1)
        XCTAssertEqual(GestureCoordinateGeometry.observationRotation(3, size: unfolded.observation), 3)
        XCTAssertEqual(GestureCoordinateGeometry.observationRotation(3, size: folded.observation), 0)
        XCTAssertEqual(GestureCoordinateGeometry.observationRotation(2, size: unfolded.observation), 2)
        XCTAssertNil(GestureCoordinateGeometry.observationRotation(nil, size: GestureSize(width: 0, height: 0)))
    }

    func testInvalidObservationAndNormalizedTolerance() throws {
        let point = GesturePoint(x: 443, y: 202)
        let invalid = GestureCoordinateGeometry(
            app: unfolded.app, screen: unfolded.screen, observation: GestureSize(width: 0, height: 669), rotation: 1
        )
        for strategy in [TapCoordinateStrategy.appRelative, .appRelativeObserved] {
            XCTAssertNil(GestureCoordinateSelection.mappedOffset(point: point, geometry: invalid, strategy: strategy))
        }
        let boundary = try XCTUnwrap(GestureCoordinateSelection.mappedOffset(
            point: GesturePoint(x: -1e-8, y: 202), geometry: unfolded, strategy: .appRelative
        ))
        XCTAssertEqual(boundary.y, 1)
        let provider = FakeGestureCoordinateProvider(sample: nil)
        let factory = try GestureCoordinateFactory(provider: provider)
        let resolved = try factory.resolve(x: 443, y: 202, forced: .appRelativeObserved)
        XCTAssertEqual(resolved.selection.strategy, .legacy)
        XCTAssertEqual(resolved.selection.reason, "mappingUndefined(noObservation)")
        XCTAssertEqual(resolved.coordinate.offset, point)
    }

    func testFactoryKeepsFoldedCapturedCoordinateExactlyLegacy() throws {
        let provider = FakeGestureCoordinateProvider(sample: folded)
        let factory = try GestureCoordinateFactory(provider: provider)
        let resolved = try factory.resolve(x: 201, y: 222)
        XCTAssertEqual(resolved.selection.strategy, .legacy)
        XCTAssertEqual(resolved.coordinate.anchor, .legacyApplication)
        XCTAssertEqual(resolved.selection.reason, "singlePanel")
        XCTAssertEqual(provider.selections, [GestureCoordinateSelection(
            strategy: .legacy, reason: "singlePanel", normalized: .zero, offset: GesturePoint(x: 201, y: 222)
        )])
    }

    func testFactoryAutomaticAndForcedStrategiesUseTheRequestedAnchor() throws {
        let provider = FakeGestureCoordinateProvider(sample: unfolded)
        let factory = try GestureCoordinateFactory(provider: provider)
        let automatic = try factory.resolve(x: 443, y: 202)
        XCTAssertEqual(automatic.selection.strategy, .appRelative)
        XCTAssertEqual(automatic.coordinate.anchor, .observedApplication)
        XCTAssertEqual(automatic.selection.reason, "multiPanelMismatch")
        XCTAssertNil(automatic.selection.offset)
        XCTAssertEqual(automatic.coordinate.normalized, GesturePoint(x: 202.0 / 669, y: 508.0 / 951))
        let forcedLegacy = try factory.resolve(x: 443, y: 202, forced: .legacy)
        XCTAssertEqual(forcedLegacy.coordinate.normalized, .zero)
        XCTAssertEqual(forcedLegacy.coordinate.offset, GesturePoint(x: 443, y: 202))
        XCTAssertEqual(forcedLegacy.selection.reason, "forced")
        let observed = try factory.resolve(x: 443, y: 202, forced: .appRelativeObserved)
        XCTAssertEqual(observed.selection.strategy, .appRelativeObserved)
        XCTAssertEqual(observed.coordinate.anchor, .observedApplication)
        XCTAssertEqual(observed.coordinate.normalized, GesturePoint(x: 443.0 / 951, y: 202.0 / 669))
        XCTAssertEqual(observed.selection.reason, "forced")
        XCTAssertEqual(provider.selections.count, 3)
        XCTAssertEqual(provider.geometryCalls, 1)
    }

    func testForcedLegacySkipsGeometryAndUndefinedForcedMappingFallsBack() throws {
        let provider = FakeGestureCoordinateProvider(sample: unfolded)
        let legacy = try GestureCoordinateFactory(provider: provider, forced: .legacy)
        XCTAssertEqual(try legacy.resolve(x: 443, y: 202, forced: .legacy).selection.strategy, .legacy)
        XCTAssertEqual(provider.geometryCalls, 0)
        provider.sample = GestureCoordinateGeometry(
            app: unfolded.app, screen: unfolded.screen, observation: unfolded.observation, rotation: 2
        )
        let factory = try GestureCoordinateFactory(provider: provider)
        let resolved = try factory.resolve(x: 443, y: 202, forced: .appRelative)
        XCTAssertEqual(resolved.selection.strategy, .legacy)
        XCTAssertTrue(resolved.selection.reason.hasPrefix("mappingUndefined(rotation=2"))
        XCTAssertEqual(resolved.coordinate.normalized, .zero)
        XCTAssertEqual(resolved.coordinate.offset, GesturePoint(x: 443, y: 202))
    }

    func testSharedFactorySupportsTapAndDragWithoutPlatformTypes() throws {
        for geometry in [folded, unfolded] {
            let provider = FakeGestureCoordinateProvider(sample: geometry)
            let factory = try GestureCoordinateFactory(provider: provider)
            let start = try factory.resolve(x: 201, y: 222)
            let end = try factory.resolve(x: 250, y: 300)
            try provider.tap(start.coordinate, duration: 0)
            try provider.tap(start.coordinate, duration: 0.05)
            try provider.drag(start.coordinate, to: end.coordinate, press: 0.05, velocity: 123, hold: 0)
            XCTAssertEqual(provider.actions, ["tap", "tapPress", "drag"])
            XCTAssertEqual(provider.velocity, 123)
            XCTAssertTrue(provider.selections.allSatisfy {
                $0.strategy == (geometry == folded ? .legacy : .appRelative)
            })
        }
    }
}
