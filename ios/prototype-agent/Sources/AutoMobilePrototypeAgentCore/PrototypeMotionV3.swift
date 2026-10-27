import Foundation

/// Authored node vocabulary, shared by strict and bundle capability collection.
enum PrototypeMotionV3 {
    static let capability = "prototype_motion_v3"
    static func required(_ node: [String: JSONValue]) -> Bool {
        node["press"] != nil || (node["animate"] != nil &&
            (layout(node["style"]) || styles(node["styleWhen"]).contains { layout($0.objectFields?["style"]) }))
    }

    private static func styles(_ value: JSONValue?) -> [JSONValue] {
        if case let .array(items)? = value { return items }; return []
    }

    private static func layout(_ value: JSONValue?) -> Bool {
        guard let style = value?.objectFields else { return false }
        let border = style["border"]?.objectFields ?? [:]
        return ["cornerRadius", "elevation", "shadowColor", "padding"].contains { style[$0] != nil } ||
            border["color"] != nil || border["width"] != nil ||
            ["width", "height"].contains { style[$0]?.objectFields?["dp"] != nil }
    }
}
