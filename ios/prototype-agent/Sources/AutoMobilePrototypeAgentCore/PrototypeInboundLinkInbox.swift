import Foundation

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
