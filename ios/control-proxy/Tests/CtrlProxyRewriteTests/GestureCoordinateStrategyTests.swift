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

@MainActor
private final class FakeReferenceScreenReader {
    var result: GestureSize?
    private(set) var reads = 0

    init(result: GestureSize?) { self.result = result }

    func read() -> GestureSize? {
        reads += 1
        return result
    }
}

/// Mirrors the provider's early correction, live fallback, and cache-only forced-legacy path.
@MainActor
private final class FakeReferenceDisplayGestureProvider: DisplayGestureProviding {
    let sample: GestureCoordinateGeometry
    let cache: ReferenceScreenCache
    var inventory: GestureDisplayInventory
    private(set) var inventoryReads = 0
    private(set) var geometryReads = 0
    private(set) var liveGeometryReads = 0
    private(set) var taps = 0
    private(set) var touches: [DisplayTouch] = []

    init(sample: GestureCoordinateGeometry, cache: ReferenceScreenCache, inventory: GestureDisplayInventory) {
        self.sample = sample
        self.cache = cache
        self.inventory = inventory
    }

    var cachedGeometry: GestureCoordinateGeometry? {
        sample.resolvingSinglePanel(reference: cache.cachedScreen(for: sample)) ?? sample
    }

    func geometry() throws -> GestureCoordinateGeometry? {
        geometryReads += 1
        guard hasMultiPanelMismatch(app: sample.app, screen: sample.screen) else { return sample }
        let reference = cache.screen(for: sample)
        if let corrected = sample.resolvingSinglePanel(reference: reference) { return corrected }
        liveGeometryReads += 1
        // The fake live frame/rotation stay unchanged; only the screen reference is substituted.
        return sample.replacingScreen(reference ?? sample.screen)
    }

    func displayInventory() -> GestureDisplayInventory {
        inventoryReads += 1
        return inventory
    }

    func synthesize(_ touch: DisplayTouch) throws -> Bool {
        touches.append(touch)
        return true
    }

    func coordinate(selection: GestureCoordinateSelection) throws -> GestureCoordinateSelection { selection }

    func tap(_: GestureCoordinateSelection, duration _: TimeInterval) throws { taps += 1 }

    func drag(
        _: GestureCoordinateSelection, to _: GestureCoordinateSelection,
        press _: TimeInterval, velocity _: Double?, hold _: TimeInterval
    )
        throws {}
}

@MainActor
extension GestureCoordinateStrategyTests {
    // Issue #9156 body: manual-test batch 10, main 93980d5ca, iPhone 18 Pro sim, iOS 27.0:
    // app 402x874; runnerProcessUIScreenMain 320x480 (nativeBounds 960x1440, scale 3);
    // screens [{displayId: 1, isMain: true}], mainDisplayId 1, applicationDisplayId 0.
    // /tmp/mtb10/captures/ios-secure-field-focused.raw.json: screenSize 402x874 points,
    // hierarchy root [0,0,402,874], rotation 0, screenScale 3, hence observation 402x874.
    // Reference-reader results are test hypotheses: the SpringBoard frame on a real device/Duo
    // was not captured, and the capture does not claim a SpringBoard frame measurement.
    private var capturedIPhone: GestureCoordinateGeometry {
        GestureCoordinateGeometry(
            app: GestureSize(width: 402, height: 874), screen: GestureSize(width: 320, height: 480),
            observation: GestureSize(width: 402, height: 874), rotation: 0
        )
    }

    private var capturedMainOnlyInventory: GestureDisplayInventory {
        GestureDisplayInventory(
            screens: [.init(displayId: 1, isMain: true)], applicationDisplayId: 0, isPhoneIdiom: true
        )
    }

    func testReferenceScreenCorrectsThreeCapturedIPhoneTapsAcrossProviders() throws {
        let reader = FakeReferenceScreenReader(result: capturedIPhone.app)
        let cache = ReferenceScreenCache { reader.read() }
        for _ in 0 ..< 3 {
            // Like GesturePerformer, construct a provider per gesture with the same process cache.
            let provider = FakeReferenceDisplayGestureProvider(
                sample: capturedIPhone, cache: cache, inventory: capturedMainOnlyInventory
            )
            let factory = try DisplayGestureFactory(provider: provider)
            let delivery = try factory.deliver(start: .zero, press: 0)
            var diagnostics = TapDiagnostics(requested: .init(x: 0, y: 0, durationMs: 0))
            factory.annotate(&diagnostics, delivery: delivery)
            XCTAssertNil(diagnostics.deliveryWarning)
            XCTAssertFalse(factory.mismatch)
            XCTAssertEqual(provider.inventoryReads, 0)
            XCTAssertEqual(provider.liveGeometryReads, 0)
            XCTAssertEqual(provider.taps, 1)
            XCTAssertEqual(delivery.selection.strategy, .legacy)
            XCTAssertEqual(delivery.selection.reason, "singlePanel")
            XCTAssertEqual(diagnostics.strategyReason, "singlePanel")
            XCTAssertEqual(delivery.route, .xcuiCoordinate)
            XCTAssertEqual(diagnostics.route, .xcuiCoordinate)
            XCTAssertEqual(diagnostics.targetDisplayReason, "notSampled")
        }
        XCTAssertEqual(reader.reads, 1)
    }

    func testReferenceScreenPreservesUnfoldedDuoMismatchAndDisplayRouting() throws {
        // Existing unfolded fixture and local [main] / [main, inner] inventory shapes from
        // DisplayTargetedGestureTests; 466x678 is a hypothetical reference, not a Duo capture.
        let main = TapDiagnostics.DisplayScreen(displayId: 1, isMain: true)
        let inner = TapDiagnostics.DisplayScreen(displayId: 2, isMain: false)
        for screens in [[main], [main, inner]] {
            let reader = FakeReferenceScreenReader(result: unfolded.screen)
            let cache = ReferenceScreenCache { reader.read() }
            let provider = FakeReferenceDisplayGestureProvider(
                sample: unfolded, cache: cache,
                inventory: GestureDisplayInventory(screens: screens, applicationDisplayId: 0, isPhoneIdiom: true)
            )
            let factory = try DisplayGestureFactory(provider: provider)
            let delivery = try factory.deliver(start: GesturePoint(x: 443, y: 202), press: 0)
            var diagnostics = TapDiagnostics(requested: .init(x: 443, y: 202, durationMs: 0))
            factory.annotate(&diagnostics, delivery: delivery)
            XCTAssertTrue(factory.mismatch)
            XCTAssertEqual(provider.inventoryReads, 1)
            XCTAssertEqual(provider.liveGeometryReads, 1)
            XCTAssertEqual(reader.reads, 1)
            XCTAssertEqual(delivery.selection.reason, "multiPanelMismatch")
            if screens.count == 1 {
                XCTAssertEqual(delivery.selection.strategy, .appRelative)
                XCTAssertEqual(diagnostics.deliveryWarning, .eventDisplayMismatch)
                XCTAssertEqual(diagnostics.route, .xcuiCoordinate)
                XCTAssertEqual(diagnostics.targetDisplayReason, "noNonMainScreen")
                XCTAssertTrue(provider.touches.isEmpty)
            } else {
                XCTAssertEqual(delivery.selection.strategy, .displayTargeted)
                XCTAssertNil(diagnostics.deliveryWarning)
                XCTAssertEqual(diagnostics.route, .displayTargetedRecord)
                XCTAssertEqual(provider.touches.first?.displayId, 2)
            }
        }
    }

    func testFailedReferenceReadKeepsCapturedIPhoneWarningDuringRetryInterval() throws {
        let reader = FakeReferenceScreenReader(result: nil)
        let timer = FakeProxyTimer(mode: .manual)
        let cache = ReferenceScreenCache(timer: timer) { reader.read() }
        let provider = FakeReferenceDisplayGestureProvider(
            sample: capturedIPhone, cache: cache, inventory: capturedMainOnlyInventory
        )
        for _ in 0 ..< 3 {
            let factory = try DisplayGestureFactory(provider: provider)
            let delivery = try factory.deliver(start: .zero, press: 0)
            var diagnostics = TapDiagnostics(requested: .init(x: 0, y: 0, durationMs: 0))
            factory.annotate(&diagnostics, delivery: delivery)
            XCTAssertTrue(factory.mismatch)
            XCTAssertEqual(delivery.selection.strategy, .legacy)
            // Exact pre-fix reason captured in issue #9156's tap diagnostics.
            XCTAssertEqual(delivery.selection.reason, "mappingUndefined(rotation=0,geometryOrPoint)")
            XCTAssertEqual(diagnostics.deliveryWarning, .eventDisplayMismatch)
            XCTAssertEqual(diagnostics.route, .xcuiCoordinate)
        }
        XCTAssertNil(cache.cachedScreen(for: capturedIPhone))
        XCTAssertEqual(reader.reads, 1)
        XCTAssertEqual(provider.inventoryReads, 3)
        XCTAssertEqual(provider.liveGeometryReads, 3)
    }

    func testInvalidReferenceSizesKeepMismatchDuringRetryInterval() throws {
        for invalid in [
            GestureSize(width: 0, height: 0), GestureSize(width: .nan, height: 874),
            GestureSize(width: 402, height: .infinity), GestureSize(width: -1, height: 874),
        ] {
            let reader = FakeReferenceScreenReader(result: invalid)
            let timer = FakeProxyTimer(mode: .manual)
            let cache = ReferenceScreenCache(timer: timer) { reader.read() }
            let provider = FakeReferenceDisplayGestureProvider(
                sample: capturedIPhone, cache: cache, inventory: capturedMainOnlyInventory
            )
            let factory = try DisplayGestureFactory(provider: provider)
            let delivery = try factory.deliver(start: .zero, press: 0)
            var diagnostics = TapDiagnostics(requested: .init(x: 0, y: 0, durationMs: 0))
            factory.annotate(&diagnostics, delivery: delivery)
            XCTAssertTrue(factory.mismatch)
            XCTAssertEqual(diagnostics.deliveryWarning, .eventDisplayMismatch)
            XCTAssertNil(cache.screen(for: capturedIPhone))
            XCTAssertNil(cache.cachedScreen(for: capturedIPhone))
            XCTAssertNil(capturedIPhone.resolvingSinglePanel(reference: invalid))
            XCTAssertEqual(reader.reads, 1)
        }
    }

    func testReferenceCacheKeysRawSizesAndCachedReadsNeverCallReader() throws {
        let reader = FakeReferenceScreenReader(result: capturedIPhone.app)
        let timer = FakeProxyTimer(mode: .manual)
        let cache = ReferenceScreenCache(timer: timer) { reader.read() }
        let provider = FakeReferenceDisplayGestureProvider(
            sample: capturedIPhone, cache: cache, inventory: capturedMainOnlyInventory
        )
        XCTAssertNil(cache.cachedScreen(for: capturedIPhone))
        XCTAssertEqual(provider.cachedGeometry, capturedIPhone)
        XCTAssertEqual(reader.reads, 0)
        XCTAssertEqual(cache.screen(for: capturedIPhone), capturedIPhone.app)
        XCTAssertEqual(cache.cachedScreen(for: capturedIPhone), capturedIPhone.app)
        let corrected = try XCTUnwrap(provider.cachedGeometry)
        XCTAssertEqual(corrected, capturedIPhone.replacingScreen(capturedIPhone.app))
        XCTAssertEqual(corrected.observation, capturedIPhone.observation)
        XCTAssertEqual(corrected.rotation, capturedIPhone.rotation)
        XCTAssertEqual(reader.reads, 1)

        // Synthetic transpose of the capture exercises a rotated raw app-size key.
        let landscape = GestureCoordinateGeometry(
            app: GestureSize(width: 874, height: 402), screen: capturedIPhone.screen,
            observation: GestureSize(width: 874, height: 402), rotation: 1
        )
        XCTAssertNil(cache.cachedScreen(for: landscape))
        XCTAssertEqual(reader.reads, 1)
        reader.result = landscape.app
        XCTAssertEqual(cache.screen(for: landscape), landscape.app)
        XCTAssertEqual(cache.screen(for: landscape), landscape.app)
        XCTAssertEqual(reader.reads, 2)

        // A different raw screen also keys separately even with the same app size.
        let otherScreen = capturedIPhone.replacingScreen(unfolded.screen)
        XCTAssertNil(cache.cachedScreen(for: otherScreen))
        XCTAssertEqual(reader.reads, 2)
        reader.result = nil
        // Repeated failed reads are suppressed only during the retry interval.
        XCTAssertNil(cache.screen(for: otherScreen))
        XCTAssertNil(cache.screen(for: otherScreen))
        XCTAssertEqual(cache.cachedScreen(for: capturedIPhone), capturedIPhone.app)
        XCTAssertEqual(cache.screen(for: capturedIPhone), capturedIPhone.app)
        XCTAssertEqual(reader.reads, 3)
    }

    func testFailedReferenceReadRetriesAndCachesSuccessfulCorrection() throws {
        let reader = FakeReferenceScreenReader(result: nil)
        let timer = FakeProxyTimer(mode: .manual, initialTime: 100)
        let cache = ReferenceScreenCache(timer: timer) { reader.read() }
        XCTAssertNil(cache.screen(for: capturedIPhone))
        XCTAssertNil(cache.cachedScreen(for: capturedIPhone))
        XCTAssertNil(capturedIPhone.resolvingSinglePanel(reference: cache.cachedScreen(for: capturedIPhone)))
        XCTAssertEqual(reader.reads, 1)

        reader.result = capturedIPhone.app
        timer.advance(by: ReferenceScreenCache.failedReadRetryIntervalMs + 1)
        XCTAssertEqual(cache.screen(for: capturedIPhone), capturedIPhone.app)
        XCTAssertEqual(cache.cachedScreen(for: capturedIPhone), capturedIPhone.app)
        let corrected = try XCTUnwrap(
            capturedIPhone.resolvingSinglePanel(reference: cache.cachedScreen(for: capturedIPhone))
        )
        XCTAssertEqual(corrected, capturedIPhone.replacingScreen(capturedIPhone.app))
        XCTAssertFalse(hasMultiPanelMismatch(app: corrected.app, screen: corrected.screen))
        XCTAssertEqual(reader.reads, 2)

        reader.result = nil
        timer.advance(by: ReferenceScreenCache.failedReadRetryIntervalMs * 2)
        for _ in 0 ..< 3 {
            XCTAssertEqual(cache.screen(for: capturedIPhone), capturedIPhone.app)
            XCTAssertEqual(cache.cachedScreen(for: capturedIPhone), capturedIPhone.app)
        }
        XCTAssertEqual(reader.reads, 2)
    }

    func testRepeatedReferenceFailuresAreRateLimitedPerKey() {
        let reader = FakeReferenceScreenReader(result: nil)
        let timer = FakeProxyTimer(mode: .manual, initialTime: 100)
        let retryAfterMs: Int64 = 250
        let cache = ReferenceScreenCache(timer: timer, retryAfterMs: retryAfterMs) { reader.read() }
        for _ in 0 ..< 10 {
            XCTAssertNil(cache.screen(for: capturedIPhone))
        }
        XCTAssertEqual(reader.reads, 1)
        timer.advance(by: retryAfterMs - 1)
        XCTAssertNil(cache.screen(for: capturedIPhone))
        XCTAssertEqual(reader.reads, 1)

        timer.advance(by: 1)
        XCTAssertNil(cache.cachedScreen(for: capturedIPhone))
        XCTAssertEqual(reader.reads, 1)
        for _ in 0 ..< 10 {
            XCTAssertNil(cache.screen(for: capturedIPhone))
        }
        XCTAssertEqual(reader.reads, 2)
        timer.advance(by: retryAfterMs - 1)
        XCTAssertNil(cache.screen(for: capturedIPhone))
        XCTAssertEqual(reader.reads, 2)

        // Another raw-size key reads immediately even while this key is throttled.
        XCTAssertNil(cache.screen(for: capturedIPhone.replacingScreen(unfolded.screen)))
        XCTAssertEqual(reader.reads, 3)
    }

    func testSuccessfulReferenceReadIsMemoizedOncePerKey() {
        let reader = FakeReferenceScreenReader(result: capturedIPhone.app)
        let timer = FakeProxyTimer(mode: .manual)
        let cache = ReferenceScreenCache(timer: timer) { reader.read() }
        for _ in 0 ..< 3 {
            XCTAssertEqual(cache.screen(for: capturedIPhone), capturedIPhone.app)
            timer.advance(by: ReferenceScreenCache.failedReadRetryIntervalMs)
        }
        XCTAssertEqual(reader.reads, 1)

        let landscape = GestureCoordinateGeometry(
            app: GestureSize(width: 874, height: 402), screen: capturedIPhone.screen,
            observation: GestureSize(width: 874, height: 402), rotation: 1
        )
        reader.result = landscape.app
        for _ in 0 ..< 3 {
            XCTAssertEqual(cache.screen(for: landscape), landscape.app)
        }
        XCTAssertEqual(reader.reads, 2)
        XCTAssertEqual(cache.screen(for: capturedIPhone), capturedIPhone.app)
        XCTAssertEqual(cache.cachedScreen(for: landscape), landscape.app)
        XCTAssertEqual(reader.reads, 2)
    }

    func testInvalidReferenceSizeCanRecoverAfterRetryInterval() {
        for invalid in [GestureSize(width: 0, height: 0), GestureSize(width: .nan, height: 874)] {
            let reader = FakeReferenceScreenReader(result: invalid)
            let timer = FakeProxyTimer(mode: .manual)
            let cache = ReferenceScreenCache(timer: timer) { reader.read() }
            XCTAssertNil(cache.screen(for: capturedIPhone))
            XCTAssertNil(cache.cachedScreen(for: capturedIPhone))
            XCTAssertEqual(reader.reads, 1)

            reader.result = capturedIPhone.app
            timer.advance(by: ReferenceScreenCache.failedReadRetryIntervalMs - 1)
            XCTAssertNil(cache.screen(for: capturedIPhone))
            XCTAssertEqual(reader.reads, 1)
            timer.advance(by: 1)
            XCTAssertEqual(cache.screen(for: capturedIPhone), capturedIPhone.app)
            XCTAssertEqual(cache.cachedScreen(for: capturedIPhone), capturedIPhone.app)
            XCTAssertEqual(cache.screen(for: capturedIPhone), capturedIPhone.app)
            XCTAssertEqual(reader.reads, 2)
        }
    }

    func testReferenceResolutionCorrectsOnlyMatchingOrTransposedSinglePanelSizes() throws {
        XCTAssertNil(folded.resolvingSinglePanel(reference: folded.screen))
        XCTAssertNil(folded.resolvingSinglePanel(reference: unfolded.app))
        for reference in [capturedIPhone.app, GestureSize(width: 874, height: 402)] {
            let corrected = try XCTUnwrap(capturedIPhone.resolvingSinglePanel(reference: reference))
            XCTAssertEqual(corrected, capturedIPhone.replacingScreen(reference))
            XCTAssertFalse(hasMultiPanelMismatch(app: corrected.app, screen: corrected.screen))
        }
        XCTAssertNil(unfolded.resolvingSinglePanel(reference: unfolded.screen))
        XCTAssertNil(capturedIPhone.resolvingSinglePanel(reference: capturedIPhone.screen))
        XCTAssertNil(capturedIPhone.resolvingSinglePanel(reference: nil))
    }

    func testForcedLegacyUsesWarmReferenceAndKeepsColdWarningWithoutLiveReads() throws {
        for warm in [true, false] {
            let reader = FakeReferenceScreenReader(result: capturedIPhone.app)
            let cache = ReferenceScreenCache { reader.read() }
            if warm { XCTAssertEqual(cache.screen(for: capturedIPhone), capturedIPhone.app) }
            let provider = FakeReferenceDisplayGestureProvider(
                sample: capturedIPhone, cache: cache, inventory: capturedMainOnlyInventory
            )
            let readsBeforeForcedLegacy = reader.reads
            let factory = try DisplayGestureFactory(provider: provider, forced: .legacy)
            let delivery = try factory.deliver(start: .zero, press: 0, forced: .legacy)
            var diagnostics = TapDiagnostics(requested: .init(x: 0, y: 0, durationMs: 0))
            factory.annotate(&diagnostics, delivery: delivery)
            XCTAssertEqual(factory.mismatch, !warm)
            // The first-ever forced-legacy call may still warn: it cannot read SpringBoard to warm the cache.
            XCTAssertEqual(diagnostics.deliveryWarning, warm ? nil : .eventDisplayMismatch)
            XCTAssertEqual(delivery.selection.strategy, .legacy)
            XCTAssertEqual(delivery.selection.reason, "forced")
            XCTAssertEqual(diagnostics.route, .xcuiCoordinate)
            XCTAssertEqual(provider.inventoryReads, warm ? 0 : 1)
            XCTAssertEqual(provider.geometryReads, 0)
            XCTAssertEqual(provider.liveGeometryReads, 0)
            XCTAssertEqual(reader.reads - readsBeforeForcedLegacy, 0)
        }
    }
}

@MainActor
extension GestureCoordinateStrategyTests {
    // Issue #9207 capture, 2026-10-08, origin/main 90a8017815. A temporary XCUITest in the runner read
    // XCUIApplication(com.apple.springboard).frame and the Playground app frame (pt):
    //   iPhone 17 sim, iOS 26.5:       springboard 402x874, app 402x874, window 402x874.
    //   iPhone Duo sim, iOS 27.1, folded (cover): springboard 466x678, app 466x678, window 466x678.
    //   iPhone Duo sim, iOS 27.1, unfolded (opened, 180 deg): springboard 466x678 (the cover panel,
    //     not the inner screen), app 669x951 (inner 2007x2853 px at 3x), window 951x669.
    // So SpringBoard's frame equals the real screen on an iPhone and on a folded Duo, but NOT on an
    // unfolded Duo, where it stays at the cover size and the mismatch check is what reports the panel.
    private func capturedGeometry(app: GestureSize, springboard: GestureSize) -> GestureCoordinateGeometry {
        GestureCoordinateGeometry(app: app, screen: springboard, observation: app, rotation: 0)
    }

    func testCapturedSpringBoardFramesReportNoMismatchOnHealthyDevices() {
        let iPhone = GestureSize(width: 402, height: 874)
        let foldedDuo = GestureSize(width: 466, height: 678)
        XCTAssertFalse(hasMultiPanelMismatch(app: iPhone, screen: iPhone))
        XCTAssertFalse(hasMultiPanelMismatch(app: foldedDuo, screen: foldedDuo))
        for size in [iPhone, foldedDuo] {
            let selection = GestureCoordinateSelection.choose(
                point: GesturePoint(x: 10, y: 20), geometry: capturedGeometry(app: size, springboard: size)
            )
            XCTAssertEqual(selection.strategy, .legacy)
            XCTAssertEqual(selection.reason, "singlePanel")
        }
    }

    func testCapturedUnfoldedDuoSpringBoardFrameStillReportsTheMismatch() {
        let geometry = capturedGeometry(
            app: GestureSize(width: 669, height: 951), springboard: GestureSize(width: 466, height: 678)
        )
        XCTAssertTrue(hasMultiPanelMismatch(app: geometry.app, screen: geometry.screen))
        // The SpringBoard reference is the cover panel, so it cannot "resolve" the mismatch away.
        XCTAssertNil(geometry.resolvingSinglePanel(reference: GestureSize(width: 466, height: 678)))
        let selection = GestureCoordinateSelection.choose(point: GesturePoint(x: 100, y: 200), geometry: geometry)
        // Never the silent "singlePanel" path; an observation-less rotation 0 map is undefined here.
        XCTAssertNotEqual(selection.reason, "singlePanel")
    }

    func testCapturedUnfoldedDuoWindowIsTransposedFromTheAppFrameSoItIsNotAMismatchByItself() {
        // The app window reads 951x669 beside the 669x951 app frame; the check treats a transpose as rotation.
        XCTAssertFalse(
            hasMultiPanelMismatch(app: GestureSize(width: 669, height: 951), screen: GestureSize(width: 951, height: 669))
        )
    }
}
