import Foundation
import ObjCExceptionCatcher

struct GestureDisplayInventory: Equatable, Sendable {
    let screens: [TapDiagnostics.DisplayScreen]
    let applicationDisplayId: UInt64?
    let isPhoneIdiom: Bool

    var mainDisplayId: UInt64? { screens.first(where: { $0.isMain })?.displayId }

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

struct DisplayFingerPath: Equatable, Sendable {
    let start: GesturePoint
    let end: GesturePoint
}

/// Two simultaneous finger paths in display space; both move for `duration`, then lift.
struct DisplayPinch: Equatable, Sendable {
    let first: DisplayFingerPath
    let second: DisplayFingerPath
    let duration: TimeInterval
    let displayId: UInt64
    let interfaceOrientation: Int
}

/// The observed-space pinch endpoints. Degenerate distances get the same 1pt floor the
/// main-screen synthesis applies, and the trig is the shared `computePinchPoints` (#2979).
func observedPinchPaths(
    center: GesturePoint, distanceStart: Double, distanceEnd: Double, rotationDegrees: Double
)
    -> (first: DisplayFingerPath, second: DisplayFingerPath)
{
    let points = ObjCExceptionCatcher_computePinchPoints(
        CGFloat(center.x), CGFloat(center.y), CGFloat(max(distanceStart, 1)), CGFloat(max(distanceEnd, 1)),
        CGFloat(rotationDegrees)
    )
    func point(_ value: CGPoint) -> GesturePoint { GesturePoint(x: Double(value.x), y: Double(value.y)) }
    return (
        DisplayFingerPath(start: point(points.start1), end: point(points.end1)),
        DisplayFingerPath(start: point(points.start2), end: point(points.end2))
    )
}

/// A false result means symbols unavailable; genuine errors must throw.
@MainActor
protocol DisplayGestureProviding: GestureCoordinateProviding {
    var cachedGeometry: GestureCoordinateGeometry? { get }
    func displayInventory() -> GestureDisplayInventory
    func synthesize(_ touch: DisplayTouch) throws -> Bool
    func synthesizePinch(_ pinch: DisplayPinch) throws -> Bool
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

/// Taps, single-finger swipes, drags and two-finger pinches use this route. The host sends long
/// presses as taps with a press duration and double taps as two taps. Other gestures keep their
/// existing paths.
@MainActor
struct DisplayGestureFactory<Provider: DisplayGestureProviding> {
    let provider: Provider
    let geometry: GestureCoordinateGeometry?
    let inventory: GestureDisplayInventory?

    var mismatch: Bool {
        (geometry ?? provider.cachedGeometry).map { hasMultiPanelMismatch(app: $0.app, screen: $0.screen) } == true
    }

    init(provider: Provider, forced: TapCoordinateStrategy? = nil) throws {
        self.provider = provider
        // Forced legacy inspects only the observation cache, without live geometry reads.
        geometry = forced == .legacy ? provider.cachedGeometry : try provider.geometry()
        let mismatch = (geometry ?? provider.cachedGeometry)
            .map { hasMultiPanelMismatch(app: $0.app, screen: $0.screen) } == true
        inventory = mismatch || forced?.targetsDisplay == true ? provider.displayInventory() : nil
    }

    func selection(point: GesturePoint, forced: TapCoordinateStrategy?) -> GestureCoordinateSelection {
        let strategy: TapCoordinateStrategy?
        if let forced, !forced.targetsDisplay {
            strategy = forced
        } else if mismatch || forced?.targetsDisplay == true, inventory?.target.displayId != nil {
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
        switch geometry.rotation {
        case 0: return observed
        case 1: return GesturePoint(x: observed.y, y: geometry.app.height - observed.x)
        case 3: return GesturePoint(x: geometry.app.width - observed.y, y: observed.x)
        default: return nil
        }
    }

    func deliver(
        start: GesturePoint, end: GesturePoint? = nil, press: TimeInterval, move: TimeInterval = 0,
        hold: TimeInterval = 0, velocity: Double? = nil, forced: TapCoordinateStrategy? = nil,
        beforeAction: (DisplayGestureDelivery<Provider.Coordinate>) -> Void = { _ in }
    )
        throws -> DisplayGestureDelivery<Provider.Coordinate>
    {
        var selected = selection(point: start, forced: forced)
        let endSelection = selection(point: end ?? start, forced: forced)
        var fallback: TapCoordinateStrategy?
        if selected.strategy.targetsDisplay,
           let displayId = inventory?.target.displayId,
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
                if try provider.synthesize(DisplayTouch(
                    start: startPoint, end: endPoint, pressDuration: press, moveDuration: move,
                    holdDuration: hold, displayId: displayId, interfaceOrientation: orientation
                )) { return candidate }
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
            try provider.tap(coordinate, duration: press)
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
        if selected.strategy.targetsDisplay, let displayId = inventory?.target.displayId {
            let observed = observedPinchPaths(
                center: center, distanceStart: distanceStart, distanceEnd: distanceEnd,
                rotationDegrees: rotationDegrees
            )
            let map = { (path: DisplayFingerPath) -> DisplayFingerPath? in
                guard let start = point(path.start, selection: selected),
                      let end = point(path.end, selection: selected) else { return nil }
                return DisplayFingerPath(start: start, end: end)
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

    func annotate<Coordinate>(_ diagnostics: inout TapDiagnostics, delivery: DisplayGestureDelivery<Coordinate>) {
        diagnostics.strategy = delivery.selection.strategy.rawValue
        diagnostics.strategyReason = delivery.selection.reason
        if delivery.selection.strategy != .legacy {
            diagnostics.normalizedOffset = .init(
                x: delivery.selection.normalized.x, y: delivery.selection.normalized.y
            )
        }
        diagnostics.route = delivery.route
        diagnostics.targetDisplayId = inventory?.target.displayId
        diagnostics.targetDisplayReason = inventory?.target.reason ?? "notSampled"
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
