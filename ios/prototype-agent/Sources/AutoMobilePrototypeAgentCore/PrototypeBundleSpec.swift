import Foundation

struct PrototypeBundleReferences {
    var images: [PrototypeBundleID] = []
    var fonts: [PrototypeBundleID] = []

    init(_ bytes: Data) throws {
        let json = try PrototypeBundleJSON(bytes, code: .specInvalidJSON, path: "spec.json")
        do {
            try PrototypeContractValidator.validate(data: json.data)
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: json.data)
        } catch { throw PrototypeBundleFailure(.specInvalid, "spec.json") }
        // SavedLayout's collectors combine fonts/images, use canonically comparing Set<String>,
        // and visit the renderer's expanded repeat tree. Transport needs separate exact IDs and
        // authored templates even when a repeat currently has no rows. Keep the same asset slots
        // while visiting the validated authored tree, never opaque data or unused components.
        guard let root = json.value.objectFields?["root"] else { return }
        collect(root, path: "$.root", keys: json.objectKeys)
        var imageIDs = Set<PrototypeBundleID>()
        var fontIDs = Set<PrototypeBundleID>()
        images = images.filter { imageIDs.insert($0).inserted }
        fonts = fonts.filter { fontIDs.insert($0).inserted }
    }

    private mutating func image(_ value: JSONValue?) {
        if let id = value?.stringValue { images.append(PrototypeBundleID(id)) }
        else if let fields = value?.objectFields {
            image(fields["light"])
            image(fields["dark"])
        }
    }

    private mutating func font(_ style: JSONValue?) {
        if let id = style?.objectFields?["fontFamily"]?.objectFields?["asset"]?.stringValue {
            fonts.append(PrototypeBundleID(id))
        }
    }

    private mutating func collect(_ node: JSONValue, path: String, keys: [String: [String]]) {
        guard let fields = node.objectFields else { return }
        if fields["type"]?.stringValue == "image" { image(fields["asset"]) }
        if case let .array(items) = fields["items"] { for item in items { image(item.objectFields?["image"]) } }
        font(fields["style"])
        if case let .array(entries) = fields["styleWhen"] { for entry in entries { font(entry.objectFields?["style"]) }
        }
        if case let .array(spans) = fields["spans"] { for span in spans { font(span.objectFields?["style"]) } }
        for key in keys[path] ?? [] {
            if key == "child", let child = fields[key] { collect(child, path: "\(path).child", keys: keys) }
            if key == "children", case let .array(children) = fields[key] {
                for (index, child) in children.enumerated() {
                    collect(
                        child,
                        path: "\(path).children.\(index)",
                        keys: keys
                    )
                }
            }
            if key == "screens", let screens = fields[key]?.objectFields {
                for name in keys["\(path).screens"] ?? [] {
                    if let screen = screens[name] { collect(screen, path: "\(path).screens.\(name)", keys: keys) }
                }
            }
        }
    }
}
