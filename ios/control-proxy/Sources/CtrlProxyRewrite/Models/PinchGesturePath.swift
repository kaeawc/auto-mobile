import Foundation

/// Which mechanism performed a pinch gesture.
///
/// `pinchOn` prefers the private XCTest event-path synthesis because it honors an
/// arbitrary `centerX`/`centerY`. When those private symbols are unavailable it
/// falls back to the public, element-anchored `pinch(withScale:velocity:)`, which
/// still zooms but centers on the anchor element. Callers use this to know whether
/// the requested center was respected (issue #2910).
///
/// Wire-visible: the raw values `"event-path"` / `"element-anchored"` are returned
/// in the `pinch_result` response and must be preserved verbatim.
public enum PinchGesturePath: String, Codable, Equatable, Sendable {
    /// Private `XCPointerEventPath`/`XCSynthesizedEventRecord` synthesis — honors center.
    case eventPath = "event-path"
    /// Public `XCUIElement.pinch(withScale:velocity:)` — center-less, anchor-centered.
    case elementAnchored = "element-anchored"
}
