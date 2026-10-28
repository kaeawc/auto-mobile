import Foundation

/// The platform side of `links.open`; the UIKit opener lives with the agent's UI code.
@MainActor
protocol PrototypeLinkOpener: AnyObject {
    /// `UIApplication.open`; false when no installed app handles the URL.
    func openExternally(_ url: URL) async -> Bool
    /// Presents an in-app browser; false when no view controller can present it.
    func presentInApp(_ url: URL) -> Bool
}

/// `links.open` (#14238). The validators and the driver have already checked the scheme allowlist
/// and refused `inApp` for non-web URLs. `auto`, the default, opens web URLs in-app; iOS always has
/// SFSafariViewController, so `inApp` falls back to external only when nothing can present it.
@MainActor
final class PrototypeLinksModule: PrototypePlatformModule {
    let name = "links"
    let capability = "prototype_platform_links_v1"
    static let maxResultUrlCharacters = 2048
    private let opener: any PrototypeLinkOpener

    init(opener: any PrototypeLinkOpener) { self.opener = opener }

    var events: AsyncStream<PlatformEvent> { AsyncStream { $0.finish() } }
    var state: [String: JSONValue] { [:] }
    func availability() -> PlatformAvailability { .ready }

    func call(_ call: PlatformCall) async -> PlatformCallResult {
        guard call.call == "links.open" else { return .failure(.unsupported, "Unknown call") }
        guard let text = call.args["url"]?.stringValue, let url = URL(string: text) else {
            return .failure(.invalidArgs, "url is required")
        }
        let mode = call.args["mode"]?.stringValue ?? "auto"
        guard ["external", "inApp", "auto"].contains(mode) else {
            return .failure(.invalidArgs, "mode must be external, inApp or auto")
        }
        let scheme = text.prefix { $0 != ":" }
        let web = scheme == "http" || scheme == "https"
        if web, mode != "external", opener.presentInApp(url) {
            return Self.success(text, outcome: "opened", mode: "inApp")
        }
        guard await opener.openExternally(url) else {
            return .failure(.unavailable, "No installed app opens \(scheme) links")
        }
        return Self.success(text, outcome: web && mode == "inApp" ? "fallback" : "opened", mode: "external")
    }

    private static func success(_ url: String, outcome: String, mode: String) -> PlatformCallResult {
        .success(.object([
            "outcome": .string(outcome),
            "url": .string(String(url.prefix(maxResultUrlCharacters))),
            "mode": .string(mode),
        ]))
    }
}
