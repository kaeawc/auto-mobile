import Foundation

// Element anchors (#9316): the host resolves every `{type: "element"}` anchor against the app's
// own hierarchy before sending, so the agent only ever positions `{type: "bounds"}` anchors. iOS
// hierarchy bounds are points, the unit every spec size uses on iOS, so bounds arrive as screen
// points with no density conversion. Mirrors Android's `OverlayAnchorLayout.kt` and the
// window-level anchor layer of #10803.

/// `cover` lays the node over the anchor bounds; the edges align the same node edge to them.
enum OverlayAnchorAlignment: String, Decodable, Equatable {
    case cover
    case top
    case bottom
    case start
    case end
}

/// A rectangle in points: screen space for anchor bounds, a layer's own space once placed.
struct OverlayRect: Decodable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

extension OverlayRect {
    /// The overlap with `other`, or nil when they do not meet. Used to clip an anchored node's touch
    /// target to the area it may draw in (a sheet's frame).
    func intersection(_ other: OverlayRect) -> OverlayRect? {
        let left = Swift.max(x, other.x)
        let top = Swift.max(y, other.y)
        let right = Swift.min(x + width, other.x + other.width)
        let bottom = Swift.min(y + height, other.y + other.height)
        guard right > left, bottom > top else { return nil }
        return OverlayRect(x: left, y: top, width: right - left, height: bottom - top)
    }
}

/// Where a `sheet` placement sits in the overlay window: full width, `height` tall (200 pt when the
/// spec sets none, never taller than the window), against the top or bottom edge. Android clips
/// everything outside a sheet window, so the anchor layer is clipped to this rectangle (#10912).
/// A bottom sheet raised by the keyboard (`OverlayKeyboardLift`) moves up by `lift`, never past the
/// top of the window; a top sheet ignores it.
enum OverlaySheetFrame {
    static let defaultHeight = 200.0

    static func rect(containerWidth: Double, containerHeight: Double, edge: String?, height: Double?, lift: Double = 0) -> OverlayRect {
        let sheetHeight = Swift.min(Swift.max(height ?? defaultHeight, 0), containerHeight)
        let y = edge == "top" ? 0 : Swift.max(containerHeight - sheetHeight - Swift.max(lift, 0), 0)
        return OverlayRect(x: 0, y: y, width: containerWidth, height: sheetHeight)
    }
}

/// A node's `anchor` as the wire carries it. Only a bounds anchor can be drawn; an element anchor
/// that reaches the agent was never resolved by the host and is refused (see `unresolvedAnchorPath`).
struct OverlayAnchor: Decodable, Equatable {
    /// Screen bounds in points; nil for an unresolved element anchor.
    let bounds: OverlayRect?
    let alignment: OverlayAnchorAlignment
    let offsetX: Double
    let offsetY: Double

    private enum CodingKeys: String, CodingKey {
        case type, bounds, alignment, offset
    }

    private struct Shift: Decodable {
        let x: Double
        let y: Double
    }

    init(bounds: OverlayRect?, alignment: OverlayAnchorAlignment = .cover, offsetX: Double = 0, offsetY: Double = 0) {
        self.bounds = bounds
        self.alignment = alignment
        self.offsetX = offsetX
        self.offsetY = offsetY
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "bounds":
            bounds = try container.decode(OverlayRect.self, forKey: .bounds)
        case "element":
            bounds = nil
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "anchor.type must be bounds or element, not \(type)"
            )
        }
        // Android's `OverlayAnchorAlignment.fromWire`: absent is cover, an unknown value fails.
        alignment = try container.decodeIfPresent(OverlayAnchorAlignment.self, forKey: .alignment) ?? .cover
        let shift = try container.decodeIfPresent(Shift.self, forKey: .offset)
        offsetX = shift?.x ?? 0
        offsetY = shift?.y ?? 0
    }

    /// Whether the node is laid over the bounds and sized to them, ignoring its authored size.
    var covers: Bool {
        alignment == .cover
    }

    /// The anchored node's screen rectangle in points. Cover adopts the bounds; an edge alignment
    /// keeps the node's measured `nodeWidth` x `nodeHeight`, puts its matching edge on the bounds'
    /// edge and centres it along the other axis. Start and end follow `rightToLeft`. The offset is
    /// applied last, in screen axes. Nil for an unresolved element anchor.
    func screenRect(nodeWidth: Double, nodeHeight: Double, rightToLeft: Bool) -> OverlayRect? {
        guard let bounds else { return nil }
        let centredX = bounds.x + (bounds.width - nodeWidth) / 2
        let centredY = bounds.y + (bounds.height - nodeHeight) / 2
        let leading = bounds.x
        let trailing = bounds.x + bounds.width - nodeWidth
        let origin: (x: Double, y: Double)
        var size = (width: nodeWidth, height: nodeHeight)
        switch alignment {
        case .cover:
            origin = (bounds.x, bounds.y)
            size = (bounds.width, bounds.height)
        case .top:
            origin = (centredX, bounds.y)
        case .bottom:
            origin = (centredX, bounds.y + bounds.height - nodeHeight)
        case .start:
            origin = (rightToLeft ? trailing : leading, centredY)
        case .end:
            origin = (rightToLeft ? leading : trailing, centredY)
        }
        return OverlayRect(x: origin.x + offsetX, y: origin.y + offsetY, width: size.width, height: size.height)
    }

    /// The node's rectangle in the space of the layer drawing it, whose own (0, 0) sits at
    /// `layerOriginX`, `layerOriginY` on screen: the overlay window's screen origin plus the layer's
    /// position in that window (below a fullscreen dismiss bar, for one). Anchors are screen
    /// coordinates, so the layer's origin is subtracted once and nothing else is.
    func layerRect(
        nodeWidth: Double,
        nodeHeight: Double,
        rightToLeft: Bool,
        layerOriginX: Double,
        layerOriginY: Double
    ) -> OverlayRect? {
        screenRect(nodeWidth: nodeWidth, nodeHeight: nodeHeight, rightToLeft: rightToLeft).map {
            OverlayRect(x: $0.x - layerOriginX, y: $0.y - layerOriginY, width: $0.width, height: $0.height)
        }
    }
}

/// An anchored node and its spec path, spelled as host validation errors spell it.
struct OverlayAnchoredNode {
    let node: OverlayNode
    let path: String
    let anchor: OverlayAnchor
    /// False while an animated `visibleWhen` ancestor is hiding: the node stays listed so it can
    /// fade out with that ancestor (and back in) instead of vanishing on the first frame (#10912).
    var ancestorsShown = true
}

/// Roles that render their children inline through `NodeView`; other roles never draw children, so
/// an anchored node below them is not listed (as Android's `OVERLAY_INLINE_CONTAINER_ROLES`, plus
/// iOS's inline `bottomSheet`, which Android shows as a modal).
private let overlayInlineContainerTypes: Set<String> = ["box", "row", "column", "scroll", "card", "pager", "bottomSheet"]

extension OverlayNode {
    /// Child nodes in tree order with their paths: `child`, else `children` (the spec contract).
    func childEntries(path: String) -> [(node: OverlayNode, path: String)] {
        if let child { return [(child, "\(path).child")] }
        return (children ?? []).enumerated().map { ($0.element, "\(path).children[\($0.offset)]") }
    }

    /// The first anchor below and including this node that the host never resolved, as its path.
    func unresolvedAnchorPath(path: String = "root") -> String? {
        if let anchor, anchor.bounds == nil { return "\(path).anchor" }
        for entry in childEntries(path: path) {
            if let found = entry.node.unresolvedAnchorPath(path: entry.path) { return found }
        }
        return nil
    }

    /// The anchored nodes below this node that the renderer draws in a window-level layer above the
    /// author tree (#10803), in tree order. Drawn inside their parents they would take a slot there
    /// and be clipped to it. A node is listed when every ancestor below this node is shown: visible,
    /// on its pager's current page, an open `bottomSheet`, and not inside a modal (modals list their
    /// own through `layeredAnchors(in:)`). The anchored node's own `visibleWhen` is left to the
    /// renderer. This node itself is never listed: a window root keeps its own anchored placement.
    ///
    /// With `retainExiting`, a node below an ancestor whose `visibleWhen` fails is still listed, as
    /// `ancestorsShown == false`, so the renderer can fade it with that ancestor's exit (Android's
    /// #10897). The outermost hidden ancestor decides: a `none` transition removes its subtree at
    /// once, so nothing below it is retained. Callers pass `retainExiting` only when motion is on.
    func layeredAnchors(
        path: String = "root",
        state: [String: JSONValue],
        pages: [String: Int],
        retainExiting: Bool = false
    ) -> [OverlayAnchoredNode] {
        layeredAnchors(path: path, state: state, pages: pages, retainExiting: retainExiting, shown: true)
    }

    private func layeredAnchors(
        path: String,
        state: [String: JSONValue],
        pages: [String: Int],
        retainExiting: Bool,
        shown: Bool
    ) -> [OverlayAnchoredNode] {
        var shown = shown
        if shown, let visibleWhen, !visibleWhen.holds(state) {
            guard retainExiting, transition != "none" else { return [] }
            shown = false
        }
        guard overlayInlineContainerTypes.contains(type) else { return [] }
        if type == "bottomSheet", !(openWhen?.holds(state) ?? false) { return [] }
        var entries = childEntries(path: path)
        if type == "pager" {
            // The renderer's clamp: a page past the end shows the last one.
            let page = Swift.min(id.flatMap { pages[$0] } ?? 0, Swift.max(entries.count - 1, 0))
            entries = entries.indices.contains(page) ? [entries[page]] : []
        }
        return OverlayNode.layeredAnchors(
            in: entries, state: state, pages: pages, retainExiting: retainExiting, ancestorsShown: shown
        )
    }

    /// `layeredAnchors` for content drawn as `entries`, such as a modal's body.
    static func layeredAnchors(
        in entries: [(node: OverlayNode, path: String)],
        state: [String: JSONValue],
        pages: [String: Int],
        retainExiting: Bool = false,
        ancestorsShown: Bool = true
    ) -> [OverlayAnchoredNode] {
        entries.flatMap { entry -> [OverlayAnchoredNode] in
            let own = entry.node.anchor.map {
                [OverlayAnchoredNode(node: entry.node, path: entry.path, anchor: $0, ancestorsShown: ancestorsShown)]
            } ?? []
            return own + entry.node.layeredAnchors(
                path: entry.path, state: state, pages: pages, retainExiting: retainExiting, shown: ancestorsShown
            )
        }
    }

    /// Everything the shown spec draws in its window-level anchor layer: the root when it is
    /// anchored (iOS has no window to move onto it, so the layer places it), then the layered nodes.
    func windowAnchorLayer(
        state: [String: JSONValue],
        pages: [String: Int],
        retainExiting: Bool = false
    ) -> [OverlayAnchoredNode] {
        let own = anchor.map { [OverlayAnchoredNode(node: self, path: "root", anchor: $0)] } ?? []
        return own + layeredAnchors(state: state, pages: pages, retainExiting: retainExiting)
    }
}
