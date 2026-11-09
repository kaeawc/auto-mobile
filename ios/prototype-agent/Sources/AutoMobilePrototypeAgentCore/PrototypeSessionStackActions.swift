import Foundation
import os

extension PrototypeSession {
    mutating func runStack(_ action: PrototypeAction) -> [PrototypeEvent] {
        guard let id = action.stack, let node = stackNodes[id] else { return [] }
        // An authored pop runs the top screen's onBack instead; `force: true` always pops (#14188).
        if action.type == "pop", action.force != true, let intercepted = interceptedBack(id) { return intercepted }
        let direction: PrototypeStackChange.Direction = switch action.type {
        case "push": .push
        case "replace", "setStack": .replace
        default: .pop
        }
        // Params resolve against the state and data as they are before the path changes.
        guard let target = routeTarget(action, stack: node) else { return [] }
        return changeStack(id, direction: direction, override: action.transition, source: action.source) { node, path in
            switch action.type {
            case "push":
                return path.count < PrototypeLimits.maxStackDepth ? path + target : path
            case "pop":
                return path.count > 1 ? Array(path.dropLast()) : path
            case "popToRoot":
                return [PrototypeStackPathEntry(screen: node.start ?? "")]
            case "replace":
                return Array(path.dropLast()) + target
            case "setStack":
                return target
            default:
                return path
            }
        }
    }

    /// The entries a push, replace (one) or setStack (the whole path, #16620) puts on the stack, with
    /// their params resolved and checked against the stack's `routes` declarations; empty for the
    /// other actions. Nil, leaving the stack as it was, when a screen is unknown, a setStack path is
    /// empty or past the depth limit, or any entry's params do not match.
    private func routeTarget(_ action: PrototypeAction, stack node: PrototypeNode) -> [PrototypeStackPathEntry]? {
        var requested: [(screen: String?, params: [String: JSONValue]?)] = []
        switch action.type {
        case "push", "replace":
            requested = [(screen: action.screen, params: action.params)]
        case "setStack":
            let path = action.stackPath ?? []
            guard (1 ... PrototypeLimits.maxStackDepth).contains(path.count) else { return nil }
            requested = path.map { entry -> (screen: String?, params: [String: JSONValue]?) in
                (screen: entry.screen, params: entry.params)
            }
        default:
            return []
        }
        var entries: [PrototypeStackPathEntry] = []
        for entry in requested {
            guard let screen = entry.screen, node.screens?[screen] != nil else { return nil }
            guard let params = resolvedRouteParams(entry.params),
                  PrototypeStackRoutes.matches(params, declared: PrototypeStackRoutes.declared(node, screen: screen))
            else {
                prototypeRoutesLog.warning(
                    "Ignored \(action.type, privacy: .public) to \(screen, privacy: .public): params do not match"
                )
                return nil
            }
            entries.append(PrototypeStackPathEntry(screen: screen, params: params))
        }
        return entries
    }
}
