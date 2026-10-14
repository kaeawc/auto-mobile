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
        node: PrototypeNode, state: [String: JSONValue], pager: PagerPosition?, nodeKey: String
    ) -> [PrototypeTextRun]? {
        node.spans?.enumerated().map { index, span in
            PrototypeTextRun(
                text: interpolatePrototypeText(span.text, state: state, pager: pager),
                style: span.style,
                link: span.onTap == nil ? nil : link(nodeKey: nodeKey, index: index)
            )
        }
    }
}

extension PrototypeNode {
    /// Resolve each run separately: a placeholder cannot cross a span boundary.
    func plainText(state: [String: JSONValue], pager: PagerPosition?) -> String {
        if let spans {
            return spans.map { interpolatePrototypeText($0.text, state: state, pager: pager) }.joined()
        }
        return interpolatePrototypeText(text ?? "", state: state, pager: pager)
    }
}
