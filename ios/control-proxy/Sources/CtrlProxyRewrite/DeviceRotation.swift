import Foundation

/// Maps platform orientation observations to the rotation epoch shared by hierarchy
/// and screenshot frames. A value is intentionally absent when the platform cannot
/// identify an interface rotation.
///
/// PHASE 1: only the platform-agnostic `fromOrientationName` mapping is ported here.
/// The main-bound members (the `UIDevice`/`XCUIDevice` sampler, the orientation-change
/// signal, `currentGestureInterfaceOrientation`, `gestureInterfaceOrientation`) are
/// inherently UIKit/XCUITest and land with the @MainActor gesture/rotation work in a
/// later phase.
enum DeviceRotation {
    static func fromOrientationName(_ orientation: String) -> Int? {
        switch orientation {
        case "portrait": return 0
        case "landscape_left": return 1
        case "portrait_upside_down": return 2
        case "landscape_right": return 3
        default: return nil
        }
    }
}
