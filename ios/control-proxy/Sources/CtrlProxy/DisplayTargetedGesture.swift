import Foundation
import ObjCExceptionCatcher

struct GestureDisplayInventory: Equatable, Sendable {
    let screens: [TapDiagnostics.DisplayScreen]
    let applicationDisplayId: UInt64?
    let isPhoneIdiom: Bool

    var mainDisplayId: UInt64? { screens.first(where: { $0.isMain })?.displayId }

    func target(for geometry: GestureCoordinateGeometry?) -> (displayId: UInt64?, reason: String) {
        if geometry?.isAppOnMainScreen(applicationDisplayId: applicationDisplayId) == true {
            return (nil, "appOnMainScreen")
        }
        return target
    }

    var target: (displayId: UInt64?, reason: String) {
        if let applicationDisplayId, applicationDisplayId != 0,
           let mainDisplayId, applicationDisplayId != mainDisplayId
        {
            return (applicationDisplayId, "appDisplay")
        }
        guard !screens.isEmpty else { return (nil, "noScreens") }
        let nonMain = screens.filter { !$0.isMain }
        guard !nonMain.isEmpty else { return (nil, "noNonMainScreen") }
        guard nonMain.count == 1 else { return (nil, "ambiguousNonMainScreens") }
        guard isPhoneIdiom else { return (nil, "nonPhoneIdiom") }
        return (nonMain[0].displayId, "soleNonMainScreen")
    }
}

struct DisplayTouch: Equatable, Sendable {
    let start: GesturePoint
    let end: GesturePoint
    let pressDuration: TimeInterval
    let moveDuration: TimeInterval
    var holdDuration: TimeInterval = 0
    let displayId: UInt64
    let interfaceOrientation: Int
}

/// Edge gestures use the observed panel size, rather than the portrait app frame, on a mismatch.
struct NavigationEdgeGesture: Equatable, Sendable {
    let start: GesturePoint
    let end: GesturePoint
    let press: TimeInterval
    let move: TimeInterval
    let hold: TimeInterval
    let velocity: Double?

    static func back(size: GestureSize) -> NavigationEdgeGesture {
        NavigationEdgeGesture(
            start: GesturePoint(x: 2, y: size.height / 2),
            end: GesturePoint(x: min(size.width * 0.75, size.width - 2), y: size.height / 2),
            press: 0.05, move: 0.3, hold: 0, velocity: nil
        )
    }

    static func recent(size: GestureSize) -> NavigationEdgeGesture {
        let start = GesturePoint(x: size.width / 2, y: size.height - 1)
        let end = GesturePoint(x: size.width / 2, y: size.height * 0.58)
        return NavigationEdgeGesture(
            start: start, end: end, press: 0.35, move: 0.6, hold: 0.8,
            velocity: abs(start.y - end.y) / 0.6
        )
    }
}

/// A timed single-finger polyline in display space. Offsets remain relative to touch down.
struct DisplayPath: Equatable, Sendable {
    let points: [PathGesturePoint]
    let displayId: UInt64
    let interfaceOrientation: Int
}

struct DisplayFingerPath: Equatable, Sendable {
    let start: GesturePoint
    let end: GesturePoint
    /// Waypoints between `start` and `end`, reached at evenly spaced fractions of the gesture. A
    /// rotating pinch follows an arc through these instead of the straight chord (#12996).
    var via: [GesturePoint] = []
}

/// Two simultaneous finger paths in display space; both move for `duration`, then lift.
struct DisplayPinch: Equatable, Sendable {
    let first: DisplayFingerPath
    let second: DisplayFingerPath
    let duration: TimeInterval
    let displayId: UInt64
    let interfaceOrientation: Int
}

/// The observed-space pinch paths. Degenerate distances get the same 1pt floor the main-screen
/// synthesis applies, and the trig is the shared `computePinchPoints` (#2979). A rotating pinch
/// also carries arc waypoints (`ObjCExceptionCatcher_pinchSegmentCount`) so it does not zoom (#12996).
func observedPinchPaths(
    center: GesturePoint, distanceStart: Double, distanceEnd: Double, rotationDegrees: Double
)
    -> (first: DisplayFingerPath, second: DisplayFingerPath)
{
    let flooredStart = CGFloat(max(distanceStart, 1))
    let flooredEnd = CGFloat(max(distanceEnd, 1))
    let points = ObjCExceptionCatcher_computePinchPoints(
        CGFloat(center.x), CGFloat(center.y), flooredStart, flooredEnd, CGFloat(rotationDegrees)
    )
    func point(_ value: CGPoint) -> GesturePoint { GesturePoint(x: Double(value.x), y: Double(value.y)) }
    let segments = Int(ObjCExceptionCatcher_pinchSegmentCount(CGFloat(rotationDegrees)))
    let waypoints = (1 ..< max(segments, 1)).map { index in
        ObjCExceptionCatcher_computePinchFingersAt(
            CGFloat(center.x), CGFloat(center.y), flooredStart, flooredEnd, CGFloat(rotationDegrees),
            CGFloat(index) / CGFloat(segments)
        )
    }
    return (
        DisplayFingerPath(
            start: point(points.start1), end: point(points.end1), via: waypoints.map { point($0.finger1) }
        ),
        DisplayFingerPath(
            start: point(points.start2), end: point(points.end2), via: waypoints.map { point($0.finger2) }
        )
    )
}

/// A false result means symbols unavailable; genuine errors must throw.
@MainActor
protocol DisplayGestureProviding: GestureCoordinateProviding {
    var cachedGeometry: GestureCoordinateGeometry? { get }
    func displayInventory() -> GestureDisplayInventory
    func synthesize(_ touch: DisplayTouch) throws -> Bool
    func synthesizePinch(_ pinch: DisplayPinch) throws -> Bool
    func synthesizePath(_ path: DisplayPath) throws -> Bool
}

struct DisplayGestureDelivery<Coordinate> {
    let selection: GestureCoordinateSelection
    let coordinate: Coordinate?
    let synthesizedPoint: GesturePoint?
    let synthesizedInterfaceOrientation: Int?
    let fallbackFrom: TapCoordinateStrategy?

    var route: TapDiagnostics.Route {
        synthesizedPoint == nil ? .xcuiCoordinate : .displayTargetedRecord
    }
}

/// Taps, single-finger swipes, drags, timed paths and two-finger pinches use this route. The host sends long
/// presses as taps with a press duration and double taps as one runner-side gesture. Other gestures keep their
/// existing paths.
@MainActor
struct DisplayGestureFactory<Provider: DisplayGestureProviding> {
    let provider: Provider
    let geometry: GestureCoordinateGeometry?
    let inventory: GestureDisplayInventory?
    let doubleTapWait: (TimeInterval) -> Void

    var mismatch: Bool {
        (geometry ?? provider.cachedGeometry)?.multiPanelMismatch == true
    }

    var target: (displayId: UInt64?, reason: String) {
        inventory?.target(for: geometry) ?? (nil, "notSampled")
    }

    init(
        provider: Provider, forced: TapCoordinateStrategy? = nil,
        doubleTapWait: @escaping (TimeInterval) -> Void = { gap in
            RunLoop.current.run(until: Date(timeIntervalSinceNow: gap))
        }
    )
        throws
    {
        self.provider = provider
        self.doubleTapWait = doubleTapWait
        // Forced legacy inspects only the observation cache, without live geometry reads.
        var geometry = forced == .legacy ? provider.cachedGeometry : try provider.geometry()
        // Read the inventory on the raw size mismatch before deciding whether the app is on main.
        let mismatch = (geometry ?? provider.cachedGeometry)
            .map { hasMultiPanelMismatch(app: $0.app, screen: $0.screen) } == true
        let inventory = mismatch || forced?.targetsDisplay == true ? provider.displayInventory() : nil
        geometry?.applicationDisplayId = inventory?.applicationDisplayId
        self.geometry = geometry
        self.inventory = inventory
    }

    func selection(point: GesturePoint, forced: TapCoordinateStrategy?) -> GestureCoordinateSelection {
        let strategy: TapCoordinateStrategy?
        if let forced, !forced.targetsDisplay {
            strategy = forced
        } else if mismatch || forced?.targetsDisplay == true, target.displayId != nil {
            strategy = forced ?? .displayTargeted
        } else {
            strategy = nil
        }
        let selected = GestureCoordinateSelection.choose(point: point, geometry: geometry, forced: strategy)
        if selected.strategy.targetsDisplay {
            guard selected.strategy != .displayTargetedObserved ||
                DeviceRotation.gestureInterfaceOrientationRawValue(rotation: geometry?.rotation) != nil
            else { return GestureCoordinateSelection.choose(point: point, geometry: geometry) }
            return GestureCoordinateSelection(
                strategy: selected.strategy, reason: forced == nil ? "multiPanelMismatch" : "forced",
                normalized: selected.normalized, offset: selected.offset, isForced: forced != nil
            )
        }
        // An undefined display mapping retains the old automatic mapping/reasons.
        if strategy?.targetsDisplay == true {
            return GestureCoordinateSelection.choose(point: point, geometry: geometry)
        }
        return selected
    }

    private func point(_ observed: GesturePoint, selection: GestureCoordinateSelection) -> GesturePoint? {
        guard let geometry else { return nil }
        if selection.strategy == .displayTargetedObserved { return observed }
        guard selection.strategy == .displayTargeted else { return nil }
        // Preserve exact point values instead of introducing normalize/denormalize rounding.
        // A portrait reading cannot describe a landscape observation: the rotation sample lags an
        // unfold (#18245) and passing points through unrotated lands them in portrait space.
        let corrected = geometry.rotation == 0 && geometry.observation.isValid &&
            geometry.observation.width > geometry.observation.height
        switch corrected ? 1 : geometry.rotation {
        case 0: return observed
        case 1:
            return GesturePoint(
                x: observed.y, y: (corrected ? geometry.observation.width : geometry.app.height) - observed.x
            )
        case 3: return GesturePoint(x: geometry.app.width - observed.y, y: observed.x)
        default: return nil
        }
    }

    func deliver(
        start: GesturePoint, end: GesturePoint? = nil, press: TimeInterval, move: TimeInterval = 0,
        hold: TimeInterval = 0, velocity: Double? = nil, forced: TapCoordinateStrategy? = nil,
        doubleTap: Bool = false,
        beforeAction: (DisplayGestureDelivery<Provider.Coordinate>) -> Void = { _ in }
    )
        throws -> DisplayGestureDelivery<Provider.Coordinate>
    {
        var selected = selection(point: start, forced: forced)
        let endSelection = selection(point: end ?? start, forced: forced)
        var fallback: TapCoordinateStrategy?
        if selected.strategy.targetsDisplay,
           let displayId = target.displayId,
           let startPoint = point(start, selection: selected),
           let endPoint = point(end ?? start, selection: endSelection)
        {
            let orientation = selected.strategy == .displayTargeted ? 1 :
                DeviceRotation.gestureInterfaceOrientationRawValue(rotation: geometry?.rotation)
            if let orientation {
                let candidate = DisplayGestureDelivery<Provider.Coordinate>(
                    selection: selected, coordinate: nil, synthesizedPoint: startPoint,
                    synthesizedInterfaceOrientation: orientation, fallbackFrom: nil
                )
                beforeAction(candidate)
                // A nonzero drag is one gesture even when the caller sets the double-tap flag.
                if try UnpinnedGestureSynthesis.tap(
                    doubleTap: doubleTap && (end == nil || end == start),
                    deliver: {
                        try provider.synthesize(DisplayTouch(
                            start: startPoint, end: endPoint, pressDuration: press, moveDuration: move,
                            holdDuration: hold, displayId: displayId, interfaceOrientation: orientation
                        ))
                    },
                    wait: doubleTapWait
                ) { return candidate }
            }
            fallback = selected.strategy
        }
        if selected.strategy.targetsDisplay {
            selected = GestureCoordinateSelection.choose(point: start, geometry: geometry)
        }
        let coordinate = try provider.coordinate(selection: selected)
        let delivery = DisplayGestureDelivery(
            selection: selected, coordinate: coordinate, synthesizedPoint: nil,
            synthesizedInterfaceOrientation: nil, fallbackFrom: fallback
        )
        if let end {
            let selectedEnd = GestureCoordinateSelection.choose(point: end, geometry: geometry)
            let endCoordinate = try provider.coordinate(selection: selectedEnd)
            beforeAction(delivery)
            try provider.drag(coordinate, to: endCoordinate, press: press, velocity: velocity, hold: hold)
        } else {
            beforeAction(delivery)
            if doubleTap {
                try provider.doubleTap(coordinate)
            } else {
                try provider.tap(coordinate, duration: press)
            }
        }
        return delivery
    }

    /// A pinch has no XCUICoordinate route here: a delivery without a synthesized point tells the
    /// caller to run the main-screen pinch synthesis, which is unchanged off the multi-panel path.
    /// Each finger endpoint is computed in observed space and mapped like a tap point, so the
    /// rotated inner panel receives the pinch axis and center the host observed.
    func deliverPinch(
        center: GesturePoint, distanceStart: Double, distanceEnd: Double, rotationDegrees: Double,
        duration: TimeInterval, beforeAction: (DisplayGestureDelivery<Provider.Coordinate>) -> Void = { _ in }
    )
        throws -> DisplayGestureDelivery<Provider.Coordinate>
    {
        let selected = selection(point: center, forced: nil)
        var fallback: TapCoordinateStrategy?
        if selected.strategy.targetsDisplay, let displayId = target.displayId {
            let observed = observedPinchPaths(
                center: center, distanceStart: distanceStart, distanceEnd: distanceEnd,
                rotationDegrees: rotationDegrees
            )
            let map = { (path: DisplayFingerPath) -> DisplayFingerPath? in
                guard let start = point(path.start, selection: selected),
                      let end = point(path.end, selection: selected) else { return nil }
                let via = path.via.compactMap { point($0, selection: selected) }
                guard via.count == path.via.count else { return nil }
                return DisplayFingerPath(start: start, end: end, via: via)
            }
            let orientation = selected.strategy == .displayTargeted ? 1 :
                DeviceRotation.gestureInterfaceOrientationRawValue(rotation: geometry?.rotation)
            if let first = map(observed.first), let second = map(observed.second),
               let mappedCenter = point(center, selection: selected), let orientation
            {
                let candidate = DisplayGestureDelivery<Provider.Coordinate>(
                    selection: selected, coordinate: nil, synthesizedPoint: mappedCenter,
                    synthesizedInterfaceOrientation: orientation, fallbackFrom: nil
                )
                beforeAction(candidate)
                if try provider.synthesizePinch(DisplayPinch(
                    first: first, second: second, duration: duration, displayId: displayId,
                    interfaceOrientation: orientation
                )) { return candidate }
            }
            fallback = selected.strategy
        }
        // beforeAction runs only for the synthesized route; the caller marks its own main-screen phase.
        return DisplayGestureDelivery<Provider.Coordinate>(
            selection: selected.strategy.targetsDisplay
                ? GestureCoordinateSelection.choose(point: center, geometry: geometry) : selected,
            coordinate: nil, synthesizedPoint: nil, synthesizedInterfaceOrientation: nil, fallbackFrom: fallback
        )
    }

    /// Like pinch, an unsynthesized delivery asks the caller to retain main-screen path synthesis.
    func deliverPath(
        points: [PathGesturePoint],
        beforeAction: (DisplayGestureDelivery<Provider.Coordinate>) -> Void = { _ in }
    )
        throws -> DisplayGestureDelivery<Provider.Coordinate>
    {
        let points = try PathGesturePlan.validate(points)
        let start = GesturePoint(x: points[0].x, y: points[0].y)
        let selected = selection(point: start, forced: nil)
        var fallback: TapCoordinateStrategy?
        if selected.strategy.targetsDisplay, let displayId = target.displayId {
            let mapped = points.compactMap { vertex -> PathGesturePoint? in
                guard let mapped = point(GesturePoint(x: vertex.x, y: vertex.y), selection: selected) else {
                    return nil
                }
                return PathGesturePoint(x: mapped.x, y: mapped.y, offsetMs: vertex.offsetMs)
            }
            let orientation = selected.strategy == .displayTargeted ? 1 :
                DeviceRotation.gestureInterfaceOrientationRawValue(rotation: geometry?.rotation)
            if mapped.count == points.count, let orientation {
                let candidate = DisplayGestureDelivery<Provider.Coordinate>(
                    selection: selected, coordinate: nil,
                    synthesizedPoint: GesturePoint(x: mapped[0].x, y: mapped[0].y),
                    synthesizedInterfaceOrientation: orientation, fallbackFrom: nil
                )
                beforeAction(candidate)
                if try provider.synthesizePath(DisplayPath(
                    points: mapped, displayId: displayId, interfaceOrientation: orientation
                )) { return candidate }
            }
            fallback = selected.strategy
        }
        return DisplayGestureDelivery<Provider.Coordinate>(
            selection: selected.strategy.targetsDisplay
                ? GestureCoordinateSelection.choose(point: start, geometry: geometry) : selected,
            coordinate: nil, synthesizedPoint: nil, synthesizedInterfaceOrientation: nil, fallbackFrom: fallback
        )
    }

    func annotate<Coordinate>(_ diagnostics: inout TapDiagnostics, delivery: DisplayGestureDelivery<Coordinate>) {
        diagnostics.strategy = delivery.selection.strategy.rawValue
        diagnostics.strategyReason = delivery.selection.reason
        if delivery.selection.strategy != .legacy {
            diagnostics.normalizedOffset = .init(
                x: delivery.selection.normalized.x, y: delivery.selection.normalized.y
            )
        }
        diagnostics.route = delivery.route
        diagnostics.targetDisplayId = target.displayId
        diagnostics.targetDisplayReason = target.reason
        diagnostics.deviceIdiom = inventory.map { $0.isPhoneIdiom ? "phone" : "other" }
        diagnostics.mainDisplayId = inventory?.mainDisplayId
        diagnostics.applicationDisplayId = inventory?.applicationDisplayId
        diagnostics.screens = inventory?.screens
        diagnostics.synthesizedPoint = delivery.synthesizedPoint.map { .init(x: $0.x, y: $0.y) }
        diagnostics.synthesizedInterfaceOrientation = delivery.synthesizedInterfaceOrientation
        diagnostics.fallbackFrom = delivery.fallbackFrom?.rawValue
        diagnostics.deliveryWarning = mismatch && delivery.route == .xcuiCoordinate ? .eventDisplayMismatch : nil
    }
}
