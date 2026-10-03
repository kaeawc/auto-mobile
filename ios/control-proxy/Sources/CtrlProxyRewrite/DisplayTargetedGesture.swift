import Foundation

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
    let displayId: UInt64
    let interfaceOrientation: Int
}

/// A false result means symbols unavailable; genuine errors must throw.
@MainActor
protocol DisplayGestureProviding: GestureCoordinateProviding {
    var cachedGeometry: GestureCoordinateGeometry? { get }
    func displayInventory() -> GestureDisplayInventory
    func synthesize(_ touch: DisplayTouch) throws -> Bool
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

/// A short gap between display-targeted taps; coordinate double taps retain XCUITest's timing.
let doubleTapInterTapGap: TimeInterval = 0.05

/// Taps, long presses, double taps and single-finger swipes opt into this route. The existing
/// factory remains the unchanged path for drag, pinch and multi-finger gestures.
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
                normalized: selected.normalized, offset: selected.offset
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

    private func displayTouch(
        start: GesturePoint, end: GesturePoint, press: TimeInterval, move: TimeInterval,
        selection: GestureCoordinateSelection, endSelection: GestureCoordinateSelection
    )
        -> (touch: DisplayTouch?, fallbackFrom: TapCoordinateStrategy?)
    {
        guard selection.strategy.targetsDisplay,
              let displayId = inventory?.target.displayId,
              let startPoint = point(start, selection: selection),
              let endPoint = point(end, selection: endSelection)
        else { return (nil, nil) }
        let orientation = selection.strategy == .displayTargeted ? 1 :
            DeviceRotation.gestureInterfaceOrientationRawValue(rotation: geometry?.rotation)
        guard let orientation else { return (nil, selection.strategy) }
        return (DisplayTouch(
            start: startPoint, end: endPoint, pressDuration: press, moveDuration: move,
            displayId: displayId, interfaceOrientation: orientation
        ), selection.strategy)
    }

    func deliver(
        start: GesturePoint, end: GesturePoint? = nil, press: TimeInterval, move: TimeInterval = 0,
        velocity: Double? = nil, forced: TapCoordinateStrategy? = nil,
        beforeAction: (DisplayGestureDelivery<Provider.Coordinate>) -> Void = { _ in }
    )
        throws -> DisplayGestureDelivery<Provider.Coordinate>
    {
        var selected = selection(point: start, forced: forced)
        let endSelection = selection(point: end ?? start, forced: forced)
        let display = displayTouch(
            start: start, end: end ?? start, press: press, move: move,
            selection: selected, endSelection: endSelection
        )
        if let touch = display.touch {
            let candidate = DisplayGestureDelivery<Provider.Coordinate>(
                selection: selected, coordinate: nil, synthesizedPoint: touch.start,
                synthesizedInterfaceOrientation: touch.interfaceOrientation, fallbackFrom: nil
            )
            beforeAction(candidate)
            if try provider.synthesize(touch) { return candidate }
        }
        if selected.strategy.targetsDisplay {
            selected = GestureCoordinateSelection.choose(point: start, geometry: geometry)
        }
        let coordinate = try provider.coordinate(selection: selected)
        let delivery = DisplayGestureDelivery(
            selection: selected, coordinate: coordinate, synthesizedPoint: nil,
            synthesizedInterfaceOrientation: nil, fallbackFrom: display.fallbackFrom
        )
        if let end {
            let selectedEnd = GestureCoordinateSelection.choose(point: end, geometry: geometry)
            let endCoordinate = try provider.coordinate(selection: selectedEnd)
            beforeAction(delivery)
            try provider.drag(coordinate, to: endCoordinate, press: press, velocity: velocity, hold: 0)
        } else {
            beforeAction(delivery)
            try provider.tap(coordinate, duration: press)
        }
        return delivery
    }

    func deliverDoubleTap(
        start: GesturePoint, gap: TimeInterval = doubleTapInterTapGap,
        pause: (TimeInterval) throws -> Void, forced: TapCoordinateStrategy? = nil,
        beforeAction: (DisplayGestureDelivery<Provider.Coordinate>) -> Void = { _ in }
    )
        throws -> DisplayGestureDelivery<Provider.Coordinate>
    {
        var selected = selection(point: start, forced: forced)
        let display = displayTouch(
            start: start, end: start, press: 0, move: 0, selection: selected, endSelection: selected
        )
        if let touch = display.touch {
            let candidate = DisplayGestureDelivery<Provider.Coordinate>(
                selection: selected, coordinate: nil, synthesizedPoint: touch.start,
                synthesizedInterfaceOrientation: touch.interfaceOrientation, fallbackFrom: nil
            )
            beforeAction(candidate)
            if try provider.synthesize(touch) {
                try pause(gap)
                // Once the first tap succeeds, any failure must stop without delivering extra taps.
                guard try provider.synthesize(touch) else {
                    throw GesturePerformer.GestureError.gestureFailed("second double-tap synthesis unavailable")
                }
                return candidate
            }
        }
        if selected.strategy.targetsDisplay {
            selected = GestureCoordinateSelection.choose(point: start, geometry: geometry)
        }
        let coordinate = try provider.coordinate(selection: selected)
        let delivery = DisplayGestureDelivery(
            selection: selected, coordinate: coordinate, synthesizedPoint: nil,
            synthesizedInterfaceOrientation: nil, fallbackFrom: display.fallbackFrom
        )
        beforeAction(delivery)
        try provider.doubleTap(coordinate)
        return delivery
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
