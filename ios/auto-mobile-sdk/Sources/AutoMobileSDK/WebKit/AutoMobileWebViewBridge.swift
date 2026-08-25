import Foundation

/// A stable description of an interactive element in a web document.
public struct AutoMobileWebElement: Codable, Sendable, Equatable {
    public let id: String
    public let role: String?
    public let label: String?
    public let value: String?
    public let bounds: [Double]
    public let enabled: Bool
    public let visible: Bool
    public let focused: Bool

    public init(
        id: String,
        role: String? = nil,
        label: String? = nil,
        value: String? = nil,
        bounds: [Double] = [],
        enabled: Bool = true,
        visible: Bool = true,
        focused: Bool = false
    ) {
        self.id = id
        self.role = role
        self.label = label
        self.value = value
        self.bounds = bounds
        self.enabled = enabled
        self.visible = visible
        self.focused = focused
    }
}

/// A bounded DOM snapshot. Element IDs are valid only for this snapshot.
public struct AutoMobileWebSnapshot: Codable, Sendable, Equatable {
    public let snapshotId: String
    public let url: String?
    public let title: String?
    public let elements: [AutoMobileWebElement]

    public init(
        snapshotId: String = UUID().uuidString,
        url: String? = nil,
        title: String? = nil,
        elements: [AutoMobileWebElement] = []
    ) {
        self.snapshotId = snapshotId
        self.url = url
        self.title = title
        self.elements = elements
    }
}

/// Policy for attaching the bridge to a web view.
public struct AutoMobileWebViewConfiguration: Sendable {
    public let allowedOrigins: Set<String>
    public let allowedFrames: Set<String>
    public let maxElements: Int
    public let maxMessageBytes: Int
    public let contentWorldName: String
    public let redactText: Bool

    public init(
        allowedOrigins: Set<String> = [],
        allowedFrames: Set<String> = [],
        maxElements: Int = 500,
        maxMessageBytes: Int = 256 * 1024,
        contentWorldName: String = "AutoMobile",
        redactText: Bool = true
    ) {
        self.allowedOrigins = allowedOrigins
        self.allowedFrames = allowedFrames
        self.maxElements = max(maxElements, 1)
        self.maxMessageBytes = max(maxMessageBytes, 1024)
        self.contentWorldName = contentWorldName
        self.redactText = redactText
    }
}

/// Actions accepted by the web bridge. Each action must name the snapshot it
/// was derived from, preventing stale element IDs from being reused.
public enum AutoMobileWebAction: Codable, Sendable, Equatable {
    case click(snapshotId: String, elementId: String)
    case focus(snapshotId: String, elementId: String)
    case insertText(snapshotId: String, elementId: String, text: String)
    case select(snapshotId: String, elementId: String, value: String)
    case scroll(snapshotId: String, elementId: String?, x: Double, y: Double)
    case evaluateJavaScript(String)
}

/// WebKit and DOM lifecycle event emitted by ``AutoMobileWebViewBridge``.
public struct SdkWebViewEvent: SdkEvent {
    public private(set) var eventType: SdkEventType = .webView
    public let timestamp: Int64
    public let webViewId: String
    public let name: String
    public let url: String?
    public let frameId: String?
    public let requestId: String?
    public let metadata: [String: String]

    public init(
        timestamp: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        webViewId: String,
        name: String,
        url: String? = nil,
        frameId: String? = nil,
        requestId: String? = nil,
        metadata: [String: String] = [:]
    ) {
        self.timestamp = timestamp
        self.webViewId = webViewId
        self.name = name
        self.url = url
        self.frameId = frameId
        self.requestId = requestId
        self.metadata = metadata
    }
}

/// Validates bridge policy and action references without requiring WebKit.
public final class AutoMobileWebViewPolicy: @unchecked Sendable {
    private let configuration: AutoMobileWebViewConfiguration
    private let lock = NSLock()
    private var latestSnapshots: [String: AutoMobileWebSnapshot] = [:]

    public init(configuration: AutoMobileWebViewConfiguration = .init()) {
        self.configuration = configuration
    }

    public func allows(url: URL?, frameId: String?) -> Bool {
        guard let url, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            return false
        }
        let origin = "\(scheme)://\(url.host ?? "")\(url.port.map { ":\($0)" } ?? "")"
        let originAllowed = configuration.allowedOrigins.contains(origin)
        let frameAllowed = frameId.map { configuration.allowedFrames.isEmpty || configuration.allowedFrames.contains($0) } ?? configuration.allowedFrames.isEmpty
        return originAllowed && frameAllowed
    }

    public func accept(_ snapshot: AutoMobileWebSnapshot) -> AutoMobileWebSnapshot {
        let bounded = AutoMobileWebSnapshot(
            snapshotId: snapshot.snapshotId,
            url: snapshot.url,
            title: snapshot.title,
            elements: Array(snapshot.elements.prefix(configuration.maxElements)).map { element in
                guard configuration.redactText else { return element }
                return AutoMobileWebElement(
                    id: element.id, role: element.role, label: element.label,
                    value: element.value == nil ? nil : "[REDACTED]",
                    bounds: element.bounds, enabled: element.enabled,
                    visible: element.visible, focused: element.focused
                )
            }
        )
        lock.lock()
        latestSnapshots[bounded.snapshotId] = bounded
        if latestSnapshots.count > 4, let first = latestSnapshots.keys.sorted().first {
            latestSnapshots.removeValue(forKey: first)
        }
        lock.unlock()
        return bounded
    }

    public func validates(_ action: AutoMobileWebAction) -> Bool {
        guard case .evaluateJavaScript = action else {
            let snapshotId: String
            let elementId: String?
            switch action {
            case let .click(id, element): snapshotId = id; elementId = element
            case let .focus(id, element): snapshotId = id; elementId = element
            case let .insertText(id, element, _): snapshotId = id; elementId = element
            case let .select(id, element, _): snapshotId = id; elementId = element
            case let .scroll(id, element, _, _): snapshotId = id; elementId = element
            case .evaluateJavaScript: return false
            }
            lock.lock()
            defer { lock.unlock() }
            guard let snapshot = latestSnapshots[snapshotId] else { return false }
            return elementId.map { element in
                snapshot.elements.contains { $0.id == element && $0.enabled && $0.visible }
            } ?? true
        }
        return false
    }
}

#if canImport(WebKit)
import WebKit

/// Opt-in WKWebView observation and bounded control bridge.
public final class AutoMobileWebViewBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, @unchecked Sendable {
    public let webViewId: String
    public let configuration: AutoMobileWebViewConfiguration
    public let policy: AutoMobileWebViewPolicy
    private let emitEvent: @Sendable (SdkWebViewEvent) -> Void
    private let recorder: NetworkCaptureRecorder?
    private weak var webView: WKWebView?
    private let requestLock = NSLock()
    private var nativeRequestIds: [String: String] = [:]

    public init(
        webViewId: String = UUID().uuidString,
        configuration: AutoMobileWebViewConfiguration = .init(),
        recorder: NetworkCaptureRecorder? = nil,
        emitEvent: @escaping @Sendable (SdkWebViewEvent) -> Void = { event in
            AutoMobileSDK.shared.recordWebViewEvent(event)
        }
    ) {
        self.webViewId = webViewId
        self.configuration = configuration
        self.policy = AutoMobileWebViewPolicy(configuration: configuration)
        self.recorder = recorder
        self.emitEvent = emitEvent
    }

    public func attach(to webView: WKWebView) {
        self.webView = webView
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "automobile")
        let world = WKContentWorld.world(name: configuration.contentWorldName)
        controller.add(self, contentWorld: world, name: "automobile")
        controller.addUserScript(WKUserScript(source: Self.script, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: world))
        webView.navigationDelegate = self
        emit(name: "bridge_attached", url: webView.url)
    }

    public func detach() {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "automobile")
        webView?.navigationDelegate = nil
        webView = nil
    }

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let bodyData = try? JSONSerialization.data(withJSONObject: message.body),
           bodyData.count > configuration.maxMessageBytes {
            return
        }
        guard let body = message.body as? [String: Any],
              let name = body["name"] as? String else { return }
        let url = webView?.url
        guard policy.allows(url: url, frameId: body["frameId"] as? String) else { return }
        var metadata = body.compactMapValues { value -> String? in
            guard !(value is [Any]) && !(value is [String: Any]) else { return nil }
            return String(describing: value)
        }
        metadata.removeValue(forKey: "name")
        let scriptRequestId = body["requestId"] as? String
        var requestId = scriptRequestId
        if name == "request_started", let scriptRequestId,
           let requestURL = body["url"] as? String {
            #if DEBUG
            if let fault = NetworkMockRuleStore.shared.evaluate(.init(
                transport: .webView,
                host: URL(string: requestURL)?.host,
                port: URL(string: requestURL)?.port,
                scheme: URL(string: requestURL)?.scheme,
                path: URL(string: requestURL)?.path,
                method: (body["method"] as? String) ?? "GET",
                headers: [:],
                origin: url?.absoluteString,
                connectionId: webViewId,
                sessionId: nil
            )) {
                metadata["fault_id"] = fault.faultId
                metadata["fault_action"] = fault.action.rawValue
                if fault.dryRun == false, fault.action == .rejectFrame || fault.action == .closeConnection {
                    metadata["fault_rejected"] = "true"
                }
            }
            #endif
            let nativeId = recorder?.beginRequest(
                url: requestURL,
                method: (body["method"] as? String) ?? "GET",
                connectionId: webViewId,
                protocolName: "webview"
            )
            if let nativeId {
                requestLock.lock()
                nativeRequestIds[scriptRequestId] = nativeId
                requestLock.unlock()
                requestId = nativeId
            }
        } else if let scriptRequestId {
            requestLock.lock()
            requestId = nativeRequestIds[scriptRequestId] ?? scriptRequestId
            if name == "request_finished" || name == "request_failed" {
                nativeRequestIds.removeValue(forKey: scriptRequestId)
            }
            requestLock.unlock()
        }
        if name == "request_finished", let requestId {
            recorder?.recordCompletion(requestId: requestId, statusCode: body["status"] as? Int)
        } else if name == "request_failed", let requestId {
            recorder?.recordFailure(requestId: requestId, error: (body["error"] as? String) ?? "Web request failed")
        }
        if name == "snapshot", let elements = body["elements"] as? [[String: Any]] {
            let decoded = elements.prefix(configuration.maxElements).compactMap { element -> AutoMobileWebElement? in
                guard let id = element["id"] as? String else { return nil }
                let bounds = (element["bounds"] as? [NSNumber])?.map(\.doubleValue) ?? []
                return AutoMobileWebElement(
                    id: id,
                    role: element["role"] as? String,
                    label: element["label"] as? String,
                    value: element["value"] as? String,
                    bounds: bounds,
                    enabled: (element["enabled"] as? Bool) ?? true,
                    visible: (element["visible"] as? Bool) ?? true,
                    focused: (element["focused"] as? Bool) ?? false
                )
            }
            _ = policy.accept(AutoMobileWebSnapshot(snapshotId: body["snapshotId"] as? String ?? UUID().uuidString, url: url?.absoluteString, elements: decoded))
        }
        emit(name: name, url: url, frameId: body["frameId"] as? String, requestId: requestId, metadata: metadata)
    }

    public func perform(_ action: AutoMobileWebAction, completion: @escaping (Result<Void, Error>) -> Void) {
        // WKWebView (evaluateJavaScript, url, navigationDelegate) is main-thread only, but a
        // host app may call this from any thread. Assert in debug to surface the misuse, and
        // in any build re-dispatch to the main thread when off it rather than touching WebKit
        // off-main. `perform` is already completion-based, so an async hop preserves its
        // contract and cannot deadlock.
        assert(Thread.isMainThread, "AutoMobileWebViewBridge.perform must be called on the main thread")
        if !Thread.isMainThread {
            DispatchQueue.main.async { self.perform(action, completion: completion) }
            return
        }
        guard policy.validates(action) || (ifEvaluate(action) && policy.allows(url: webView?.url, frameId: nil)) else {
            completion(.failure(NSError(domain: "AutoMobileWebViewBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "Stale or disallowed web action"])))
            return
        }
        let source: String
        switch action {
        case let .click(_, id): source = "document.querySelector('[data-automobile-id=\"\(id)\"]')?.click()"
        case let .focus(_, id): source = "document.querySelector('[data-automobile-id=\"\(id)\"]')?.focus()"
        case let .insertText(_, id, text): source = "(() => { const e=document.querySelector('[data-automobile-id=\"\(id)\"]'); e.value=\(Self.json(text)); e.dispatchEvent(new Event('input',{bubbles:true})); })()"
        case let .select(_, id, value): source = "(() => { const e=document.querySelector('[data-automobile-id=\"\(id)\"]'); e.value=\(Self.json(value)); e.dispatchEvent(new Event('change',{bubbles:true})); })()"
        case let .scroll(_, id, x, y): source = "document.querySelector('\(id.map { "[data-automobile-id=\"\($0)\"]" } ?? "body")')?.scrollBy(\(x),\(y))"
        case let .evaluateJavaScript(script): source = script
        }
        webView?.evaluateJavaScript(source) { _, error in
            if let error { completion(.failure(error)) } else { completion(.success(())) }
        }
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { emit(name: "navigation_finished", url: webView.url) }
    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { emit(name: "navigation_failed", url: webView.url, metadata: ["error": error.localizedDescription]) }
    public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { emit(name: "navigation_committed", url: webView.url) }
    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        emit(name: "content_process_terminated", url: webView.url)
        attach(to: webView)
        webView.reload()
    }

    private func ifEvaluate(_ action: AutoMobileWebAction) -> Bool {
        if case .evaluateJavaScript = action { return true }
        return false
    }
    private func emit(name: String, url: URL?, frameId: String? = nil, requestId: String? = nil, metadata: [String: String] = [:]) {
        emitEvent(SdkWebViewEvent(webViewId: webViewId, name: name, url: url?.absoluteString, frameId: frameId, requestId: requestId, metadata: metadata))
    }
    private static func json(_ string: String) -> String {
        (try? String(data: JSONEncoder().encode(string), encoding: .utf8)) ?? "\"\""
    }
    private static let script = #"""
    (() => {
      const post = (name, extra = {}) => window.webkit?.messageHandlers?.automobile?.postMessage({name, frameId: location.href, ...extra});
      const snapshot = () => {
        const elements = [...document.querySelectorAll('button,a,input,textarea,select,[role]')].map((e, i) => {
          const id = e.dataset.automobileId || (e.dataset.automobileId = `e${i}`);
          const r = e.getBoundingClientRect();
          return {id, role: e.getAttribute('role') || e.tagName.toLowerCase(), label: e.getAttribute('aria-label') || e.textContent?.trim().slice(0, 200), value: e.value || null, bounds: [r.x,r.y,r.width,r.height], enabled: !e.disabled, visible: r.width > 0 && r.height > 0, focused: document.activeElement === e};
        });
        post('snapshot', {snapshotId: `${Date.now()}-${Math.random()}`, elements});
      };
      new MutationObserver(snapshot).observe(document, {subtree:true, childList:true, attributes:true});
      addEventListener('load', snapshot); addEventListener('hashchange', () => post('spa_navigation')); addEventListener('popstate', () => post('history_navigation'));
      const push = history.pushState, replace = history.replaceState;
      history.pushState = (...a) => { const r = push.apply(history, a); post('history_navigation'); return r; };
      history.replaceState = (...a) => { const r = replace.apply(history, a); post('history_navigation'); return r; };
      addEventListener('error', e => post('javascript_exception', {message: e.message})); addEventListener('unhandledrejection', e => post('javascript_exception', {message: String(e.reason)}));
      for (const level of ['log','warn','error']) { const old = console[level]; console[level] = (...a) => { post('console', {level, message: a.map(String).join(' ')}); old.apply(console, a); }; }
      const oldFetch = window.fetch; window.fetch = (...a) => { const requestId = crypto.randomUUID(); post('request_started', {requestId, url: String(a[0]), method: a[1]?.method || a[0]?.method || 'GET'}); return oldFetch(...a).then(r => { post('request_finished', {requestId, url:r.url, status:r.status}); return r; }, e => { post('request_failed', {requestId, error:String(e)}); throw e; }); };
      const oldOpen = XMLHttpRequest.prototype.open, oldSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url) { this.__automobile = {requestId: crypto.randomUUID(), method, url:String(url)}; return oldOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function(body) { const x = this.__automobile || {requestId:crypto.randomUUID(), method:'GET', url:location.href}; post('request_started', x); this.addEventListener('loadend', () => post(this.status >= 400 ? 'request_failed' : 'request_finished', {requestId:x.requestId, url:x.url, status:this.status})); return oldSend.apply(this, arguments); };
      const NativeWebSocket = window.WebSocket; window.WebSocket = function(url, protocols) { const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols); const connectionId = crypto.randomUUID(); post('websocket_started', {url:String(url), connectionId}); ws.addEventListener('message', e => post('websocket_received', {url:String(url), connectionId, payloadSize: String(e.data).length})); const send = ws.send; ws.send = function(data) { post('websocket_sent', {url:String(url), connectionId, payloadSize:String(data).length}); return send.call(ws, data); }; ws.addEventListener('close', () => post('websocket_closed', {url:String(url), connectionId})); return ws; }; window.WebSocket.prototype = NativeWebSocket.prototype;
    })();
    """#
}
#endif
