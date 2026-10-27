import Foundation

/// The contract validator is cross-platform; the iOS decoder and bundle boundary refuse AGSL.
enum PrototypeCustomShaders {
    static let mimeType = "application/vnd.automobile.agsl"
    static let refusal =
        "iOS and ProtoViewer bundles refuse custom AGSL shaders (style.shader and application/vnd.automobile.agsl); use Android with the host opt-in."

    static func uses(_ spec: [String: JSONValue]) -> Bool {
        if PrototypeStrictCapabilities.required(spec).contains("prototype_custom_shaders_v1") { return true }
        return (spec["components"]?.objectFields ?? [:]).values.contains { component in
            guard let root = component.objectFields?["root"] else { return false }
            return PrototypeStrictCapabilities.required(["root": root]).contains("prototype_custom_shaders_v1")
        }
    }

    static func refuse(_ spec: [String: JSONValue]) throws {
        if uses(spec) {
            throw PrototypeContractValidator.invalid("root.style.shader", refusal)
        }
    }
}
