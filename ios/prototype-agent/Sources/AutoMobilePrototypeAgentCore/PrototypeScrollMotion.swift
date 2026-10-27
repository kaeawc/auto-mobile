import Foundation

/// Scroll offsets are in points (the spec's dp), independent of time and motion-off mode.
enum PrototypeScrollMotion {
    static let maxBindings = 16
    struct Draw: Equatable, Sendable {
        var alpha = 1.0
        var scale = 1.0
        var offsetX = 0.0
        var offsetY = 0.0
        var blur = 0.0
    }

    static func draw(_ linked: ScrollLinked?, offset: Double, reduced: Bool) -> Draw {
        guard let linked else { return Draw() }
        func output(_ range: [Double]?, identity: Double) -> Double {
            range.map { interpolate(offset, range: linked.range, output: $0) } ?? identity
        }
        var result = Draw()
        result.alpha = min(1, max(0, output(linked.alpha, identity: 1)))
        if !reduced {
            result.scale = output(linked.scale, identity: 1)
            result.offsetX = output(linked.offsetX, identity: 0)
            result.offsetY = output(linked.offsetY, identity: 0)
            result.blur = max(0, output(linked.blur, identity: 0))
        }
        return result
    }

    static func interpolate(_ offset: Double, range: [Double], output: [Double]) -> Double {
        if offset <= range[0] { return output[0] }
        if offset >= range[1] { return output[1] }
        let span = range[1] - range[0]
        let fraction = span.isFinite ? (offset - range[0]) / span
            : (offset / 2 - range[0] / 2) / (range[1] / 2 - range[0] / 2)
        return output[0] * (1 - fraction) + output[1] * fraction
    }

    static func edge(_ phase: Double, value: Double, identity: Double) -> Double {
        identity + (value - identity) * min(1, abs(phase))
    }

    private static func screen(_ path: String, scopes: [String]) -> String {
        scopes.filter { path == $0 || path.hasPrefix("\($0).") }.max(by: { $0.count < $1.count }) ?? "root"
    }

    static func validate(_ root: JSONValue, data: [String: JSONValue]? = nil) throws {
        var nodes: [PrototypeLocatedValue] = []
        var scopes: [String] = []
        func collect(_ value: JSONValue, path: String) {
            guard let fields = value.objectFields else { return }
            nodes.append(.init(value: fields, path: path))
            for name in fields["screens"]?.objectFields?.keys ?? [String: JSONValue]().keys {
                scopes.append(PrototypeStacks.screenPath(path, name: name))
            }
            for child in PrototypeStrictRepeats.children(fields, path: path) {
                collect(.object(child.value), path: child.path)
            }
        }
        collect(root, path: "root")
        var count = 0
        for node in nodes {
            let linked = node.value["scrollLinked"]?.objectFields
            let transition = node.value["scrollTransition"]?.objectFields
            if linked == nil, transition == nil { continue }
            var instances = 1
            for parent in nodes where node.path.hasPrefix("\(parent.path).children[") {
                let items = parent.value["repeat"]?.objectFields?["items"]
                if case let .array(values)? = items { instances *= values.count }
                if let pointer = items?.objectFields?["path"]?.stringValue,
                   case let .array(values)? = PrototypeDataPointer.resolve(data, pointer: pointer)
                {
                    instances *= values.count
                }
            }
            count += [linked, transition].compactMap { $0 }.count * instances
            if count >
                maxBindings { throw PrototypeContractValidator.invalid(node.path, "Scroll binding limit exceeded") }
            if let linked { try validateLinked(linked, node: node, nodes: nodes, scopes: scopes) }
            if transition != nil, !nodes.contains(where: {
                node.path
                    .hasPrefix("\($0.path).") && screen($0.path, scopes: scopes) == screen(node.path, scopes: scopes) &&
                    (
                        ["scroll", "pager", "carousel"].contains($0.value["type"]?.stringValue ?? "") || $0
                            .value["repeat"] != nil
                    )
            }) {
                throw PrototypeContractValidator.invalid(
                    "\(node.path).scrollTransition", "Expected a scroll, pager, carousel or repeat ancestor"
                )
            }
        }
    }

    private static func validateLinked(
        _ linked: [String: JSONValue], node: PrototypeLocatedValue, nodes: [PrototypeLocatedValue], scopes: [String]
    )
        throws
    {
        let path = "\(node.path).scrollLinked"
        let range = PrototypeStrictBindings.array(linked["range"]).compactMap(\.numberValue)
        guard range.count == 2, range[0] < range[1] else {
            throw PrototypeContractValidator.invalid("\(path).range", "Expected two increasing numbers")
        }
        guard ["alpha", "scale", "offsetY", "offsetX", "blur"].contains(where: { linked[$0] != nil }) else {
            throw PrototypeContractValidator.invalid(path, "Expected at least one scroll output")
        }
        guard nodes.contains(where: {
            $0.value["id"] == linked["source"] && $0
                .value["type"] == .string("scroll") && screen($0.path, scopes: scopes) ==
                screen(node.path, scopes: scopes)
        })
        else {
            throw PrototypeContractValidator.invalid("\(path).source", "Expected a scroll id in the same screen")
        }
    }
}
