import Foundation

/// The modal nodes (dialogs, bottom sheets, ...) declared in a lazy `list` row template. Rows are
/// decoded on demand by the visible cells, which draw no modal in place, so the modal layer needs its
/// own decoded copies. A row whose resolved JSON is unchanged keeps its node, so view identity and the
/// layer's retained state survive a re-render.
final class PrototypeLazyModalRows {
    private var rows: [Int: (json: JSONValue, node: PrototypeNode)] = [:]
    private var templateHasModal: Bool?

    /// The decoded rows of `list`, empty unless it is a lazy list whose template declares a modal.
    func nodes(of list: PrototypeNode, data: [String: JSONValue]?) -> [PrototypeNode] {
        guard list.type == "list", let template = list.listRowTemplate else { return [] }
        if templateHasModal == nil { templateHasModal = Self.declaresModal(template) }
        guard templateHasModal == true else { return [] }
        let count = PrototypeLazyList.keys(node: list, data: data).count
        var next: [Int: (json: JSONValue, node: PrototypeNode)] = [:]
        for index in 0 ..< count {
            guard let resolved = PrototypeLazyList.resolvedRow(node: list, data: data, index: index) else { continue }
            if let cached = rows[index], cached.json == resolved.json {
                next[index] = cached
            } else if let node = try? JSONDecoder().decode(
                PrototypeNode.self, from: JSONEncoder().encode(resolved.json)
            ) {
                // A malformed row is skipped here; its visible cell already warns once.
                next[index] = (resolved.json, node)
            }
        }
        rows = next
        return next.keys.sorted().compactMap { next[$0]?.node }
    }

    private static func declaresModal(_ value: JSONValue) -> Bool {
        switch value {
        case let .object(fields):
            if case let .string(type)? = fields["type"], prototypeModalTypes.contains(type) { return true }
            return fields.values.contains(where: declaresModal)
        case let .array(items):
            return items.contains(where: declaresModal)
        default:
            return false
        }
    }
}

/// Where a modal bottom sheet lays out and draws its scrim: the prototype window's frame for the
/// placement, not the whole screen (Android keeps the sheet inside the prototype window too).
enum PrototypeModalSheetFrame {
    /// - Parameters:
    ///   - contentFrame: the floating root's reported window frame, when it has one.
    ///   - lift: the placement's keyboard lift (nonzero only for a bottom-edge `sheet`, which moves whole).
    ///   - keyboardTop: the software keyboard's top edge in window coordinates, nil without one.
    static func container(
        placementType: String,
        edge: String?,
        height: Double?,
        contentFrame: PrototypeRect?,
        windowWidth: Double,
        windowHeight: Double,
        lift: Double,
        keyboardTop: Double?
    )
        -> PrototypeRect
    {
        let window = PrototypeRect(x: 0, y: 0, width: windowWidth, height: windowHeight)
        let base: PrototypeRect
        switch placementType {
        case "sheet":
            let moves = PrototypeKeyboardLift.appliesTo(placementType: placementType, edge: edge)
            base = PrototypeSheetFrame.rect(
                containerWidth: windowWidth, containerHeight: windowHeight, edge: edge, height: height,
                lift: moves ? lift : 0
            )
            // A bottom-edge sheet window already rose above the keyboard.
            if moves { return base }
        case "floating":
            base = contentFrame ?? window
        default:
            base = window
        }
        // Other windows do not move: the sheet's room ends where the keyboard begins.
        guard let keyboardTop, keyboardTop > base.y, keyboardTop < base.y + base.height else { return base }
        return PrototypeRect(x: base.x, y: base.y, width: base.width, height: keyboardTop - base.y)
    }
}
