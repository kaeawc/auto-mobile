import Foundation

/// Material 3 Expressive node vocabulary (#15258), shared by strict and bundle capability collection.
/// The agent does not advertise the capability yet: SwiftUI approximations are a follow-up.
enum PrototypeM3Expressive {
    static let capability = "prototype_m3_expressive_v1"
    static func required(_ node: [String: JSONValue]) -> Bool {
        switch node["type"]?.stringValue {
        case "loadingIndicator": true
        case "segmentedButton": node["variant"]?.stringValue == "connected"
        case "progress": node["variant"]?.stringValue == "wavy"
        case "button": node["split"]?.objectFields != nil
        case "fab": node["menu"]?.objectFields != nil
        default: false
        }
    }
}
