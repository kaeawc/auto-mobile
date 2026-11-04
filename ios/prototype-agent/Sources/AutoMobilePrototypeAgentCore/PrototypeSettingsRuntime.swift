import Foundation

@MainActor
protocol PrototypeSettingsURLOpener: AnyObject {
    var appSettingsURL: URL? { get }
    var notificationSettingsURL: URL? { get }
    func open(_ url: URL) async -> Bool
}

@MainActor
final class PrototypeSettingsModule: PrototypePlatformModule {
    let name = "settings"
    let capability = PrototypeAgentProtocol.settingsCapability
    private let opener: any PrototypeSettingsURLOpener

    init(opener: any PrototypeSettingsURLOpener) { self.opener = opener }

    var events: AsyncStream<PlatformEvent> { AsyncStream { $0.finish() } }
    var state: [String: JSONValue] { [:] }
    func availability() -> PlatformAvailability { .ready }

    func call(_ call: PlatformCall) async -> PlatformCallResult {
        guard call.call == "settings.open" else { return .failure(.unsupported, "Unknown call") }
        guard let page = call.args["page"]?.stringValue else {
            return .failure(.invalidArgs, "page is required")
        }
        let url: URL?
        switch page {
        case "app": url = opener.appSettingsURL
        case "notifications": url = opener.notificationSettingsURL
        default: return .failure(.unavailable, "Settings page is unavailable on iOS: \(page)")
        }
        guard let url, await opener.open(url) else {
            return .failure(.unavailable, "Unable to open settings page: \(page)")
        }
        return .success(.object([:]))
    }
}
