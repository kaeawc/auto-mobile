#if canImport(UIKit)
    import OSLog
    import SwiftUI
    import WebKit

    private struct PrototypeWebDataStoreIdentifierKey: EnvironmentKey {
        static let defaultValue: UUID? = nil
    }

    extension EnvironmentValues {
        var prototypeWebDataStoreIdentifier: UUID? {
            get { self[PrototypeWebDataStoreIdentifierKey.self] }
            set { self[PrototypeWebDataStoreIdentifierKey.self] = newValue }
        }
    }

    @MainActor
    struct PrototypeWebViewView: UIViewRepresentable {
        @Environment(\.prototypeWebDataStoreIdentifier) private var dataStoreIdentifier
        let node: PrototypeNode
        let url: String
        let module: PrototypeWebViewModule
        let model: PrototypeModel

        func makeCoordinator() -> Coordinator {
            Coordinator(module: module, nodeID: node.id)
        }

        func makeUIView(context: Context) -> WKWebView {
            let configuration = WKWebViewConfiguration()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = false
            configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
            configuration.upgradeKnownHostsToHTTPS = false
            configuration.allowsAirPlayForMediaPlayback = false
            if #available(iOS 17, *), let id = dataStoreIdentifier {
                configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: id)
            } else {
                configuration.websiteDataStore = .nonPersistent()
            }

            let webView = WKWebView(frame: .zero, configuration: configuration)
            webView.allowsBackForwardNavigationGestures = false
            webView.allowsLinkPreview = false
            context.coordinator.attach(webView, node: node, model: model)
            return webView
        }

        func updateUIView(_ webView: WKWebView, context: Context) {
            context.coordinator.update(node: node, url: url, webView: webView)
        }

        static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
            coordinator.detach(webView)
        }

        @MainActor
        final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
            private enum RuleError: Error { case unavailable }

            private let module: PrototypeWebViewModule
            private let nodeID: String?
            private var navigation: PrototypeWebViewNavigation?
            private var requestedURL: String?
            private var activeNavigation: WKNavigation?
            private var ruleTask: Task<Void, Never>?
            private var loadTask: Task<Void, Never>?

            init(module: PrototypeWebViewModule, nodeID: String?) {
                self.module = module
                self.nodeID = nodeID
            }

            func attach(_ webView: WKWebView, node: PrototypeNode, model: PrototypeModel) {
                let navigation = PrototypeWebViewNavigation(node: node, page: webView) { [weak model] update in
                    model?.webViewNavigation(update)
                }
                self.navigation = navigation
                webView.navigationDelegate = self
                webView.uiDelegate = self
                module.attach(nodeID, page: webView)
                ruleTask = Task { [weak self, weak webView] in
                    await navigation.prepare { rules in
                        let ruleStore: WKContentRuleListStore? = WKContentRuleListStore.default()
                        guard let store = ruleStore else { throw RuleError.unavailable }
                        let identifier = "prototype-webview-\(UUID().uuidString)"
                        guard let list = try await store.compileContentRuleList(
                            forIdentifier: identifier, encodedContentRuleList: rules
                        ) else { throw RuleError.unavailable }
                        do { try await store.removeContentRuleList(forIdentifier: identifier) }
                        catch {
                            Logger(subsystem: "dev.jasonpearson.automobile", category: "prototype-webview")
                                .warning(
                                    "Could not remove the compiled rule file: \(error.localizedDescription, privacy: .private)"
                                )
                        }
                        try Task.checkCancellation()
                        webView?.configuration.userContentController.add(list)
                    }
                    guard !Task.isCancelled, let self else { return }
                    ruleTask = nil
                    if let requestedURL { navigation.load(requestedURL) }
                }
            }

            func update(node: PrototypeNode, url: String, webView: WKWebView) {
                navigation?.node = node
                guard requestedURL != url else { return }
                requestedURL = url
                // The first load waits for installation. Subsequent state-driven URLs also leave the SwiftUI
                // update cycle before publishing any navigation state back to the model.
                guard ruleTask == nil else { return }
                loadTask?.cancel()
                loadTask = Task { [weak self, weak webView] in
                    guard !Task.isCancelled, let self else { return }
                    activeNavigation = nil
                    webView?.stopLoading()
                    navigation?.load(url)
                }
            }

            func detach(_ webView: WKWebView) {
                ruleTask?.cancel()
                loadTask?.cancel()
                navigation = nil
                activeNavigation = nil
                module.detach(nodeID, page: webView)
                webView.navigationDelegate = nil
                webView.uiDelegate = nil
                webView.stopLoading()
            }

            func webView(
                _: WKWebView, decidePolicyFor action: WKNavigationAction,
                decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
            ) {
                let target = action.targetFrame
                let mainFrame = target?.isMainFrame ?? action.sourceFrame.isMainFrame
                let allowed = navigation?.permits(
                    action.request.url?.absoluteString ?? "", mainFrame: mainFrame,
                    newAttempt: action.navigationType == .linkActivated
                )
                guard allowed == true, target != nil, !action.shouldPerformDownload else {
                    decisionHandler(.cancel)
                    return
                }
                let method = action.request.httpMethod ?? "GET"
                let readable = method == "GET" || method == "HEAD"
                if !readable, mainFrame { navigation?.failed() }
                decisionHandler(readable ? .allow : .cancel)
            }

            func webView(
                _: WKWebView, decidePolicyFor response: WKNavigationResponse,
                decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
            ) {
                let url = response.response.url?.absoluteString ?? ""
                let allowed = navigation?.permits(url, mainFrame: response.isForMainFrame) == true
                let status = (response.response as? HTTPURLResponse)?.statusCode ?? 0
                let readable = response.canShowMIMEType && status < 400
                if allowed, response.isForMainFrame {
                    if readable { navigation?.started(url) } else { navigation?.failed() }
                }
                decisionHandler(allowed && readable ? .allow : .cancel)
            }

            func webView(_ webView: WKWebView, didStartProvisionalNavigation started: WKNavigation!) {
                activeNavigation = started
                if let url = webView.url?.absoluteString { navigation?.started(url) }
            }

            func webView(
                _ webView: WKWebView,
                didReceiveServerRedirectForProvisionalNavigation redirect: WKNavigation!
            ) {
                guard redirect === activeNavigation else { return }
                if let url = webView.url?.absoluteString, navigation?.permits(url, mainFrame: true) == false {
                    webView.stopLoading()
                }
            }

            func webView(_ webView: WKWebView, didFinish finished: WKNavigation!) {
                guard finished === activeNavigation else { return }
                activeNavigation = nil
                if let url = webView.url?.absoluteString { navigation?.finished(url) }
            }

            func webView(_: WKWebView, didFailProvisionalNavigation failed: WKNavigation!, withError error: any Error) {
                handleFailure(failed, error: error)
            }

            func webView(_: WKWebView, didFail failed: WKNavigation!, withError error: any Error) {
                handleFailure(failed, error: error)
            }

            func webViewWebContentProcessDidTerminate(_: WKWebView) {
                activeNavigation = nil
                navigation?.failed()
            }

            private func handleFailure(_ failed: WKNavigation?, error: any Error) {
                guard failed === activeNavigation else { return }
                activeNavigation = nil
                // A redirect blocked by the rules can fail before a response arrives. Use the
                // destination from WebKit when it is available.
                let url = (error as NSError).userInfo[NSURLErrorFailingURLStringErrorKey] as? String
                navigation?.failed(url: url)
            }

            func webView(
                _: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?)
                    -> Void
            ) {
                let method = challenge.protectionSpace.authenticationMethod
                completionHandler(PrototypeWebView.challengeDisposition(authenticationMethod: method), nil)
            }

            func webView(
                _: WKWebView, createWebViewWith _: WKWebViewConfiguration, for _: WKNavigationAction,
                windowFeatures _: WKWindowFeatures
            )
                -> WKWebView? { nil }

            func webView(
                _: WKWebView, requestMediaCapturePermissionFor _: WKSecurityOrigin, initiatedByFrame _: WKFrameInfo,
                type _: WKMediaCaptureType,
                decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
            ) {
                decisionHandler(.deny)
            }

            func webView(
                _: WKWebView, requestDeviceOrientationAndMotionPermissionFor _: WKSecurityOrigin,
                initiatedByFrame _: WKFrameInfo,
                decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
            ) {
                decisionHandler(.deny)
            }
        }
    }

    extension WKWebView: PrototypeWebPage {
        func loadPage(_ url: URL) { _ = load(URLRequest(url: url)) }
        func backPage() { _ = goBack() }
        func reloadPage() { _ = reload() }
    }
#endif
