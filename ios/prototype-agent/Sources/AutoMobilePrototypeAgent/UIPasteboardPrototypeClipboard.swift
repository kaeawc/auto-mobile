#if canImport(UIKit)
    import UIKit

    @MainActor
    public final class UIPasteboardPrototypeClipboard: PrototypeClipboard {
        private let pasteboard: UIPasteboard
        private let now: () -> Date
        public init(pasteboard: UIPasteboard = .general, now: @escaping () -> Date = Date.init) {
            self.pasteboard = pasteboard
            self.now = now
        }

        public func copy(text: String, sensitive: Bool, label _: String?) {
            var options: [UIPasteboard.OptionsKey: Any] = [:]
            if sensitive {
                options[.localOnly] = true
                options[.expirationDate] = now().addingTimeInterval(60)
            }
            pasteboard.setItems([["public.utf8-plain-text": text]], options: options)
        }

        public var hasText: Bool { pasteboard.hasStrings }
        public func paste() async throws -> String {
            guard pasteboard.hasStrings else { return "" }
            guard let text = pasteboard.string else { throw PrototypeClipboardError.permissionDenied }
            return text
        }
    }

    extension PrototypePlatformRegistry {
        public static let system =
            PrototypePlatformRegistry(modules: [
                PrototypeClipboardModule(clipboard: UIPasteboardPrototypeClipboard()),
                PrototypeConnectivityModule(source: NWPathConnectivitySource()),
                PrototypeLinksModule(opener: UIKitLinkOpener()),
            ])
    }
#endif
