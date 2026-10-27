import Foundation

/// Device media items (#14192): an `image` `asset`, or a tab item `image`, of the form
/// `{data: "/pointer"}` names a device media item held in `/data`. The spec-language gate
/// `prototype_platform_media_items_v1` covers it; it is not a platform module. The device store
/// and the pointer resolution follow in the runtime slice.
enum PrototypeMediaItems {
    static let capability = "prototype_platform_media_items_v1"
    /// Ids the device mints for its own media items; a host asset id may not start with it.
    static let idPrefix = "media:"

    static func isMediaId(_ id: String) -> Bool { id.hasPrefix(idPrefix) }

    /// Whether a node's `asset` (image) or any `items[].image` binds a data pointer.
    static func usedBy(_ node: [String: JSONValue]) -> Bool {
        func bound(_ value: JSONValue?) -> Bool { value?.objectFields?["data"] != nil }
        if node["type"] == .string("image"), bound(node["asset"]) { return true }
        guard case let .array(items)? = node["items"] else { return false }
        return items.contains { bound($0.objectFields?["image"]) }
    }
}
