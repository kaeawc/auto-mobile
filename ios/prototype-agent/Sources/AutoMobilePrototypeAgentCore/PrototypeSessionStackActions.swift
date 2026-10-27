import Foundation

extension PrototypeSession {
    mutating func runStack(_ action: PrototypeAction) -> [PrototypeEvent] {
        guard let id = action.stack else { return [] }
        let direction: PrototypeStackChange.Direction = switch action.type {
        case "push": .push
        case "replace": .replace
        default: .pop
        }
        return changeStack(id, direction: direction, override: action.transition, source: action.source) { node, path in
            switch action.type {
            case "push":
                guard path.count < PrototypeLimits.maxStackDepth, let screen = action.screen,
                      node.screens?[screen] != nil else { return path }
                return path + [screen]
            case "pop":
                return path.count > 1 ? Array(path.dropLast()) : path
            case "popToRoot":
                return [node.start ?? ""]
            case "replace":
                guard let screen = action.screen, node.screens?[screen] != nil else { return path }
                return Array(path.dropLast()) + [screen]
            default:
                return path
            }
        }
    }
}
