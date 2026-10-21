import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

#if canImport(XCTest) && os(iOS)
    extension GesturePerformer {
        // MARK: - Tap Gestures

        public func tap(x: Double, y: Double, duration: TimeInterval = 0) throws {
            try tap(x: x, y: y, duration: duration, strategy: nil)
        }

        public func tap(x: Double, y: Double, duration: TimeInterval, strategy: String?) throws {
            _ = try performTap(x: x, y: y, duration: duration, requested: nil, forced: forcedTapStrategy(strategy))
        }

        public func doubleTap(x: Double, y: Double) throws {
            _ = try performTap(x: x, y: y, duration: 0, requested: nil, forced: nil, doubleTap: true)
        }

        private func forcedTapStrategy(_ value: String?) -> TapCoordinateStrategy? {
            guard let value else { return nil }
            let strategy = TapCoordinateStrategy(rawValue: value)
            if strategy == nil { logger.warning("Ignoring unknown tapStrategy: \(value, privacy: .public)") }
            return strategy
        }

        public func tapWithDiagnostics(x: Double, y: Double, durationMs: Int) throws -> TapDiagnostics {
            try tapWithDiagnostics(x: x, y: y, durationMs: durationMs, strategy: nil)
        }

        public func tapWithDiagnostics(
            x: Double, y: Double, durationMs: Int, strategy: String?
        )
            throws -> TapDiagnostics
        {
            // The requested value is always returned when delivery succeeds, even if every read fails.
            let requested = TapDiagnostics.Requested(x: x, y: y, durationMs: durationMs)
            return try performTap(
                x: x, y: y, duration: TimeInterval(durationMs) / 1000.0, requested: requested,
                forced: forcedTapStrategy(strategy)
            )
                ?? TapDiagnostics(requested: requested, sampleErrors: ["sampler: no sample returned"])
        }

        /// Cached observation geometry keeps the single-panel opt-out path free of new platform reads.
        private func performTap(
            x: Double, y: Double, duration: TimeInterval, requested: TapDiagnostics.Requested?,
            forced: TapCoordinateStrategy?, doubleTap: Bool = false
        )
            throws -> TapDiagnostics?
        {
            GesturePhaseDiagnostics.current?.begin("targetResolution")
            let target = gestureApplicationTarget()
            let point = GesturePoint(x: x, y: y)
            if try UnpinnedGestureSynthesis.tap(
                doubleTap: doubleTap,
                deliver: {
                    try self.deliverToUnpinnedForegroundApp(
                        target: target, forced: forced, start: point, end: point, duration: duration
                    )
                },
                wait: { gap in RunLoop.current.run(until: Date(timeIntervalSinceNow: gap)) }
            ) {
                return requested.map { requested in
                    TapDiagnostics(requested: .init(
                        x: requested.x, y: requested.y, durationMs: requested.durationMs,
                        coordinateConstruction: "synthesizedScreenPoint"
                    ))
                }
            }
            guard let app = gestureApplication(for: target) else {
                throw GestureError.noApplication
            }

            return try catchingObjCException {
                GesturePhaseDiagnostics.current?.begin("coordinateResolution")
                let provider = XCUIGestureCoordinateProvider(app: app, locator: elementLocator)
                let factory = try DisplayGestureFactory(provider: provider, forced: forced)
                var diagnostics: TapDiagnostics?
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                let delivery = try factory.deliver(
                    start: GesturePoint(x: x, y: y), press: duration, forced: forced, doubleTap: doubleTap
                ) { candidate in
                    if let requested {
                        let coordinate = candidate.coordinate
                        let selection = candidate.selection
                        let construction = candidate.route == .displayTargetedRecord ? "displayTargetedPoint" :
                            coordinate?.windowTranslation != nil ? "windowOriginPlusPointOffset" :
                            (selection.strategy == .legacy ? "appFrameOriginPlusPointOffset" : "appNormalizedOffset")
                        let requested = TapDiagnostics.Requested(
                            x: requested.x, y: requested.y, durationMs: requested.durationMs,
                            coordinateConstruction: construction
                        )
                        diagnostics = tapDiagnosticsSampler.sample(requested: requested, reads: TapDiagnosticReads(
                            baseScreenPoint: { try coordinate.map { try Self.diagnosticPoint($0.base.screenPoint) } },
                            resolvedScreenPoint: {
                                try coordinate.map { try Self.diagnosticPoint($0.resolved.screenPoint) }
                            },
                            // Record synthesis does not construct an XCUICoordinate; its points are omitted.
                            application: {
                                try .init(frame: Self.diagnosticFrame(
                                    (coordinate?.application ?? provider.observedApplication).frame
                                ))
                            },
                            screen: {
                                let screen = UIScreen.main
                                guard screen.scale.isFinite, screen.nativeScale.isFinite else {
                                    throw GestureError.gestureFailed("non-finite diagnostic scale")
                                }
                                return try .init(
                                    bounds: Self.diagnosticFrame(screen.bounds),
                                    nativeBounds: Self.diagnosticFrame(screen.nativeBounds),
                                    scale: Double(screen.scale), nativeScale: Double(screen.nativeScale),
                                    source: "runnerProcessUIScreenMain"
                                )
                            },
                            deviceOrientation: { .device(rawValue: XCUIDevice.shared.orientation.rawValue) },
                            interfaceOrientation: { DeviceRotation.tapDiagnosticInterfaceOrientation() }
                        ))
                    }
                    GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                }
                if var sample = diagnostics {
                    factory.annotate(&sample, delivery: delivery)
                    diagnostics = sample
                    logger.warning("\(sample.logLine(), privacy: .public)")
                } else if delivery.selection.strategy != .legacy || (forced != nil && forced != .legacy) || factory
                    .mismatch
                {
                    var sample = TapDiagnostics(requested: .init(
                        x: x, y: y, durationMs: Self.diagnosticDurationMs(duration)
                    ))
                    factory.annotate(&sample, delivery: delivery)
                    logger.warning("\(sample.logLine(), privacy: .public)")
                }
                return diagnostics
            }
        }

        static func diagnosticDurationMs(_ duration: TimeInterval) -> Int {
            duration.isFinite && abs(duration * 1000) < Double(Int.max) ? Int(duration * 1000) : 0
        }

        private static func diagnosticPoint(_ point: CGPoint) throws -> TapDiagnostics.Point {
            guard point.x.isFinite,
                  point.y.isFinite else { throw GestureError.gestureFailed("non-finite diagnostic point") }
            return .init(x: Double(point.x), y: Double(point.y))
        }

        private static func diagnosticFrame(_ frame: CGRect) throws -> TapDiagnostics.Frame {
            guard frame.origin.x.isFinite, frame.origin.y.isFinite, frame.width.isFinite, frame.height.isFinite else {
                throw GestureError.gestureFailed("non-finite diagnostic frame")
            }
            return .init(
                x: Double(frame.origin.x),
                y: Double(frame.origin.y),
                width: Double(frame.width),
                height: Double(frame.height)
            )
        }

        func logRelativeCoordinate(_ selection: GestureCoordinateSelection, gesture: String) {
            if selection.strategy != .legacy {
                logger.warning(
                    "tap_diagnostics gesture=\(gesture, privacy: .public) \(selection.logFields, privacy: .public)"
                )
            }
        }
    }
#endif
