@MainActor
final class PrototypeWebViewModule: PrototypePlatformModule {
    static let capabilityName = "prototype_platform_webview_v1"

    let name = "webview"
    var capability: String { Self.capabilityName }
    let events = AsyncStream<PlatformEvent> { $0.finish() }
    let state: [String: JSONValue] = [:]
    private var pages: [String: any PrototypeWebPage] = [:]

    func availability() -> PlatformAvailability { .ready }

    func attach(_ id: String?, page: any PrototypeWebPage) {
        if let id { pages[id] = page }
    }

    func detach(_ id: String?, page: any PrototypeWebPage) {
        if let id, pages[id] === page { pages.removeValue(forKey: id) }
    }

    func call(_ call: PlatformCall) async -> PlatformCallResult {
        guard call.call == "webview.back" || call.call == "webview.reload" else {
            return .failure(.unsupported, "Unknown call")
        }
        guard let id = call.args["node"]?.stringValue else { return .failure(.invalidArgs, "node is required") }
        guard let page = pages[id] else { return .failure(.unavailable, "Web view is not attached") }
        if call.call == "webview.reload" { page.reloadPage() }
        else if page.canGoBack { page.backPage() }
        return .success(.null)
    }

    func stop() { pages.removeAll() }
}
