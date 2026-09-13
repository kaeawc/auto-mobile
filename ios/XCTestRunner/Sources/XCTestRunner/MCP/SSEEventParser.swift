import Foundation

/// Parses a fully buffered `text/event-stream` body into its events. This is the one canonical SSE
/// primitive in the runner: `StreamableHTTPMCPClient` advertises `text/event-stream` in its `Accept`
/// header and the daemon answers with it (the MCP SDK transport is built without
/// `enableJsonResponse`), interleaving `:keepalive` comment lines into long tool-call responses
/// (#6633).
///
/// Follows the event-stream rules that matter for a buffered body: lines split on CRLF / LF / CR, a
/// line beginning with `:` is a comment, `field: value` drops one optional leading space, `data`
/// values accumulate and are joined with `\n`, and a blank line dispatches the event. A trailing
/// event with no terminating blank line is still dispatched, because the body is complete by
/// construction — the transport closes the per-request stream once every response is written.
enum SSEEventParser {
    struct Event: Equatable, Sendable {
        var name: String?
        var data: String
        var id: String?
    }

    /// A body that is not valid UTF-8 is not an event stream; callers report it as an invalid
    /// response with a body excerpt rather than guessing at a transcoding.
    static func parse(_ data: Data) -> [Event] {
        guard let text = String(data: data, encoding: .utf8) else {
            return []
        }
        return parse(text)
    }

    static func parse(_ text: String) -> [Event] {
        var events: [Event] = []
        var name: String?
        var dataLines: [String] = []
        var lastEventId: String?

        func dispatch() {
            defer {
                name = nil
                dataLines = []
            }
            guard !dataLines.isEmpty else {
                return
            }
            events.append(Event(name: name, data: dataLines.joined(separator: "\n"), id: lastEventId))
        }

        for line in splitLines(text) {
            if line.isEmpty {
                dispatch()
                continue
            }
            if line.hasPrefix(":") {
                continue
            }
            let (field, value) = splitField(line)
            switch field {
            case "event":
                name = value
            case "data":
                dataLines.append(value)
            case "id":
                lastEventId = value
            default:
                // `retry` and any unknown field carry nothing this client acts on.
                continue
            }
        }
        dispatch()
        return events
    }

    /// Splits `field: value`, dropping a single optional space after the colon. A line with no colon
    /// is the whole field name with an empty value.
    private static func splitField(_ line: String) -> (field: String, value: String) {
        guard let colon = line.firstIndex(of: ":") else {
            return (line, "")
        }
        var value = line[line.index(after: colon)...]
        if value.first == " " {
            value = value.dropFirst()
        }
        return (String(line[line.startIndex ..< colon]), String(value))
    }

    /// Line splitter that treats CRLF, LF and a bare CR as terminators, per the event-stream format.
    /// Swift folds `\r\n` into one `Character`, so a single separator predicate covers all three;
    /// empty subsequences are kept because a blank line is what dispatches an event. Newline-ish
    /// scalars the format does not recognize (`\u{0B}`, `\u{2028}`, …) stay inside the value.
    private static func splitLines(_ text: String) -> [String] {
        text
            .split(omittingEmptySubsequences: false) { $0 == "\r\n" || $0 == "\r" || $0 == "\n" }
            .map(String.init)
    }
}
