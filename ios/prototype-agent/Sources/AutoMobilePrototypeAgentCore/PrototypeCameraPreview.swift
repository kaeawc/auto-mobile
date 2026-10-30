import Foundation

/// Rules for the `cameraPreview` node (#14202) that the contract cannot express, the twin of the host's
/// `prototypeCameraPreview.ts`: at most one per spec, an id that `camera.*` calls name as `preview`,
/// `camera` in `requires.platform` and `requires.permissions`, and lens, flash and zoom keys that name
/// declared state of the right type. Contract only: no runtime draws it.
enum PrototypeCameraPreview {
    private static let previewCalls: Set<String> = ["camera.takePhoto", "camera.startRecording", "camera.stopRecording"]
    private static let stateKeys: [(field: String, number: Bool)] = [
        ("lensKey", false), ("flashKey", false), ("zoomKey", true),
    ]

    /// The ids of the spec's `cameraPreview` nodes. Only node positions are walked (the host's
    /// `prototypeNodeChildren`), so a preview-shaped value in an action payload is never a viewfinder.
    static func ids(_ root: JSONValue) -> Set<String> {
        guard let fields = root.objectFields else { return [] }
        return nodeIds(.init(value: fields, path: "root"))
    }

    private static func nodeIds(_ node: PrototypeLocatedValue) -> Set<String> {
        var found = PrototypeStrictRepeats.children(node.value, path: node.path)
            .reduce(into: Set<String>()) { $0.formUnion(nodeIds($1)) }
        if node.value["type"] == .string("cameraPreview"), let id = node.value["id"]?.stringValue {
            found.insert(id)
        }
        return found
    }

    /// Throws at the first `cameraPreview` node rule a spec breaks.
    static func validateNodes(_ spec: [String: JSONValue], nodes: [PrototypeLocatedValue]) throws {
        let requires = spec["requires"]?.objectFields
        let camera = PrototypeContractValidator.strings(requires?["platform"]).contains("camera")
        var permission = false
        if case let .array(permissions)? = requires?["permissions"] {
            permission = permissions.contains { $0.objectFields?["name"] == .string("camera") }
        }
        let state = spec["state"]?.objectFields ?? [:]
        let previews = nodes.filter { $0.value["type"] == .string("cameraPreview") }
        for (index, node) in previews.enumerated() {
            guard index == 0 else {
                throw PrototypeLimits.violation(node.path, "At most one cameraPreview per prototype")
            }
            try validateNode(node.value, path: node.path, camera: camera, permission: permission, state: state)
        }
    }

    private static func validateNode(
        _ node: [String: JSONValue], path: String, camera: Bool, permission: Bool, state: [String: JSONValue]
    ) throws {
        guard camera else {
            throw PrototypeLimits.violation(path, "cameraPreview requires camera in requires.platform")
        }
        guard permission else {
            throw PrototypeLimits.violation(path, "cameraPreview requires permission camera in requires.permissions")
        }
        guard let id = node["id"]?.stringValue, PrototypeContractValidator.matches("stateKey", id) else {
            throw PrototypeLimits.violation(path, "A cameraPreview needs an id that is a state key")
        }
        for (field, number) in stateKeys {
            guard let key = node[field]?.stringValue else { continue }
            if !holds(state[key], number: number) {
                throw PrototypeLimits.violation(
                    "\(path).\(field)", "\(field) must name a declared \(number ? "number" : "string") state key"
                )
            }
        }
    }

    private static func holds(_ value: JSONValue?, number: Bool) -> Bool {
        switch value {
        case .number?: return number
        case .string?: return !number
        default: return false
        }
    }

    /// Throws when a viewfinder `camera.*` call's literal `preview` argument names no `cameraPreview` node.
    static func call(_ action: [String: JSONValue], path: String, previews: Set<String>) throws {
        guard let call = action["call"]?.stringValue, previewCalls.contains(call) else { return }
        guard let preview = action["args"]?.objectFields?["preview"]?.objectFields?["value"]?.stringValue,
              !previews.contains(preview)
        else { return }
        throw PrototypeLimits.violation("\(path).args.preview.value", "Unknown camera preview")
    }
}
