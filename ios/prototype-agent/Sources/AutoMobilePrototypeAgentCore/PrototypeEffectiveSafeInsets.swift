import Foundation

/// UIKit-free edge values for window/content geometry.
struct PrototypeSafeInsets: Equatable {
    var top: CGFloat = 0
    var left: CGFloat = 0
    var bottom: CGFloat = 0
    var right: CGFloat = 0
}

/// SwiftUI may report zero view insets even when its content overlaps a window's unsafe edges.
/// Count only actual overlap; a view wholly inside the safe rectangle needs no extra padding.
/// Invalid rectangles contribute no overlap, while valid view-reported insets are retained.
func prototypeEffectiveSafeInsets(
    viewFrameInWindow: CGRect, windowBounds: CGRect,
    windowInsets: PrototypeSafeInsets, viewInsets: PrototypeSafeInsets
)
    -> PrototypeSafeInsets
{
    func nonnegative(_ value: CGFloat) -> CGFloat { value.isFinite ? max(0, value) : 0 }
    let reported = PrototypeSafeInsets(
        top: nonnegative(viewInsets.top), left: nonnegative(viewInsets.left),
        bottom: nonnegative(viewInsets.bottom), right: nonnegative(viewInsets.right)
    )
    func valid(_ rect: CGRect) -> Bool {
        !rect.isNull && !rect.isInfinite && rect.origin.x.isFinite && rect.origin.y.isFinite &&
            rect.size.width.isFinite && rect.size.height.isFinite && rect.size.width > 0 && rect.size.height > 0
    }
    guard valid(viewFrameInWindow), valid(windowBounds) else { return reported }
    let visible = viewFrameInWindow.intersection(windowBounds)
    guard !visible.isNull, !visible.isEmpty else { return reported }
    let top = min(windowBounds.height, nonnegative(windowInsets.top))
    let bottom = min(windowBounds.height, nonnegative(windowInsets.bottom))
    let left = min(windowBounds.width, nonnegative(windowInsets.left))
    let right = min(windowBounds.width, nonnegative(windowInsets.right))
    return PrototypeSafeInsets(
        top: max(reported.top, min(visible.height, max(0, windowBounds.minY + top - visible.minY))),
        left: max(reported.left, min(visible.width, max(0, windowBounds.minX + left - visible.minX))),
        bottom: max(reported.bottom, min(visible.height, max(0, visible.maxY - (windowBounds.maxY - bottom)))),
        right: max(reported.right, min(visible.width, max(0, visible.maxX - (windowBounds.maxX - right))))
    )
}
