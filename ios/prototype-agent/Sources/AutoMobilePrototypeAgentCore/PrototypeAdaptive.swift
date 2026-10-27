import Foundation

/// Platform width classes stay native; these decisions need no SwiftUI or device.
enum PrototypeAdaptive {
    enum Width: CaseIterable { case compact, regular }
    enum Layout: Equatable { case stack, split, bottomBar, sidebar, sheet, inspector }

    static func layout(kind: String, width: Width) -> Layout {
        switch kind {
        case "listDetail": width == .regular ? .split : .stack
        case "navigationSuite": width == .regular ? .sidebar : .bottomBar
        default: width == .regular ? .inspector : .sheet
        }
    }

    static func compactBack(
        kind: String,
        width: Width,
        selectionKey: String?,
        state: [String: JSONValue]
    )
        -> (String, JSONValue)?
    {
        guard kind == "listDetail", width == .compact, let key = selectionKey,
              let selection = state[key]?.stringValue, !selection.isEmpty else { return nil }
        return (key, .string(""))
    }

    static let slots = ["list", "detail", "content", "main", "supporting"]
    private static let fieldsByKind = [
        "listDetail": ["list", "detail", "selectionKey"],
        "navigationSuite": ["items", "stateKey", "content"],
        "supporting": ["main", "supporting", "openKey"],
    ]

    static func validate(_ value: [String: JSONValue], path: String, state: [String: JSONValue]) throws {
        guard value["type"] == .string("adaptive") else { return }
        let kind = value["kind"]?.stringValue ?? ""
        let fields = fieldsByKind[kind] ?? []
        for field in fields where value[field] == nil {
            throw PrototypeContractValidator.invalid(
                "\(path).\(field)",
                "Required field"
            )
        }
        for field in slots + ["items", "selectionKey", "stateKey", "openKey"]
            where value[field] != nil && !fields.contains(field)
        {
            throw PrototypeContractValidator.invalid("\(path).\(field)", "Field is not allowed for adaptive kind")
        }
        let field = kind == "listDetail" ? "selectionKey" : kind == "supporting" ? "openKey" : "stateKey"
        let stored = state[value[field]?.stringValue ?? ""]
        let valid = field == "openKey" ? stored?.boolValue != nil : stored?.stringValue != nil
        let type = field == "openKey" ? "boolean" : "string"
        guard valid else { throw PrototypeContractValidator.invalid(
            "\(path).\(field)",
            "Adaptive \(kind) requires a declared \(type) state key"
        ) }
        guard kind == "navigationSuite" else { return }
        var values = Set<String>()
        for (index, item) in PrototypeStrictBindings.array(value["items"]).enumerated() {
            let option = item.objectFields?["value"]?.stringValue ?? ""
            guard values.insert(option).inserted else { throw PrototypeContractValidator.invalid(
                "\(path).items[\(index)].value",
                "Duplicate adaptive item value"
            ) }
        }
        guard values.contains(stored?.stringValue ?? "")
        else {
            throw PrototypeContractValidator
                .invalid("\(path).stateKey", "Adaptive navigationSuite state must name an item value")
        }
    }

    static func binding(_ node: PrototypeNode, state: [String: JSONValue]) -> PrototypeStateValidator
        .BindingRejection?
    {
        guard node.type == "adaptive" else { return nil }
        let field = node.kind == "listDetail" ? "selectionKey" : node.kind == "supporting" ? "openKey" : "stateKey"
        let key = node.kind == "listDetail" ? node.selectionKey : node.kind == "supporting" ? node.openKey : node
            .stateKey
        let value = key.flatMap { state[$0] }
        let type = field == "openKey" ? "boolean" : "string"
        guard field == "openKey" ? value?.boolValue != nil : value?.stringValue != nil else {
            return .init(field: field, message: "Adaptive \(node.kind ?? "") requires a declared \(type) state key")
        }
        if node.kind == "navigationSuite",
           !(node.adaptiveItems ?? []).contains(where: { $0.value == value?.stringValue })
        {
            return .init(field: field, message: "Adaptive navigationSuite state must name an item value")
        }
        return nil
    }
}
