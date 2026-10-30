import AutoMobileSdkWire
import Foundation
import os

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
    /// Focus the element, set its value and dispatch `input` and `change` (#5162).
    case setValue(snapshotId: String, elementId: String, text: String)
    /// Set the element's value to `""` and dispatch `input` and `change` (#5162).
    case clear(snapshotId: String, elementId: String)
    /// Scroll the element into the center of the viewport (#5162).
    case scrollIntoView(snapshotId: String, elementId: String)
    /// Submit the element's enclosing form, as the IME `done` action does (#5162).
    case submit(snapshotId: String, elementId: String)
    case evaluateJavaScript(String)
}

/// The JavaScript each bounded ``AutoMobileWebAction`` runs (#5162). An element id comes from the
/// page, so it never becomes JavaScript source: it is a JSON string literal, matched through
/// `CSS.escape`, and cannot break out of the selector or the script.
enum AutoMobileWebActionScript {
    /// The script for a bounded action; nil for ``AutoMobileWebAction/evaluateJavaScript(_:)``.
    static func source(for action: AutoMobileWebAction) -> String? {
        switch action {
        case let .click(_, id): element(id, "e.click();")
        case let .focus(_, id): element(id, "e.focus();")
        case let .insertText(_, id, text): element(id, "e.value=\(json(text)); \(events("input"))")
        case let .select(_, id, value): element(id, "e.value=\(json(value)); \(events("change"))")
        case let .scroll(_, id, x, y):
            id.map { element($0, "e.scrollBy(\(x),\(y));") } ?? "document.body.scrollBy(\(x),\(y));"
        case let .setValue(_, id, text):
            element(id, "e.focus(); e.value=\(json(text)); \(events("input", "change"))")
        case let .clear(_, id): element(id, "e.value=''; \(events("input", "change"))")
        case let .scrollIntoView(_, id): element(id, "e.scrollIntoView({block:'center',inline:'center'});")
        case let .submit(_, id):
            element(
                id,
                "const f=e.form||e.closest('form'); if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); }"
            )
        case .evaluateJavaScript: nil
        }
    }

    /// Runs `body` with `e` bound to the element whose `data-automobile-id` is `id`. A missing
    /// element throws, so the action is reported as `javascript_error` rather than accepted with
    /// nothing done (#15877).
    private static func element(_ id: String, _ body: String) -> String {
        "(() => { const id=\(json(id)); "
            + "const e=document.querySelector('[data-automobile-id=\"'+CSS.escape(id)+'\"]'); "
            + "if (!e) { throw new Error('automobile element not found: '+id); } \(body) })()"
    }

    private static func events(_ names: String...) -> String {
        names.map { "e.dispatchEvent(new Event('\($0)',{bubbles:true}));" }.joined(separator: " ")
    }

    static func json(_ string: String) -> String {
        (try? String(data: JSONEncoder().encode(string), encoding: .utf8)) ?? "\"\""
    }
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
public final class AutoMobileWebViewPolicy: Sendable {
    private let configuration: AutoMobileWebViewConfiguration
    private let lock = OSAllocatedUnfairLock<[String: AutoMobileWebSnapshot]>(initialState: [:])
    private let latest = OSAllocatedUnfairLock<AutoMobileWebSnapshot?>(initialState: nil)

    public init(configuration: AutoMobileWebViewConfiguration = .init()) {
        self.configuration = configuration
    }

    public func allows(url: URL?, frameId: String?) -> Bool {
        let frameAllowed = frameId
            .map { configuration.allowedFrames.isEmpty || configuration.allowedFrames.contains($0) } ?? configuration
            .allowedFrames.isEmpty
        return allowsOrigin(url: url) && frameAllowed
    }

    /// Whether the page's origin is allowed, regardless of frame (#5162). The routes check the page
    /// with this; each snapshot's frame was already checked by ``allows(url:frameId:)`` when the
    /// page posted it.
    func allowsOrigin(url: URL?) -> Bool {
        guard let url, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            return false
        }
        let origin = "\(scheme)://\(url.host ?? "")\(url.port.map { ":\($0)" } ?? "")"
        return configuration.allowedOrigins.contains(origin)
    }

    /// Drops every recent snapshot, so none from a terminated page is served or acted on (#5162).
    func forgetSnapshots() {
        lock.withLock { $0.removeAll() }
        latest.withLock { $0 = nil }
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
                    visible: element.visible, focused: element.focused,
                    inputType: element.inputType
                )
            },
            viewport: snapshot.viewport,
            documentId: snapshot.documentId
        )
        lock.withLock { latestSnapshots in
            latestSnapshots[bounded.snapshotId] = bounded
            if latestSnapshots.count > 4, let first = latestSnapshots.keys.min() {
                latestSnapshots.removeValue(forKey: first)
            }
        }
        latest.withLock { $0 = bounded }
        return bounded
    }

    /// The most recent snapshot this policy accepted, already bounded and redacted (#5162).
    var latestSnapshot: AutoMobileWebSnapshot? {
        latest.withLock { $0 }
    }

    /// The largest message the bridge accepts or serves, in bytes.
    var maxMessageBytes: Int {
        configuration.maxMessageBytes
    }

    /// Origins this policy allows, for discovery.
    var allowedOrigins: [String] {
        Array(configuration.allowedOrigins)
    }

    /// Why a controller action may not run against the recent snapshots, or nil when it may (#5162).
    func rejection(for action: AutoMobileWebControlAction) -> String? {
        lock.withLock { latestSnapshots in
            guard let snapshot = latestSnapshots[action.snapshotId] else {
                return AutoMobileWebActionResult.staleSnapshotReason
            }
            guard let elementId = action.elementId else { return nil }
            let actionable = snapshot.elements.contains { $0.id == elementId && $0.enabled && $0.visible }
            return actionable ? nil : AutoMobileWebActionResult.elementNotActionableReason
        }
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
            case let .setValue(id, element, _): snapshotId = id; elementId = element
            case let .clear(id, element): snapshotId = id; elementId = element
            case let .scrollIntoView(id, element): snapshotId = id; elementId = element
            case let .submit(id, element): snapshotId = id; elementId = element
            case .evaluateJavaScript: return false
            }
            return lock.withLock { latestSnapshots in
                guard let snapshot = latestSnapshots[snapshotId] else { return false }
                return elementId.map { element in
                    snapshot.elements.contains { $0.id == element && $0.enabled && $0.visible }
                } ?? true
            }
        }
        return false
    }
}

/// A web view's page as the routes see it (#5162): the last URL and whether its content process
/// is alive. Only a load or a fresh snapshot from the page restores a terminated process;
/// reattaching after termination does not.
struct AutoMobileWebPageState: Equatable, Sendable {
    private(set) var url: URL?
    private(set) var contentProcessAvailable = true

    /// The bridge attached, or reattached after termination: record the URL only.
    mutating func attached(url: URL?) {
        if let url { self.url = url }
    }

    /// A navigation committed or finished, or the page posted a message: the process is alive.
    mutating func loaded(url: URL?) {
        if let url { self.url = url }
        contentProcessAvailable = true
    }

    mutating func terminated(url: URL?) {
        if let url { self.url = url }
        contentProcessAvailable = false
    }
}

extension AutoMobileWebAction {
    /// The bridge action for a controller action (#5162). Every controller action is bounded.
    init(_ action: AutoMobileWebControlAction) {
        switch action {
        case let .click(snapshot, element): self = .click(snapshotId: snapshot, elementId: element)
        case let .focus(snapshot, element): self = .focus(snapshotId: snapshot, elementId: element)
        case let .insertText(snapshot, element, text):
            self = .insertText(snapshotId: snapshot, elementId: element, text: text)
        case let .select(snapshot, element, value):
            self = .select(snapshotId: snapshot, elementId: element, value: value)
        case let .scroll(snapshot, element, x, y): self = .scroll(snapshotId: snapshot, elementId: element, x: x, y: y)
        case let .setValue(snapshot, element, text):
            self = .setValue(snapshotId: snapshot, elementId: element, text: text)
        case let .clear(snapshot, element): self = .clear(snapshotId: snapshot, elementId: element)
        case let .scrollIntoView(snapshot, element): self = .scrollIntoView(snapshotId: snapshot, elementId: element)
        case let .submit(snapshot, element): self = .submit(snapshotId: snapshot, elementId: element)
        }
    }
}

#if canImport(WebKit)
    import WebKit

    /// Opt-in WKWebView observation and bounded control bridge.
    public final class AutoMobileWebViewBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate,
        @unchecked Sendable
    {
        public let webViewId: String
        public let configuration: AutoMobileWebViewConfiguration
        public let policy: AutoMobileWebViewPolicy
        private let emitEvent: @Sendable (SdkWebViewEvent) -> Void
        private let recorder: NetworkCaptureRecorder?
        private weak var webView: WKWebView?
        private let requestLock = OSAllocatedUnfairLock<[String: String]>(initialState: [:])
        /// The last committed URL and whether the web content process is alive, readable off-main.
        private let pageState = OSAllocatedUnfairLock<AutoMobileWebPageState>(initialState: .init())

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
            policy = AutoMobileWebViewPolicy(configuration: configuration)
            self.recorder = recorder
            self.emitEvent = emitEvent
        }

        public func attach(to webView: WKWebView) {
            self.webView = webView
            let url = webView.url
            pageState.withLock { $0.attached(url: url) }
            let controller = webView.configuration.userContentController
            controller.removeScriptMessageHandler(forName: "automobile")
            let world = WKContentWorld.world(name: configuration.contentWorldName)
            controller.add(self, contentWorld: world, name: "automobile")
            controller.addUserScript(WKUserScript(
                source: Self.script,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false,
                in: world
            ))
            webView.navigationDelegate = self
            emit(name: "bridge_attached", url: webView.url)
        }

        public func detach() {
            webView?.configuration.userContentController.removeScriptMessageHandler(forName: "automobile")
            webView?.navigationDelegate = nil
            webView = nil
        }

        private func trackRequest(
            name: String,
            body: [String: Any],
            url: URL?,
            metadata: inout [String: String]
        )
            -> String?
        {
            let scriptRequestId = body["requestId"] as? String
            var requestId = scriptRequestId
            if name == "request_started", let scriptRequestId,
               let requestURL = body["url"] as? String
            {
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
                    requestLock.withLock { nativeRequestIds in
                        nativeRequestIds[scriptRequestId] = nativeId
                    }
                    requestId = nativeId
                }
            } else if let scriptRequestId {
                requestId = requestLock.withLock { nativeRequestIds in
                    let nativeId = nativeRequestIds[scriptRequestId] ?? scriptRequestId
                    if name == "request_finished" || name == "request_failed" {
                        nativeRequestIds.removeValue(forKey: scriptRequestId)
                    }
                    return nativeId
                }
            }
            if name == "request_finished", let requestId {
                recorder?.recordCompletion(requestId: requestId, statusCode: body["status"] as? Int)
            } else if name == "request_failed", let requestId {
                recorder?.recordFailure(requestId: requestId, error: (body["error"] as? String) ?? "Web request failed")
            }
            return requestId
        }

        public func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
            if let bodyData = try? JSONSerialization.data(withJSONObject: message.body),
               bodyData.count > configuration.maxMessageBytes
            {
                return
            }
            guard let body = message.body as? [String: Any],
                  let name = body["name"] as? String else { return }
            let url = webView?.url
            guard policy.allows(url: url, frameId: body["frameId"] as? String) else { return }
            pageState.withLock { $0.loaded(url: url) }
            var metadata = body.compactMapValues { value -> String? in
                guard !(value is [Any]), !(value is [String: Any]) else { return nil }
                return String(describing: value)
            }
            metadata.removeValue(forKey: "name")
            let requestId = trackRequest(name: name, body: body, url: url, metadata: &metadata)
            // Only the main frame's document is snapshotted: element ids are per document, and the
            // action script resolves them in the main frame, so a frame's `e0` could reach another
            // element (#15877).
            if name == "snapshot", message.frameInfo.isMainFrame, let elements = body["elements"] as? [[String: Any]] {
                let decoded = elements.prefix(configuration.maxElements)
                    .compactMap { element -> AutoMobileWebElement? in
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
                            focused: (element["focused"] as? Bool) ?? false,
                            inputType: element["inputType"] as? String
                        )
                    }
                _ = policy.accept(AutoMobileWebSnapshot(
                    snapshotId: body["snapshotId"] as? String ?? UUID().uuidString,
                    url: url?.absoluteString,
                    elements: decoded,
                    viewport: Self.viewport(body["viewport"]),
                    documentId: body["documentId"] as? String
                ))
            }
            emit(name: name, url: url, frameId: body["frameId"] as? String, requestId: requestId, metadata: metadata)
        }

        /// The page's visual viewport, when it reported a usable one.
        static func viewport(_ value: Any?) -> AutoMobileWebViewport? {
            guard let fields = value as? [String: Any],
                  let width = (fields["width"] as? NSNumber)?.doubleValue, width > 0,
                  let height = (fields["height"] as? NSNumber)?.doubleValue, height > 0
            else { return nil }
            return AutoMobileWebViewport(
                offsetLeft: (fields["offsetLeft"] as? NSNumber)?.doubleValue ?? 0,
                offsetTop: (fields["offsetTop"] as? NSNumber)?.doubleValue ?? 0,
                width: width,
                height: height,
                scale: (fields["scale"] as? NSNumber)?.doubleValue ?? 1
            )
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
            guard policy.validates(action) || (ifEvaluate(action) && policy.allows(url: webView?.url, frameId: nil))
            else {
                completion(.failure(NSError(
                    domain: "AutoMobileWebViewBridge",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Stale or disallowed web action"]
                )))
                return
            }
            let source: String
            if case let .evaluateJavaScript(script) = action {
                source = script
            } else if let bounded = AutoMobileWebActionScript.source(for: action) {
                source = bounded
            } else {
                completion(.failure(NSError(
                    domain: "AutoMobileWebViewBridge",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Unsupported web action"]
                )))
                return
            }
            guard let webView else {
                // The web view is held weakly; without one there is nothing to run the action in,
                // and the completion must still be called (#15868).
                completion(.failure(NSError(
                    domain: "AutoMobileWebViewBridge",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "No web view is attached"]
                )))
                return
            }
            webView.evaluateJavaScript(source) { _, error in
                if let error { completion(.failure(error)) } else { completion(.success(())) }
            }
        }

        public func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
            let url = webView.url
            pageState.withLock { $0.loaded(url: url) }
            emit(name: "navigation_finished", url: url)
        }

        public func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError error: Error) { emit(
            name: "navigation_failed",
            url: webView.url,
            metadata: ["error": error.localizedDescription]
        ) }
        public func webView(_ webView: WKWebView, didCommit _: WKNavigation!) {
            let url = webView.url
            documentCommitted(url: url)
            emit(name: "navigation_committed", url: url)
        }

        /// A main-frame navigation committed, so the page is a new document, even on a reload of
        /// the same URL (#15868). The old snapshots describe elements that are gone, and their ids
        /// (such as `e0`) can name unrelated elements in the new page, so they are dropped: the
        /// snapshot route answers `no_snapshot`, and actions naming them are `stale_snapshot`.
        nonisolated func documentCommitted(url: URL?) {
            pageState.withLock { $0.loaded(url: url) }
            policy.forgetSnapshots()
        }

        public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            let url = webView.url
            pageState.withLock { $0.terminated(url: url) }
            policy.forgetSnapshots()
            emit(name: "content_process_terminated", url: url)
            attach(to: webView)
            webView.reload()
        }

        // MARK: AutoMobileWebViewControlling (#5162)

        // The WebKit conformances make the bridge main-actor isolated, but the SDK route handler
        // reads these off the main actor. Each one reads only lock-protected or Sendable state.

        nonisolated var bridgeEntry: WebViewBridgeEntry {
            let page = pageState.withLock { $0 }
            return WebViewBridgeEntry(
                webViewId: webViewId,
                url: page.url?.absoluteString,
                allowedOrigins: policy.allowedOrigins,
                contentProcessAvailable: page.contentProcessAvailable
            )
        }

        nonisolated var latestSnapshot: AutoMobileWebSnapshot? { policy.latestSnapshot }

        nonisolated var maxMessageBytes: Int { policy.maxMessageBytes }

        nonisolated var originAllowed: Bool {
            policy.allowsOrigin(url: pageState.withLock { $0.url })
        }

        nonisolated var contentProcessAvailable: Bool {
            pageState.withLock { $0.contentProcessAvailable }
        }

        nonisolated func perform(_ action: AutoMobileWebControlAction) async -> AutoMobileWebActionResult {
            if !contentProcessAvailable {
                return .rejected(AutoMobileWebActionResult.webProcessUnavailableReason)
            }
            if !originAllowed {
                return .rejected(AutoMobileWebActionResult.disallowedOriginReason)
            }
            if let reason = policy.rejection(for: action) {
                return .rejected(reason)
            }
            let bridgeAction = AutoMobileWebAction(action)
            return await withCheckedContinuation { continuation in
                Task { @MainActor in
                    // A deallocated or detached web view answers here rather than leaving the
                    // request suspended until the daemon times out (#15868).
                    guard self.webView != nil else {
                        continuation.resume(returning: .rejected(AutoMobileWebActionResult.webProcessUnavailableReason))
                        return
                    }
                    self.perform(bridgeAction) { result in
                        switch result {
                        case .success: continuation.resume(returning: AutoMobileWebActionResult(status: .accepted))
                        case .failure:
                            // perform re-validates; a rejection here means the snapshot moved on.
                            continuation.resume(
                                returning: self.policy.validates(bridgeAction)
                                    ? .rejected(AutoMobileWebActionResult.javascriptErrorReason)
                                    : .rejected(AutoMobileWebActionResult.staleSnapshotReason)
                            )
                        }
                    }
                }
            }
        }

        private func ifEvaluate(_ action: AutoMobileWebAction) -> Bool {
            if case .evaluateJavaScript = action { return true }
            return false
        }

        private func emit(
            name: String,
            url: URL?,
            frameId: String? = nil,
            requestId: String? = nil,
            metadata: [String: String] = [:]
        ) {
            emitEvent(SdkWebViewEvent(
                webViewId: webViewId,
                name: name,
                url: url?.absoluteString,
                frameId: frameId,
                requestId: requestId,
                metadata: metadata
            ))
        }

        private static let script = #"""
        (() => {
          const post = (name, extra = {}) => window.webkit?.messageHandlers?.automobile?.postMessage({name, frameId: location.href, ...extra});
          let nextElementId = 0;
          const documentId = `${Date.now()}-${Math.random()}`;
          const rendered = e => e.checkVisibility ? e.checkVisibility({visibilityProperty: true, opacityProperty: true}) : getComputedStyle(e).visibility !== 'hidden';
          const snapshot = () => {
            if (window.top !== window) return;
            const elements = [...document.querySelectorAll('button,a,input,textarea,select,[role]')].map(e => {
              const id = e.dataset.automobileId || (e.dataset.automobileId = `e${nextElementId++}`);
              const r = e.getBoundingClientRect();
              return {id, role: e.getAttribute('role') || e.tagName.toLowerCase(), label: e.getAttribute('aria-label') || e.textContent?.trim().slice(0, 200), value: e.value || null, bounds: [r.x,r.y,r.width,r.height], enabled: !e.disabled, visible: r.width > 0 && r.height > 0 && rendered(e), focused: document.activeElement === e, inputType: e.tagName === 'INPUT' ? (e.type || 'text') : null};
            });
            const v = window.visualViewport;
            const viewport = v ? {offsetLeft: v.offsetLeft, offsetTop: v.offsetTop, width: v.width, height: v.height, scale: v.scale} : {offsetLeft: 0, offsetTop: 0, width: window.innerWidth, height: window.innerHeight, scale: 1};
            post('snapshot', {snapshotId: `${Date.now()}-${Math.random()}`, elements, viewport, documentId});
          };
          let snapshotPending = false;
          const scheduleSnapshot = () => { if (snapshotPending) return; snapshotPending = true; setTimeout(() => { snapshotPending = false; snapshot(); }, 100); };
          new MutationObserver(snapshot).observe(document, {subtree:true, childList:true, attributes:true});
          addEventListener('load', snapshot);
          addEventListener('scroll', scheduleSnapshot, {passive: true, capture: true});
          addEventListener('focusin', scheduleSnapshot); addEventListener('focusout', scheduleSnapshot);
          addEventListener('input', scheduleSnapshot, true); addEventListener('change', scheduleSnapshot, true);
          addEventListener('resize', scheduleSnapshot); window.visualViewport?.addEventListener('resize', scheduleSnapshot); window.visualViewport?.addEventListener('scroll', scheduleSnapshot); addEventListener('hashchange', () => post('spa_navigation')); addEventListener('popstate', () => post('history_navigation'));
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

    extension AutoMobileWebViewBridge: AutoMobileWebViewControlling {}
#endif
