import Foundation

struct PrototypeAction: Decodable, Sendable {
    let type: String
    let name: String?
    let payload: JSONValue?
    let context: PrototypeEmitContext?
    let scroll: String?
    let to: JSONValue?
    let animated: Bool?
    let pager: String?
    let page: JSONValue?
    let stack: String?
    let screen: String?
    let params: [String: JSONValue]?
    let force: Bool?
    /// Contract-only setStack path; data actions retain their existing string path.
    let stackPath: [PrototypeRouteEntry]?
    let transition: PrototypeStackTransition?
    let source: String?
    /// `setData`/`appendData`/`prependData`/`removeData`: `/data/<pointer>`, a whole `{index}` segment bound per
    /// repeat row at expansion (#12519).
    let path: String?
    let key: String?
    /// `setState`'s literal; for `setData`/`appendData`/`prependData` the binding object (`{value}`, `{state}`,
    /// `{data}`), with `item`/`index` already bound to `{value}` by repeat expansion.
    let value: JSONValue?
    /// `increment`/`decrement` step; 1 when omitted.
    let incrementAmount: Double?
    let requireValid: [String]?
    // `request` (#12529): method defaults to GET and `via` to host. `headers` and `query` entries
    // are a literal string or a binding object; `body` is a binding; `url`, `statusKey` and `into`
    // are bound per repeat row at expansion like the data actions' paths.
    let call: String?
    let args: [String: JSONValue]?
    let method: String?
    let url: String?
    let headers: [String: JSONValue]?
    let query: [String: JSONValue]?
    let progressKey: String?
    let body: JSONValue?
    let into: String?
    let append: PrototypeRequestAppend?
    let statusKey: String?
    let via: String?
    let timeoutMs: Double?
    let id: String?
    let afterMs: Int?
    let everyMs: Int?
    let maxRuns: Int?
    let actions: [PrototypeAction]?
    let onSuccess: [PrototypeAction]?
    let onError: [PrototypeAction]?

    private enum CodingKeys: String, CodingKey {
        case type, name, payload, context, pager, page, stack, screen, transition, source, path, key, value, scroll, to,
             animated, call, args, params, force
        case id, afterMs, everyMs, maxRuns, actions
        case incrementAmount = "by"
        case requireValid, method, url, headers, query, progressKey, body, into, append, statusKey, via, timeoutMs,
             onSuccess,
             onError
    }

    init(
        type: String, name: String?, payload: JSONValue?, context: PrototypeEmitContext?, pager: String?,
        page: JSONValue?, stack: String?, screen: String?, path: String?, key: String?, value: JSONValue?,
        by incrementAmount: Double?, requireValid: [String]?, method: String? = nil, url: String? = nil,
        headers: [String: JSONValue]? = nil, query: [String: JSONValue]? = nil, body: JSONValue? = nil,
        into: String? = nil, append: PrototypeRequestAppend? = nil, statusKey: String? = nil,
        progressKey: String? = nil,
        via: String? = nil,
        timeoutMs: Double? = nil,
        onSuccess: [PrototypeAction]? = nil, onError: [PrototypeAction]? = nil,
        id: String? = nil, afterMs: Int? = nil, everyMs: Int? = nil, maxRuns: Int? = nil,
        actions: [PrototypeAction]? = nil, transition: PrototypeStackTransition? = nil, source: String? = nil,
        scroll: String? = nil, to: JSONValue? = nil, animated: Bool? = nil,
        call: String? = nil, args: [String: JSONValue]? = nil,
        params: [String: JSONValue]? = nil, force: Bool? = nil, stackPath: [PrototypeRouteEntry]? = nil
    ) {
        self.scroll = scroll
        self.to = to
        self.animated = animated
        self.call = call
        self.args = args
        self.id = id
        self.afterMs = afterMs
        self.everyMs = everyMs
        self.maxRuns = maxRuns
        self.actions = actions
        self.type = type
        self.name = name
        self.payload = payload
        self.context = context
        self.pager = pager
        self.page = page
        self.stack = stack
        self.screen = screen
        self.params = params
        self.force = force
        self.stackPath = stackPath
        self.transition = transition
        self.source = source
        self.path = path
        self.key = key
        self.value = value
        self.incrementAmount = incrementAmount
        self.requireValid = requireValid
        self.method = method
        self.url = url
        self.headers = headers
        self.query = query
        self.progressKey = progressKey
        self.body = body
        self.into = into
        self.append = append
        self.statusKey = statusKey
        self.via = via
        self.timeoutMs = timeoutMs
        self.onSuccess = onSuccess
        self.onError = onError
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        try self.init(
            type: type,
            name: container.decodeIfPresent(String.self, forKey: .name),
            payload: container.decodeIfPresent(JSONValue.self, forKey: .payload),
            context: container.decodeIfPresent(PrototypeEmitContext.self, forKey: .context),
            pager: container.decodeIfPresent(String.self, forKey: .pager),
            page: container.decodeIfPresent(JSONValue.self, forKey: .page),
            stack: container.decodeIfPresent(String.self, forKey: .stack),
            screen: container.decodeIfPresent(String.self, forKey: .screen),
            path: type == "setStack" ? nil : container.decodeIfPresent(String.self, forKey: .path),
            key: container.decodeIfPresent(String.self, forKey: .key),
            value: container.decodeIfPresent(JSONValue.self, forKey: .value),
            by: container.decodeIfPresent(Double.self, forKey: .incrementAmount),
            requireValid: container.decodeIfPresent([String].self, forKey: .requireValid),
            method: container.decodeIfPresent(String.self, forKey: .method),
            url: container.decodeIfPresent(String.self, forKey: .url),
            headers: container.decodeIfPresent([String: JSONValue].self, forKey: .headers),
            query: container.decodeIfPresent([String: JSONValue].self, forKey: .query),
            body: container.decodeIfPresent(JSONValue.self, forKey: .body),
            into: container.decodeIfPresent(String.self, forKey: .into),
            append: container.decodeIfPresent(PrototypeRequestAppend.self, forKey: .append),
            statusKey: container.decodeIfPresent(String.self, forKey: .statusKey),
            progressKey: container.decodeIfPresent(String.self, forKey: .progressKey),
            via: container.decodeIfPresent(String.self, forKey: .via),
            timeoutMs: container.decodeIfPresent(Double.self, forKey: .timeoutMs),
            onSuccess: container.decodeIfPresent([PrototypeAction].self, forKey: .onSuccess),
            onError: container.decodeIfPresent([PrototypeAction].self, forKey: .onError),
            id: container.decodeIfPresent(String.self, forKey: .id),
            afterMs: container.decodeIfPresent(Int.self, forKey: .afterMs),
            everyMs: container.decodeIfPresent(Int.self, forKey: .everyMs),
            maxRuns: container.decodeIfPresent(Int.self, forKey: .maxRuns),
            actions: container.decodeIfPresent([PrototypeAction].self, forKey: .actions),
            transition: container.decodeIfPresent(PrototypeStackTransition.self, forKey: .transition),
            source: container.decodeIfPresent(String.self, forKey: .source),
            scroll: container.decodeIfPresent(String.self, forKey: .scroll),
            to: container.decodeIfPresent(JSONValue.self, forKey: .to),
            animated: container.decodeIfPresent(Bool.self, forKey: .animated),
            call: container.decodeIfPresent(String.self, forKey: .call),
            args: container.decodeIfPresent([String: JSONValue].self, forKey: .args),
            params: container.decodeIfPresent([String: JSONValue].self, forKey: .params),
            force: container.decodeIfPresent(Bool.self, forKey: .force),
            stackPath: type == "setStack" ? container.decode([PrototypeRouteEntry].self, forKey: .path) : nil
        )
    }

    /// This action and every action nested in its `onSuccess` / `onError` lists, depth first.
    var flattened: [PrototypeAction] {
        [self] + ((onSuccess ?? []) + (onError ?? []) + (actions ?? [])).flatMap(\.flattened)
    }
}
