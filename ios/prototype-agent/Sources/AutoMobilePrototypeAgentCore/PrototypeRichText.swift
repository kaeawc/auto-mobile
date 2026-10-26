import Foundation

struct PrototypeTextSpan: Decodable, Sendable {
    let text: String
    let style: PrototypeTextSpanStyle?
    let onTap: [PrototypeAction]?
}

/// Only the text attributes allowed by the shared contract; background is a colour slot.
struct PrototypeTextSpanStyle: Decodable, Equatable, Sendable {
    let color: PrototypeModeValue?
    let fontWeight: Int?
    let fontStyle: String?
    let textDecoration: String?
    let textSize: Double?
    let letterSpacing: Double?
    let fontFamily: FontFamily?
    let background: PrototypeModeValue?
}

/// UIKit-free run mapping. Missing attributes inherit the surrounding node's text style.
struct PrototypeTextRun: Equatable, Sendable {
    let text: String
    let style: PrototypeTextSpanStyle?
    let link: URL?
    /// The actions a tap on `link` runs: a span's `onTap`, or a linkify match's bound `onTap`.
    let actions: [PrototypeAction]?

    init(text: String, style: PrototypeTextSpanStyle?, link: URL?, actions: [PrototypeAction]? = nil) {
        self.text = text
        self.style = style
        self.link = link
        self.actions = actions
    }

    /// Runs compare by what they draw and link to; the link identifies the actions.
    static func == (lhs: PrototypeTextRun, rhs: PrototypeTextRun) -> Bool {
        lhs.text == rhs.text && lhs.style == rhs.style && lhs.link == rhs.link
    }
}

enum PrototypeRichText {
    static let linkScheme = "automobile-span"

    /// URLComponents escapes arbitrary node identifiers; no authored text becomes a web URL.
    static func link(nodeKey: String, index: Int) -> URL? {
        guard index >= 0 else { return nil }
        var components = URLComponents()
        components.scheme = linkScheme
        components.host = "run"
        components.path = "/\(index)"
        components.queryItems = [URLQueryItem(name: "node", value: nodeKey)]
        return components.url
    }

    static func runs(
        node: PrototypeNode, state: [String: JSONValue], pager: PagerPosition?, nodeKey: String,
        derived: PrototypeDerivedContext? = nil
    )
        -> [PrototypeTextRun]?
    {
        if let linkify = node.linkify, node.spans == nil {
            return linkifiedRuns(
                interpolatePrototypeText(node.text ?? "", state: state, pager: pager, derived: derived),
                linkify: linkify,
                nodeKey: nodeKey
            )
        }
        return node.spans?.enumerated().map { index, span in
            PrototypeTextRun(
                text: interpolatePrototypeText(span.text, state: state, pager: pager, derived: derived),
                style: span.style,
                link: span.onTap == nil ? nil : link(nodeKey: nodeKey, index: index),
                actions: span.onTap
            )
        }
    }

    /// `linkify` (#14233): plain runs between the matches and one linked run per match, whose actions
    /// are `onTap` with its `{match}` bindings bound. Nil without a match, so the text stays plain.
    static func linkifiedRuns(
        _ text: String, linkify: PrototypeLinkifyOptions, nodeKey: String
    )
        -> [PrototypeTextRun]?
    {
        let matches = PrototypeLinkify.matches(text, kinds: linkify.kinds)
        guard !matches.isEmpty else { return nil }
        let units = Array(text.utf16)
        var runs: [PrototypeTextRun] = []
        var cursor = 0
        for match in matches {
            if match.start > cursor {
                let plain = String(decoding: units[cursor ..< match.start], as: UTF16.self)
                runs.append(PrototypeTextRun(text: plain, style: nil, link: nil))
            }
            runs.append(PrototypeTextRun(
                text: match.text,
                style: linkify.style,
                link: link(nodeKey: nodeKey, index: runs.count),
                actions: PrototypeLinkify.actions(linkify.onTap, match: match)
            ))
            cursor = match.end
        }
        if cursor < units.count {
            runs.append(PrototypeTextRun(
                text: String(decoding: units[cursor...], as: UTF16.self),
                style: nil,
                link: nil
            ))
        }
        return runs
    }
}

extension PrototypeNode {
    /// Resolve each run separately: a placeholder cannot cross a span boundary.
    func plainText(
        state: [String: JSONValue],
        pager: PagerPosition?,
        derived: PrototypeDerivedContext? = nil
    )
        -> String
    {
        if let spans {
            return spans.map { interpolatePrototypeText($0.text, state: state, pager: pager, derived: derived) }
                .joined()
        }
        return interpolatePrototypeText(text ?? "", state: state, pager: pager, derived: derived)
    }
}
