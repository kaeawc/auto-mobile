import Foundation

/// Cross-argument `links.open` rule. Custom Tabs and SFSafariViewController load only web pages, so
/// `inApp` needs an http(s) URL. A spec's bound arguments are checked once the runtime resolves them.
enum PrototypeLinks {
    static let inAppMessage = "links.open mode inApp requires an http or https url"
    struct Violation: Error, Equatable { let path: String; let message: String }

    static func argumentsError(_ args: [String: JSONValue], path: String, resolved: Bool = false) -> Violation? {
        func literal(_ name: String) -> String? {
            resolved ? args[name]?.stringValue : args[name]?.objectFields?["value"]?.stringValue
        }
        guard let url = literal("url"), literal("mode") == "inApp",
              !url.hasPrefix("http:"), !url.hasPrefix("https:")
        else { return nil }
        return Violation(path: resolved ? "\(path).mode" : "\(path).mode.value", message: inAppMessage)
    }
}
