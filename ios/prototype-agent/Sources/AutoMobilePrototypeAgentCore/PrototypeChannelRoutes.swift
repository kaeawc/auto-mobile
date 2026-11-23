/// First-match routing, matching the Android pure controller contract. JSON null is a present
/// member; it differs from a missing pointer. SSE's default event name is `message`.
enum PrototypeChannelRoutes {
    static func match(_ routes: JSONValue?, data: JSONValue, event: String?) -> [JSONValue]? {
        guard case let .array(routes)? = routes else { return nil }
        for raw in routes {
            guard let route = raw.objectFields, matches(route["when"], data: data, event: event) else { continue }
            guard case let .array(actions)? = route["actions"] else { return nil }
            return actions
        }
        return nil
    }

    private static func matches(_ raw: JSONValue?, data: JSONValue, event: String?) -> Bool {
        guard let condition = raw?.objectFields else { return true }
        if let name = condition["event"]?.stringValue { return name.utf16.elementsEqual((event ?? "message").utf16) }
        guard let pointer = condition["pointer"]?.stringValue,
              PrototypeDataPointer.isValid(pointer) else { return false }
        let value = PrototypeDataPointer.resolve(data, tokens: PrototypeDataPointer.tokens(pointer)[...])
        if let exists = condition["exists"]?.boolValue { return exists == (value != nil) }
        return PrototypePatch.equal(value, condition["equals"])
    }
}
