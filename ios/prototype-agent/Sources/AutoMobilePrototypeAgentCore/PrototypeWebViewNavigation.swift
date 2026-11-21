import Foundation

@MainActor
protocol PrototypeWebPage: AnyObject {
    var title: String? { get }
    var canGoBack: Bool { get }
    func loadPage(_ url: URL)
    func backPage()
    func reloadPage()
}

@MainActor
final class PrototypeWebViewNavigation {
    struct Update {
        let writes: [(String, JSONValue)]
        let actions: [PrototypeAction]
    }

    var node: PrototypeNode
    private weak var page: (any PrototypeWebPage)?
    private let publish: (Update) -> Void
    private var ready = false
    private var loading = false
    private var blockedURL: String?

    init(node: PrototypeNode, page: any PrototypeWebPage, publish: @escaping (Update) -> Void) {
        self.node = node
        self.page = page
        self.publish = publish
    }

    func prepare(installRules: @MainActor (String) async throws -> Void) async {
        do {
            try await installRules(PrototypeWebViewPolicy.contentRules(allowedOrigins: node.webViewOrigins))
            ready = !Task.isCancelled
        } catch {
            if !Task.isCancelled { update("error") }
        }
    }

    func load(_ url: String) {
        guard ready else { return }
        loading = false
        blockedURL = nil
        guard permits(url, mainFrame: true), let address = URL(string: url) else { return }
        started(url)
        page?.loadPage(address)
    }

    func permits(_ url: String, mainFrame: Bool, newAttempt: Bool = false) -> Bool {
        guard ready else { return false }
        if mainFrame, newAttempt { blockedURL = nil }
        if PrototypeWebViewPolicy.check(url, allowedOrigins: node.webViewOrigins) == .allow { return true }
        if mainFrame, blockedURL != url {
            blockedURL = url
            loading = false
            update("blocked", url: url, handlers: node.webViewOnBlockedNavigation)
        }
        return false
    }

    func started(_ url: String) {
        guard permits(url, mainFrame: true), !loading else { return }
        blockedURL = nil
        loading = true
        update("loading")
    }

    func finished(_ url: String) {
        guard loading, permits(url, mainFrame: true) else { return }
        loading = false
        update("loaded", url: url, handlers: node.webViewOnNavigate)
    }

    func failed(url: String? = nil) {
        if let url, !permits(url, mainFrame: true) { return }
        guard blockedURL == nil else { return }
        loading = false
        update("error")
    }

    private func update(_ status: String, url: String = "", handlers: [JSONValue] = []) {
        let writes: [(String, JSONValue)] = [
            node.navigationStateKey.map { ($0, .string(status)) },
            node.titleKey.map { ($0, .string(status == "loaded" ? page?.title ?? "" : "")) },
            node.canGoBackKey.map { ($0, .bool(page?.canGoBack ?? false)) },
        ].compactMap { $0 }
        let actions: [PrototypeAction]
        if handlers.isEmpty {
            actions = []
        } else {
            let bound = JSONValue.array(handlers.map { Self.bindURL($0, url: url) })
            actions = (try? JSONDecoder().decode([PrototypeAction].self, from: JSONEncoder().encode(bound))) ?? []
        }
        publish(.init(writes: writes, actions: actions))
    }

    private static func bindURL(_ value: JSONValue, url: String) -> JSONValue {
        switch value {
        case let .object(fields): .object(fields.mapValues { bindURL($0, url: url) })
        case let .array(items): .array(items.map { bindURL($0, url: url) })
        case let .string(text): .string(text.replacingOccurrences(of: "{url}", with: url))
        default: value
        }
    }
}
