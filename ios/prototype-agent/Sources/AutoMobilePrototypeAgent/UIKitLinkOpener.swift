#if canImport(UIKit) && canImport(SafariServices)
    import SafariServices
    import UIKit

    /// `links.open` on iOS (#14238): `UIApplication.open` for external opens, and
    /// `SFSafariViewController` presented over the top view controller of the prototype's overlay
    /// window, or of the key window when the prototype is embedded in the app.
    /// `canOpenURL` is not used, since it would need `LSApplicationQueriesSchemes`.
    @MainActor
    final class UIKitLinkOpener: PrototypeLinkOpener {
        func openExternally(_ url: URL) async -> Bool {
            await UIApplication.shared.open(url)
        }

        /// The browser `links.open` presented last; it belongs to the prototype that opened it.
        private weak static var presentedBrowser: SFSafariViewController?

        func presentInApp(_ url: URL) -> Bool {
            guard let presenter = Self.topViewController() else { return false }
            let browser = SFSafariViewController(url: url)
            presenter.present(browser, animated: true)
            Self.presentedBrowser = browser
            return true
        }

        /// Closes the in-app browser when its prototype is dismissed or replaced.
        static func dismissPresentedBrowser() {
            guard let browser = presentedBrowser, browser.presentingViewController != nil else { return }
            browser.dismiss(animated: false)
            presentedBrowser = nil
        }

        private static func topViewController() -> UIViewController? {
            let windows = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .filter { $0.activationState == .foregroundActive }
                .flatMap(\.windows)
            let candidates = windows.map { window in
                PrototypePresenterWindow.Candidate(
                    isPrototypeOverlay: (window as? PassthroughWindow)?.model?.spec != nil,
                    isKey: window.isKeyWindow,
                    isHidden: window.isHidden
                )
            }
            guard let index = PrototypePresenterWindow.index(of: candidates) else { return nil }
            var top = windows[index].rootViewController
            while let presented = top?.presentedViewController, !presented.isBeingDismissed {
                top = presented
            }
            return top
        }
    }
#endif
