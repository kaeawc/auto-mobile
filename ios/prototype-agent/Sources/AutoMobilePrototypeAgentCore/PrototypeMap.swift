import Foundation

/// Rules for the `map` node (#14309) that the contract cannot express, the twin of TypeScript's
/// `prototypeMap.ts`: a map needs `map` in `requires.platform`; `showUserLocation` reads the
/// `location` module, so it also needs `location` in `requires.platform` and the `location`
/// permission in `requires.permissions`; `onCameraIdle.into` is a `/data` write path; and an `emit`
/// that `onMarkerTap` runs cannot author a context name the runtime adds (`markerId`, #16492).
/// Contract only: no renderer draws a map.
enum PrototypeMap {
    /// Emit-context names the runtime adds to every `emit` a marker tap runs (#16492).
    static var markerTapEmitContext: [String] {
        PrototypeContractValidator.strings(
            PrototypeContractValidator.platformModules["map"]?.objectFields?["events"]?
                .objectFields?["markerTap"]?.objectFields?["emitContext"]
        )
    }

    /// Action lists nested in an action; a marker tap's id stays fixed for all of them.
    private static let nestedActionLists = ["onSuccess", "onError", "actions"]

    /// Throws at the first `map` node rule a spec breaks.
    static func validateNodes(_ spec: [String: JSONValue], nodes: [PrototypeLocatedValue]) throws {
        let maps = nodes.filter { $0.value["type"] == .string("map") }
        guard !maps.isEmpty else { return }
        let requires = spec["requires"]?.objectFields
        let platform = PrototypeContractValidator.strings(requires?["platform"])
        let permissions: [JSONValue] = if case let .array(entries)? = requires?["permissions"] { entries } else { [] }
        let permission = permissions.contains { $0.objectFields?["name"] == .string("location") }
        for map in maps {
            try validateNode(
                map.value,
                path: map.path,
                map: platform.contains("map"),
                location: platform.contains("location"),
                permission: permission
            )
        }
    }

    private static func validateNode(
        _ node: [String: JSONValue], path: String, map: Bool, location: Bool, permission: Bool
    ) throws {
        guard map else { throw PrototypeLimits.violation(path, "map requires map in requires.platform") }
        if node["showUserLocation"] == .bool(true) {
            guard location else {
                throw PrototypeLimits.violation(
                    "\(path).showUserLocation", "showUserLocation requires location in requires.platform"
                )
            }
            guard permission else {
                throw PrototypeLimits.violation(
                    "\(path).showUserLocation",
                    "showUserLocation requires permission location in requires.permissions"
                )
            }
        }
        if let into = node["onCameraIdle"]?.objectFields?["into"]?.stringValue,
           PrototypeDataWrite.pointer(ofPath: into) == nil
        {
            throw PrototypeLimits.violation(
                "\(path).onCameraIdle.into", "onCameraIdle.into must be a /data/<pointer> path"
            )
        }
        try validateMarkerTap(node["onMarkerTap"], path: "\(path).onMarkerTap", reserved: markerTapEmitContext)
    }

    /// Throws at the first emit under a marker tap, depth first, whose context authors a runtime-added name.
    private static func validateMarkerTap(_ actions: JSONValue?, path: String, reserved: [String]) throws {
        guard case let .array(items)? = actions else { return }
        for (index, item) in items.enumerated() {
            guard let action = item.objectFields else { continue }
            let at = "\(path)[\(index)]"
            let context = action["type"] == .string("emit") ? action["context"]?.objectFields : nil
            if let name = reserved.first(where: { context?[$0] != nil }) {
                throw PrototypeLimits.violation(
                    "\(at).context.\(name)",
                    "\(name) is reserved in an onMarkerTap emit context: the runtime sets it to the tapped marker's id"
                )
            }
            for list in nestedActionLists {
                try validateMarkerTap(action[list], path: "\(at).\(list)", reserved: reserved)
            }
        }
    }
}
