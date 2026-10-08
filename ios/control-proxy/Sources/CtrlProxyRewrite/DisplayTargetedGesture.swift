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

/// Taps and single-finger swipes use this route. The host sends long presses as taps with
/// a press duration and double taps as two taps. Other gestures keep their existing paths.
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
        velocity: Double? = nil, forced: TapCoordinateStrategy? = nil,
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
                    displayId: displayId, interfaceOrientation: orientation
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
            try provider.drag(coordinate, to: endCoordinate, press: press, velocity: velocity, hold: 0)
        } else {
            beforeAction(delivery)
            try provider.tap(coordinate, duration: press)
        }
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
