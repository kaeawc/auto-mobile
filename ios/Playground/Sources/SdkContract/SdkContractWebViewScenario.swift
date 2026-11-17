import AutoMobileSDK
import Foundation
import os
import UIKit
import WebKit

struct WebViewPageEvent: Codable, Equatable, Sendable {
    let kind: String
    let clicks: Int
    let value: String
    let document: String
    let documentId: String?
}

struct WebViewCapture: Encodable, Equatable, Sendable {
    let snapshotId: String
    let documentId: String
}

struct WebViewRejection: Encodable, Equatable, Sendable {
    let snapshotId: String
    let documentId: String
    let domain: String
    let code: Int
}

/// Page-reported effects and the bridge's own stale-action error, independent of MCP replies.
struct WebViewHostLog: Encodable, Sendable {
    let origin: String
    let disallowedOrigin: String
    var pageEvents: [WebViewPageEvent] = []
    var captures: [WebViewCapture] = []
    var rejections: [WebViewRejection] = []
    var staleProbeAccepted: Bool?
}

/// Phase E's real, visible WKWebView. The harness can only request a fixed navigation via a
/// marker; the page-to-host message handler accepts telemetry, never JavaScript to execute.
@MainActor
final class SdkContractWebViewScenario: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    nonisolated static let scenario = "web-view"
    nonisolated static let webViewId = "contract-web-view"
    nonisolated static let buttonId = "contract-web-button"
    nonisolated static let inputId = "contract-web-input"
    nonisolated static let buttonLabel = "Contract web increment"
    nonisolated static let inputLabel = "Contract web input"

    let webView = WKWebView()
    let bridge: AutoMobileWebViewBridge
    private let state: OSAllocatedUnfairLock<WebViewHostLog>
    private var window: UIWindow?
    private var otherWindows: [(window: UIWindow, isHidden: Bool, isKeyWindow: Bool)] = []
    private var failure: Error?

    init(origin: String, disallowedOrigin: String) {
        let state = OSAllocatedUnfairLock(initialState: WebViewHostLog(
            origin: origin, disallowedOrigin: disallowedOrigin
        ))
        self.state = state
        bridge = AutoMobileWebViewBridge(
            webViewId: Self.webViewId,
            configuration: .init(allowedOrigins: [origin], redactText: false),
            emitEvent: { event in
                if event.name == "snapshot",
                   let snapshotId = event.metadata["snapshotId"],
                   let documentId = event.metadata["documentId"]
                {
                    state.withLock { $0.captures.append(.init(snapshotId: snapshotId, documentId: documentId)) }
                }
                AutoMobileSDK.shared.recordWebViewEvent(event)
            }
        )
        super.init()
    }

    func registerWebView() {
        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "contractLog")
        bridge.register(webView)
        AutoMobileWebViewRegistry.shared.register(bridge)
    }

    func stop() {
        AutoMobileWebViewRegistry.shared.unregister(webViewId: Self.webViewId)
        bridge.detach()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "contractLog")
        window?.isHidden = true
        window = nil
        let previousKeyWindow = otherWindows.first { $0.isKeyWindow }?.window
        for saved in otherWindows {
            saved.window.isHidden = saved.isHidden
        }
        otherWindows.removeAll()
        if let previousKeyWindow, !previousKeyWindow.isHidden {
            previousKeyWindow.makeKey()
        }
    }

    func log() -> WebViewHostLog { state.withLock { $0 } }

    func start(url: URL) async throws {
        try await waitUntil { UIApplication.shared.connectedScenes.contains { $0 is UIWindowScene } }
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
            throw SdkContractError.timedOut(seconds: 30)
        }
        // A key window does not remove Playground's list from the XCTest hierarchy.
        // The runner defers stop(), restoring these states even when startup fails.
        otherWindows = scene.windows.map { ($0, $0.isHidden, $0.isKeyWindow) }
        for saved in otherWindows {
            saved.window.isHidden = true
        }
        registerWebView()
        let controller = UIViewController()
        controller.view = webView
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        webView.load(URLRequest(url: url))
        try await waitUntil {
            let log = self.log()
            return !log.captures.isEmpty
                && ["ready", "allowed-frame", "disallowed-frame"].allSatisfy { kind in
                    log.pageEvents.contains { $0.kind == kind }
                }
        }
    }

    /// Keep DOM ids and the text selector the same so MCP re-resolves against the new document.
    /// The probe uses the previous snapshot id and logs the bridge error without executing a click.
    func navigate(url: URL) async throws {
        guard let previous = log().captures.last else {
            throw SdkContractError.unexpectedResponse("web fixture has no initial snapshot")
        }
        webView.endEditing(true)
        webView.load(URLRequest(url: url))
        try await waitUntil {
            let log = self.log()
            return (log.captures.last.map { $0.documentId != previous.documentId } ?? false)
                && log.pageEvents.contains { $0.kind == "ready" && $0.document == url.path }
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            bridge.perform(.click(snapshotId: previous.snapshotId, elementId: Self.buttonId)) { [state] result in
                switch result {
                case .success:
                    state.withLock { $0.staleProbeAccepted = true }
                    continuation.resume()
                case let .failure(error):
                    let nsError = error as NSError
                    state.withLock {
                        $0.staleProbeAccepted = false
                        $0.rejections.append(.init(
                            snapshotId: previous.snapshotId, documentId: previous.documentId,
                            domain: nsError.domain, code: nsError.code
                        ))
                    }
                    continuation.resume()
                }
            }
        }
    }

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        // WKScriptMessage.body is a dynamic WebKit boundary; the fixture payload itself is Codable.
        guard message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.host == "127.0.0.1",
              message.frameInfo.request.url?.port == URL(string: log().origin)?.port,
              let data = try? JSONSerialization.data(withJSONObject: message.body),
              let event = try? JSONDecoder().decode(WebViewPageEvent.self, from: data)
        else { return }
        state.withLock {
            // The bridge's isolated content world owns the document id. Attribute telemetry to
            // its last accepted capture; the harness observes that capture before each action.
            $0.pageEvents.append(.init(
                kind: event.kind, clicks: event.clicks, value: event.value, document: event.document,
                documentId: $0.captures.last?.documentId
            ))
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        bridge.webView(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        bridge.webView(webView, didFinish: navigation)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        bridge.webView(webView, didFail: navigation, withError: error)
        failure = error
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        failure = error
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        bridge.webViewWebContentProcessDidTerminate(webView)
    }

    private func waitUntil(_ ready: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(30)
        while !ready() {
            if let failure { throw failure }
            guard Date() < deadline else { throw SdkContractError.timedOut(seconds: 30) }
            try await Task.sleep(nanoseconds: SdkContractRunner.capturePollNanoseconds)
        }
    }

    /// Only fixed fixture script; neither the URL nor a harness argument supplies executable text.
    static func page(framePath: String, disallowedFrameURL: String) -> String {
        return #"""
        <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body { margin:24px; padding-top:200px; font:18px sans-serif }
        button,input { display:block; box-sizing:border-box; width:min(280px,100%); height:44px; margin-bottom:12px }
        #counter { margin:0 0 12px; line-height:24px }
        iframe { display:block; box-sizing:border-box; width:min(290px,100%); height:70px; margin-top:12px }</style></head><body>
        <button data-automobile-id="\#(buttonId)" aria-label="\#(buttonLabel)">\#(buttonLabel)</button>
        <p id="counter" role="status"></p>
        <input data-automobile-id="\#(inputId)" aria-label="\#(inputLabel)" value="initial">
        <iframe title="Allowed contract frame" src="\#(framePath)"></iframe>
        <iframe title="Disallowed contract frame" src="\#(disallowedFrameURL)"></iframe>
        <script>
        const button = document.querySelector('button'), field = document.querySelector('input');
        let clicks = Number(sessionStorage.getItem('contract-clicks') || '0');
        const counter = document.getElementById('counter'); counter.textContent = 'Clicks: ' + clicks;
        const report = kind => window.webkit.messageHandlers.contractLog.postMessage({kind, clicks, value:field.value, document:location.pathname});
        button.addEventListener('click', () => { clicks++; sessionStorage.setItem('contract-clicks', String(clicks)); counter.textContent = 'Clicks: ' + clicks; report('click'); });
        field.addEventListener('input', () => report('input'));
        addEventListener('message', event => {
          if (event.source === document.querySelectorAll('iframe')[0].contentWindow && event.origin === location.origin && event.data === 'allowed') report('allowed-frame');
          if (event.source === document.querySelectorAll('iframe')[1].contentWindow && event.origin === new URL('\#(
              disallowedFrameURL
          )').origin && event.data === 'disallowed') report('disallowed-frame');
        });
        addEventListener('load', () => report('ready'));
        </script></body></html>
        """#
    }

    static func frame(allowed: Bool) -> String {
        let kind = allowed ? "allowed" : "disallowed"
        return """
        <!doctype html><html><body><button data-automobile-id="contract-web-\(kind)">Contract \(kind) frame</button>
        <script>addEventListener('load', () => parent.postMessage('\(kind)', '*'));</script></body></html>
        """
    }
}
