import Foundation

/// Report drafts for received content (#16437). The app only opens a mail draft: it sends nothing
/// itself and attaches no bundle bytes.
enum PrototypeContentReport {
    /// Published contact for objectionable-content reports and abuse, the project's code-of-conduct
    /// address, as on Android and in the store listing.
    static let contactEmail = "automobile+coc@jasonpearson.dev"

    /// Identifies the content without sending it: label, spec SHA-256 and how it arrived.
    static func details(_ entry: PrototypeLibraryEntry) -> String {
        [
            "label: \(entry.label)",
            "specSha256: \(entry.specSha256)",
            "source: \(entry.source.rawValue)",
        ].joined(separator: "\n")
    }

    /// A `mailto:` draft to the contact. `URLComponents` percent-encodes `&`, `=`, `#` and newlines in
    /// the values but leaves `+`, which mail clients may read as a space, so it is encoded as well.
    static func mailURL(subject: String, body: String) -> URL? {
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = contactEmail
        components.queryItems = [URLQueryItem(name: "subject", value: subject), URLQueryItem(name: "body", value: body)]
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }
}
