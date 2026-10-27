import Foundation

/// Pure renderer decisions; custom bars and sheets deliberately retain observable item identities.
enum PrototypeNamespacePolicy {
    static let minimumOS = 17

    static func buttonStyle(_ requested: String?, osMajor: Int) -> String? {
        guard let requested else { return nil }
        return osMajor >= 26 ? requested : "bordered"
    }

    static func hover(_ requested: String?, osMajor: Int) -> String? {
        osMajor >= minimumOS ? requested : nil
    }

    static func ignoredFields(_ namespace: IosNamespace, isButton: Bool) -> [String] {
        var fields: [String] = []
        if namespace.tab != nil { fields.append("tab.role") }
        if namespace.bottomAccessory != nil { fields.append("bottomAccessory") }
        if namespace.sheet != nil { fields.append("sheet.sizing") }
        if namespace.navigationTitle != nil { fields.append("navigationTitle") }
        if namespace.buttonStyle != nil, !isButton { fields.append("buttonStyle") }
        return fields
    }
}
