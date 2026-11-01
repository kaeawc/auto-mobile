import AutoMobileSDK
import Foundation
import UIKit
import WebKit

struct NavigationHostLog: Encodable {
    let deviceClass: String
    let multiScene: String
    let sceneIdentifiers: [String]
    var events: [SdkNavigationEvent] = []
}

/// Owns both delegates: the SDK receives completed host callbacks without replacing them.
@MainActor
final class SdkContractNavigationScenario: NSObject, UINavigationControllerDelegate, WKNavigationDelegate {
    let bridge: AutoMobileWebViewBridge

    init(bridge: AutoMobileWebViewBridge = AutoMobileWebViewBridge(webViewId: "contract-navigation")) {
        self.bridge = bridge
        super.init()
    }

    func registerWebView() {
        webView.navigationDelegate = self
        bridge.register(webView)
    }
    let webView = WKWebView()
    private var uiKit: UIKitNavigationAdapter?
    private var shown = false
    private var loaded = false
    private var webFailure: Error?

    func navigationController(
        _ navigationController: UINavigationController,
        didShow viewController: UIViewController,
        animated: Bool
    ) {
        shown = true
        uiKit?.recordPush(viewController)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        bridge.webView(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        bridge.webView(webView, didFinish: navigation)
        loaded = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        bridge.webView(webView, didFail: navigation, withError: error)
        webFailure = error
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        webFailure = error
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        bridge.webViewWebContentProcessDidTerminate(webView)
    }

    func run() async throws -> (CapabilityObservation, NavigationHostLog) {
        let navigation = AutoMobileNavigation.shared
        let before = navigation.hostIntegrationCapabilities()
        registerWebView()
        defer { bridge.detach() }
        uiKit = navigation.registerUIKit()
        let swiftUI = navigation.registerSwiftUI()
        let links = navigation.registerDeepLinks()
        let router = navigation.registerCustomRouter()
        let capabilities = CapabilityObservation(
            beforeRegistration: before,
            afterRegistration: navigation.hostIntegrationCapabilities()
        )
        try await waitUntil { UIApplication.shared.connectedScenes.contains { $0 is UIWindowScene } }
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
            throw SdkContractError.timedOut(seconds: 30)
        }
        let firstId = scene.session.persistentIdentifier
        let controller = UINavigationController()
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        controller.delegate = self
        controller.pushViewController(UIViewController(), animated: false)
        try await waitUntil { self.shown }
        swiftUI.trackTab(destination: "contract-swiftui", sceneIdentifier: firstId)
        links.record(destination: "contract-deeplink", sceneIdentifier: firstId)
        router.record(destination: "contract-custom", sceneIdentifier: firstId, transitionIdentifier: "contract-first")
        webView.loadHTMLString("<html><body>Contract navigation</body></html>", baseURL: nil)
        try await waitUntil { self.loaded || self.webFailure != nil }
        if let webFailure { throw webFailure }
        guard webView.navigationDelegate === self else {
            throw SdkContractError.timedOut(seconds: 30)
        }
        var ids = [firstId]
        let isPad = UIDevice.current.userInterfaceIdiom == .pad
        if isPad {
            let previous = Set(UIApplication.shared.connectedScenes.map { $0.session.persistentIdentifier })
            var activationError: Error?
            UIApplication.shared.requestSceneSessionActivation(nil, userActivity: nil, options: nil) {
                activationError = $0
            }
            try await waitUntil {
                activationError != nil || UIApplication.shared.connectedScenes.contains {
                    !previous.contains($0.session.persistentIdentifier) && $0.activationState == .foregroundActive
                }
            }
            if let activationError { throw activationError }
            guard let second = UIApplication.shared.connectedScenes.first(where: {
                !previous.contains($0.session.persistentIdentifier) && $0.activationState == .foregroundActive
            }) else { throw SdkContractError.timedOut(seconds: 30) }
            let secondId = second.session.persistentIdentifier
            ids.append(secondId)
            router.record(
                destination: "contract-second-scene",
                sceneIdentifier: secondId,
                transitionIdentifier: "contract-second"
            )
        }
        return (capabilities, NavigationHostLog(
            deviceClass: isPad ? "ipad" : "iphone",
            multiScene: isPad ? "complete" : "not-applicable",
            sceneIdentifiers: ids
        ))
    }

    private func waitUntil(_ ready: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(30)
        while !ready() {
            guard Date() < deadline else { throw SdkContractError.timedOut(seconds: 30) }
            try await Task.sleep(nanoseconds: SdkContractRunner.capturePollNanoseconds)
        }
    }
}
