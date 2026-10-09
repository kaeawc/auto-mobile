@testable import CtrlProxyRewrite
import Foundation
import XCTest

@MainActor
final class TapDiagnosticsTests: XCTestCase {
    private var fixture: TapDiagnostics {
        TapDiagnostics(
            requested: .init(x: 443, y: 202, durationMs: 50),
            baseScreenPoint: .init(x: 0, y: 0), resolvedScreenPoint: .init(x: 443, y: 202),
            application: .init(frame: .init(x: 0, y: 0, width: 669, height: 951)),
            screen: .init(
                bounds: .init(x: 0, y: 0, width: 951, height: 669),
                nativeBounds: .init(x: 0, y: 0, width: 2853, height: 2007),
                scale: 3, nativeScale: 3, source: "runnerProcessUIScreenMain"
            ),
            orientation: .init(
                device: .device(rawValue: 3),
                interface: .init(rawValue: 4, value: "landscapeLeft", source: "runnerProcessScenes")
            )
        )
    }

    private func encoded<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try XCTUnwrap(String(data: encoder.encode(value), encoding: .utf8))
    }

    func testFullPayloadSortedEncodingAndResponseCopy() throws {
        let expected =
            #"{"application":{"frame":{"height":951,"width":669,"x":0,"y":0}},"baseScreenPoint":{"x":0,"y":0},"orientation":{"device":{"rawValue":3,"source":"XCUIDevice.shared.orientation","value":"landscapeLeft"},"interface":{"rawValue":4,"source":"runnerProcessScenes","value":"landscapeLeft"}},"requested":{"coordinateConstruction":"appFrameOriginPlusPointOffset","durationMs":50,"mode":"press","units":"points","x":443,"y":202},"resolvedScreenPoint":{"x":443,"y":202},"sampleErrors":[],"screen":{"bounds":{"height":669,"width":951,"x":0,"y":0},"nativeBounds":{"height":2007,"width":2853,"x":0,"y":0},"nativeScale":3,"scale":3,"source":"runnerProcessUIScreenMain"}}"#
        XCTAssertEqual(try encoded(fixture), expected)
        XCTAssertEqual(try JSONDecoder().decode(TapDiagnostics.self, from: Data(expected.utf8)), fixture)
        let response = WebSocketResponse(
            type: "tap_coordinates_result", timestamp: 0, requestId: "tap", success: true,
            tapDiagnostics: fixture
        ).withPerfTiming(PerfTiming(name: "tap", durationMs: 0), totalTimeMs: 0)
        XCTAssertEqual(response.tapDiagnostics, fixture)
        XCTAssertTrue(try encoded(response).contains("\"tapDiagnostics\":\(expected)"))
        XCTAssertFalse(
            try encoded(WebSocketResponse(type: "tap_coordinates_result", timestamp: 0))
                .contains("tapDiagnostics")
        )
    }

    func testDisplayRoutingFieldsRoundTripAndLogLine() throws {
        var diagnostics = fixture
        diagnostics.strategy = "displayTargeted"
        diagnostics.route = .displayTargetedRecord
        diagnostics.targetDisplayId = 2
        diagnostics.targetDisplayReason = "soleNonMainScreen"
        diagnostics.deviceIdiom = "phone"
        diagnostics.mainDisplayId = 1
        diagnostics.applicationDisplayId = 1
        diagnostics.screens = [.init(displayId: 1, isMain: true), .init(displayId: 2, isMain: false)]
        diagnostics.synthesizedPoint = .init(x: 202, y: 508)
        diagnostics.synthesizedInterfaceOrientation = 1
        XCTAssertEqual(
            try JSONDecoder().decode(TapDiagnostics.self, from: Data(encoded(diagnostics).utf8)), diagnostics
        )
        let line = diagnostics.logLine()
        for field in [
            "route=displayTargetedRecord", "targetDisplayId=2", "targetDisplayReason=soleNonMainScreen",
            "deviceIdiom=phone", "mainDisplayId=1", "applicationDisplayId=1", "screens=",
            "synthesizedPoint=(202.0,508.0)",
            "synthesizedInterfaceOrientation=1", "fallbackFrom=nil", "deliveryWarning=nil",
        ] {
            XCTAssertTrue(line.contains(field), field)
        }
        diagnostics.route = .xcuiCoordinate
        diagnostics.synthesizedPoint = nil
        diagnostics.synthesizedInterfaceOrientation = nil
        diagnostics.fallbackFrom = "displayTargeted"
        diagnostics.deliveryWarning = .eventDisplayMismatch
        XCTAssertTrue(
            diagnostics.logLine()
                .contains("fallbackFrom=displayTargeted deliveryWarning=eventDisplayMismatch")
        )
        XCTAssertFalse(try encoded(fixture).contains("targetDisplayId"))
        XCTAssertFalse(try encoded(fixture).contains("deviceIdiom"))
        XCTAssertFalse(try encoded(fixture).contains("deliveryWarning"))
        XCTAssertTrue(diagnostics.logLine(gesture: "swipe").hasPrefix("tap_diagnostics gesture=swipe "))
    }

    func testSamplerOmitsCoordinatePointsForDisplayRecordWithoutErrors() throws {
        let sample = fixture
        let application = try XCTUnwrap(sample.application)
        let screen = try XCTUnwrap(sample.screen)
        let device = try XCTUnwrap(sample.orientation?.device)
        let interface = try XCTUnwrap(sample.orientation?.interface)
        let result = DefaultTapDiagnosticsSampler().sample(requested: sample.requested, reads: TapDiagnosticReads(
            baseScreenPoint: { nil }, resolvedScreenPoint: { nil },
            application: { application }, screen: { screen },
            deviceOrientation: { device }, interfaceOrientation: { interface }
        ))
        XCTAssertNil(result.baseScreenPoint)
        XCTAssertNil(result.resolvedScreenPoint)
        XCTAssertTrue(result.sampleErrors.isEmpty)
    }

    func testPartiallyFailedPayloadOmitsNilFields() throws {
        let partial = TapDiagnostics(
            requested: .init(x: 443, y: 202, durationMs: 0),
            resolvedScreenPoint: .init(x: 443, y: 202),
            sampleErrors: ["application.frame: unavailable"]
        )
        XCTAssertEqual(
            try encoded(partial),
            #"{"requested":{"coordinateConstruction":"appFrameOriginPlusPointOffset","durationMs":0,"mode":"tap","units":"points","x":443,"y":202},"resolvedScreenPoint":{"x":443,"y":202},"sampleErrors":["application.frame: unavailable"]}"#
        )
    }

    func testRequestDiagnosticsAbsentFalseAndTrue() throws {
        for (suffix, expected) in [
            ("", Bool?.none),
            (",\"diagnostics\":false", false),
            (",\"diagnostics\":true", true),
        ] {
            let request = try JSONDecoder().decode(
                RequestTapCoordinates.self,
                from: Data("{\"x\":443,\"y\":202,\"duration\":50\(suffix)}".utf8)
            )
            XCTAssertEqual(request.diagnostics, expected)
            XCTAssertEqual(request.x, 443)
            XCTAssertEqual(request.y, 202)
        }
    }

    func testRequestStrategyAbsentKnownAndUnknownRemainDecodable() throws {
        for strategy in [
            String?.none,
            "legacy",
            "appRelative",
            "appRelativeObserved",
            "displayTargeted",
            "displayTargetedObserved",
            "unknown",
        ] {
            let suffix = strategy.map { ",\"tapStrategy\":\"\($0)\"" } ?? ""
            let request = try JSONDecoder().decode(
                RequestTapCoordinates.self, from: Data("{\"x\":443,\"y\":202\(suffix)}".utf8)
            )
            XCTAssertEqual(request.tapStrategy, strategy)
        }
    }

    func testHandlerPlumbsStrategyWithAndWithoutDiagnostics() async throws {
        let gestures = RewriteFakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(), gesturePerformer: gestures,
            perf: FakePerfTracking(flushResult: nil)
        )
        for diagnostics in [false, true] {
            let request = try JSONDecoder().decode(
                WebSocketRequest.self,
                from: Data(
                    (
                        "{\"type\":\"request_tap_coordinates\",\"x\":443,\"y\":202," +
                            "\"diagnostics\":\(diagnostics),\"tapStrategy\":\"appRelativeObserved\"}"
                    ).utf8
                )
            )
            let result = await handler.handle(request)
            XCTAssertEqual((result as? WebSocketResponse)?.success, true)
        }
        XCTAssertEqual(gestures.tapStrategies, ["appRelativeObserved", "appRelativeObserved"])
        XCTAssertEqual(gestures.tapCalls, 1)
        XCTAssertEqual(gestures.diagnosticTapCalls, 1)
    }

    func testStrategyFieldsAppendToLegacyLogAndRoundTripOptionally() throws {
        var legacy = fixture
        legacy.strategy = "legacy"
        legacy.strategyReason = "singlePanel"
        XCTAssertEqual(legacy.logLine(), fixture.logLine() + " strategy=legacy strategyReason=singlePanel")
        XCTAssertFalse(try encoded(legacy).contains("normalizedOffset"))
        var relative = fixture
        relative.strategy = "appRelative"
        relative.strategyReason = "multiPanelMismatch"
        relative.normalizedOffset = .init(x: 202.0 / 669, y: 508.0 / 951)
        XCTAssertTrue(relative.logLine().contains("strategy=appRelative strategyReason=multiPanelMismatch"))
        XCTAssertTrue(relative.logLine().contains(" normalized=("))
        XCTAssertTrue(relative.logLine().hasPrefix(fixture.logLine()))
        let roundTrip = try JSONDecoder().decode(TapDiagnostics.self, from: Data(encoded(relative).utf8))
        XCTAssertEqual(roundTrip, relative)
        XCTAssertNil(fixture.strategy)
        XCTAssertNil(fixture.strategyReason)
        XCTAssertNil(fixture.normalizedOffset)
    }

    func testHandlerOffUsesPlainTapAndOmitsDiagnostics() async throws {
        let gestures = RewriteFakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(), gesturePerformer: gestures,
            perf: FakePerfTracking(flushResult: nil)
        )
        for flag in ["", ",\"diagnostics\":false"] {
            let request = try JSONDecoder().decode(
                WebSocketRequest.self,
                from: Data("{\"type\":\"request_tap_coordinates\",\"x\":443,\"y\":202\(flag)}".utf8)
            )
            let result = await handler.handle(request)
            let response = try XCTUnwrap(result as? WebSocketResponse)
            XCTAssertEqual(response.success, true)
            XCTAssertNil(response.tapDiagnostics)
            XCTAssertFalse(try encoded(response).contains("tapDiagnostics"))
        }
        XCTAssertEqual(gestures.tapCalls, 2)
        XCTAssertEqual(gestures.diagnosticTapCalls, 0)
    }

    func testHandlerLongPressTapRequestConvertsMillisecondsToSeconds() async throws {
        let gestures = RewriteFakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(), gesturePerformer: gestures,
            perf: FakePerfTracking(flushResult: nil)
        )
        let request = try JSONDecoder().decode(
            WebSocketRequest.self,
            from: Data(#"{"type":"request_tap_coordinates","x":443,"y":202,"duration":800}"#.utf8)
        )
        let result = await handler.handle(request)
        XCTAssertEqual((result as? WebSocketResponse)?.success, true)
        XCTAssertEqual(gestures.tapCalls, 1)
        XCTAssertEqual(gestures.tapDurations, [0.8])
        XCTAssertEqual(gestures.lastTap?.x, 443)
        XCTAssertEqual(gestures.lastTap?.y, 202)
    }

    func testHandlerDoubleTapRequestsDispatchTwoFiftyMillisecondTaps() async throws {
        let gestures = RewriteFakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(), gesturePerformer: gestures,
            perf: FakePerfTracking(flushResult: nil)
        )
        let request = try JSONDecoder().decode(
            WebSocketRequest.self,
            from: Data(#"{"type":"request_tap_coordinates","x":443,"y":202,"duration":50}"#.utf8)
        )
        for _ in 0 ..< 2 {
            let result = await handler.handle(request)
            XCTAssertEqual((result as? WebSocketResponse)?.success, true)
        }
        XCTAssertEqual(gestures.tapCalls, 2)
        XCTAssertEqual(gestures.tapDurations, [0.05, 0.05])
        XCTAssertEqual(gestures.lastTap?.x, 443)
        XCTAssertEqual(gestures.lastTap?.y, 202)
    }

    func testHandlerOnAttachesDiagnostics() async throws {
        let gestures = RewriteFakeGesturePerformer()
        gestures.tapDiagnosticsResult = fixture
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(), gesturePerformer: gestures,
            perf: FakePerfTracking(flushResult: nil)
        )
        let request = try JSONDecoder().decode(
            WebSocketRequest.self,
            from: Data(
                #"{"type":"request_tap_coordinates","requestId":"tap","x":443,"y":202,"duration":50,"diagnostics":true}"#
                    .utf8
            )
        )
        let result = await handler.handle(request)
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.tapDiagnostics, fixture)
        XCTAssertEqual(gestures.tapCalls, 0)
        XCTAssertEqual(gestures.diagnosticTapCalls, 1)
    }

    func testUnfoldedDuoConflictingFramesAreReportedUnchanged() throws {
        // This records a possible #8379 reading, not a tap behavior fix or measured delivery.
        let reading = try JSONDecoder().decode(TapDiagnostics.self, from: Data(encoded(fixture).utf8))
        XCTAssertEqual(reading.requested.x, 443)
        XCTAssertEqual(reading.requested.y, 202)
        XCTAssertEqual(reading.baseScreenPoint, .init(x: 0, y: 0))
        XCTAssertEqual(reading.resolvedScreenPoint, .init(x: 443, y: 202))
        XCTAssertEqual(reading.application?.frame, .init(x: 0, y: 0, width: 669, height: 951))
        XCTAssertEqual(reading.screen?.bounds, .init(x: 0, y: 0, width: 951, height: 669))
        XCTAssertEqual(reading.screen?.nativeBounds, .init(x: 0, y: 0, width: 2853, height: 2007))
        XCTAssertEqual(reading.screen?.scale, 3)
    }

    func testLogLineFixtureAndUnknownOrientation() {
        XCTAssertEqual(
            fixture.logLine(),
            "tap_diagnostics requested=(443.0,202.0) durationMs=50 mode=press base=(0.0,0.0) resolved=(443.0,202.0) appFrame=(0.0,0.0,669.0,951.0) screenBounds=(0.0,0.0,951.0,669.0) native=(0.0,0.0,2853.0,2007.0) scale=3.0 nativeScale=3.0 deviceOrientation=landscapeLeft(raw=3,source=XCUIDevice.shared.orientation,fallback=none) interfaceOrientation=landscapeLeft(raw=4,source=runnerProcessScenes,fallback=none) sampleErrors=[]"
        )
        XCTAssertEqual(TapDiagnostics.OrientationReading.device(rawValue: 0).value, "unknown")
        var partial = TapDiagnostics(requested: .init(x: 443, y: 202, durationMs: 0))
        partial.sampleErrors = ["read: line\nbreak"]
        XCTAssertTrue(partial.logLine().contains("mode=tap base=nil resolved=nil"))
        XCTAssertFalse(partial.logLine().contains("\n"))
    }

    private func reads() throws -> TapDiagnosticReads {
        let base = try XCTUnwrap(fixture.baseScreenPoint)
        let resolved = try XCTUnwrap(fixture.resolvedScreenPoint)
        let application = try XCTUnwrap(fixture.application)
        let screen = try XCTUnwrap(fixture.screen)
        let device = try XCTUnwrap(fixture.orientation?.device)
        let interface = try XCTUnwrap(fixture.orientation?.interface)
        return TapDiagnosticReads(
            baseScreenPoint: { base }, resolvedScreenPoint: { resolved }, application: { application },
            screen: { screen }, deviceOrientation: { device }, interfaceOrientation: { interface }
        )
    }

    func testSamplerAndInjectedFake() throws {
        let reads = try reads()
        XCTAssertEqual(DefaultTapDiagnosticsSampler().sample(requested: fixture.requested, reads: reads), fixture)
        let fake = FakeTapDiagnosticsSampler(result: fixture)
        let sampler: any TapDiagnosticsSampling = fake
        XCTAssertEqual(sampler.sample(requested: fixture.requested, reads: reads), fixture)
        XCTAssertEqual(fake.requests, [fixture.requested])
    }

    func testSamplerFailuresAreIndependentAndDoNotThrow() throws {
        let reads = try reads()
        let failed = TapDiagnosticReads(
            baseScreenPoint: {
                throw ObjCExceptionError(name: "base", reason: "unavailable")
            },
            resolvedScreenPoint: reads.resolvedScreenPoint,
            application: {
                NSException(name: .internalInconsistencyException, reason: "second display frame", userInfo: nil)
                    .raise()
                return try reads.application()
            },
            screen: reads.screen,
            deviceOrientation: { throw ObjCExceptionError(name: "orientation", reason: "unavailable") },
            interfaceOrientation: reads.interfaceOrientation
        )
        let result = DefaultTapDiagnosticsSampler().sample(requested: fixture.requested, reads: failed)
        XCTAssertNil(result.baseScreenPoint)
        XCTAssertNil(result.application)
        XCTAssertNil(result.orientation?.device)
        XCTAssertEqual(result.resolvedScreenPoint, fixture.resolvedScreenPoint)
        XCTAssertEqual(result.screen, fixture.screen)
        XCTAssertEqual(result.orientation?.interface, fixture.orientation?.interface)
        XCTAssertEqual(result.sampleErrors.count, 3)
        XCTAssertTrue(result.sampleErrors[0].contains("application.frame: NSException"))
        XCTAssertTrue(result.sampleErrors[1].hasPrefix("orientation.device: "))
        XCTAssertTrue(result.sampleErrors[2].hasPrefix("baseScreenPoint: "))
    }

    func testMovingGestureRequestNamesItsModeInsteadOfTap() {
        let swipe = TapDiagnostics(requested: .init(x: 292, y: 833, durationMs: 300, mode: "swipe"))
        XCTAssertEqual(swipe.requested.mode, "swipe")
        XCTAssertTrue(swipe.logLine(gesture: "swipe").contains("durationMs=300 mode=swipe"))
        XCTAssertEqual(TapDiagnostics.Requested(x: 1, y: 2, durationMs: 0).mode, "tap")
        XCTAssertEqual(TapDiagnostics.Requested(x: 1, y: 2, durationMs: 50).mode, "press")
    }
}
