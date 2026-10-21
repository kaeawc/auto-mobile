/// Detents retain author order; fixed points never exceed the container height.
func prototypeSheetHeights(detents: [Detent], containerHeight: Double) -> [Double] {
    detents.map { $0.height(in: containerHeight) }
}

/// Positive drag is downward. Snapping ties retain author order, as on Android.
/// Empty detents leave the sheet unchanged; the renderer disables dragging in that case.
func settlePrototypeSheet(heights: [Double], current: Double, drag: Double, dismissOnSwipe: Bool) -> Double? {
    guard let smallest = heights.min() else { return current }
    let desired = current - drag
    if dismissOnSwipe, desired < smallest / 2 { return nil }
    return heights.min { abs($0 - desired) < abs($1 - desired) }
}
