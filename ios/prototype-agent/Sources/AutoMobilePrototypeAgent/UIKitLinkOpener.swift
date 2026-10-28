#if canImport(UIKit) && canImport(SafariServices)
    import SafariServices
    import UIKit

    /// `links.open` on iOS (#14238): `UIApplication.open` for external opens, and
    /// `SFSafariViewController` presented over the foreground key window's top view controller.
    /// `canOpenURL` is not used, since it would need `LSApplicationQueriesSchemes`.
    @MainActor
    final class UIKitLinkOpener: PrototypeLinkOpener {
        func openExternally(_ url: URL) async -> Bool {
            await UIApplication.shared.open(url)
        }

        func presentInApp(_ url: URL) -> Bool {
            guard let presenter = Self.topViewController() else { return false }
            presenter.present(SFSafariViewController(url: url), animated: true)
            return true
        }

        private static func topViewController() -> UIViewController? {
            let windows = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .filter { $0.activationState == .foregroundActive }
                .flatMap(\.windows)
            var top = (windows.first(where: \.isKeyWindow) ?? windows.first)?.rootViewController
            while let presented = top?.presentedViewController, !presented.isBeingDismissed {
                top = presented
            }
            return top
        }
    }
#endif
