import Foundation

/// Only registered prototype schemes belong to this renderer; host OAuth and web URLs do not.
enum PrototypeInboundLinkSchemes {
    static func registered(_ schemes: [String]) -> [String] {
        schemes.map { $0.lowercased() }.filter { $0.hasPrefix("amp-") && $0.count > 4 }
    }

    static func accepts(_ url: URL, schemes: [String]) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return registered(schemes).contains(scheme)
    }

    static func capabilities(installed: Bool, schemes: [String]) -> [String] {
        installed && !registered(schemes).isEmpty ? [PrototypeAgentProtocol.linksCapability] : []
    }

    /// One list for import checks and embedded rendering, so an accepted import always renders.
    static func rendererCapabilities(registry: [String], delivery: [String]) -> [String] {
        AutoMobilePrototypeCapabilities.supported + registry + delivery
    }
}

/// What ProtoViewer's SwiftUI URL callback does with an opened URL.
enum PrototypeViewerURLRoute: Equatable {
    case mcp
    case share
    /// A registered scheme goes to the inbox unless the delegate hook already delivered it
    /// (`PrototypeHookedURLLedger`); other URLs belong to the host.
    case delegateOwned

    static func route(_ url: URL) -> Self {
        if url.scheme?.lowercased() == "automobile-proto" { return .mcp }
        return url.isFileURL ? .share : .delegateOwned
    }
}

/// SwiftUI hands every URL to `onOpenURL`, but the delegate hook can miss it: on iOS 27.2 SwiftUI
/// installs its scene delegate without `-setDelegate:`, so the hook never runs. The hook records what
/// it delivered, and the view callback delivers only the URLs the hook did not.
struct PrototypeHookedURLLedger {
    static let capacity = 16
    private var delivered: [String] = []

    mutating func recordHook(_ url: String) {
        delivered.append(url)
        if delivered.count > Self.capacity { delivered.removeFirst() }
    }

    /// True when the view callback must deliver `url` itself; consumes a matching hook delivery.
    mutating func callbackShouldDeliver(_ url: String) -> Bool {
        guard let index = delivered.firstIndex(of: url) else { return true }
        delivered.remove(at: index)
        return false
    }
}

@MainActor
protocol PrototypeInboundLinkTarget: AnyObject {
    var isReadyForInboundLinks: Bool { get }
    func receiveInboundLink(_ url: String)
}

/// Launch delivery can precede the spec. Attach and flush synchronously before exposing content.
@MainActor
final class PrototypeInboundLinkInbox {
    private weak var target: (any PrototypeInboundLinkTarget)?
    private var pending: [String] = []

    func receive(_ url: String) {
        guard let target, target.isReadyForInboundLinks else { pending.append(url); return }
        target.receiveInboundLink(url)
    }

    func attach(_ target: any PrototypeInboundLinkTarget) {
        self.target = target
        flush(target)
    }

    func flush(_ target: any PrototypeInboundLinkTarget) {
        guard self.target === target, target.isReadyForInboundLinks else { return }
        let launch = pending
        pending = []
        for url in launch {
            target.receiveInboundLink(url)
        }
    }

    func detach(_ target: any PrototypeInboundLinkTarget) {
        if self.target === target { self.target = nil }
    }
}
