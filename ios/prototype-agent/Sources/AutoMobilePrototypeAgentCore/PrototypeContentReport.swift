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

    /// A `mailto:` draft to the contact. Only unreserved ASCII stays literal, so a label holding
    /// `&`, `=`, `#` or a newline cannot add or end a header.
    static func mailURL(subject: String, body: String) -> URL? {
        URL(string: "mailto:\(contactEmail)?subject=\(encode(subject))&body=\(encode(body))")
    }

    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    private static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }
}
