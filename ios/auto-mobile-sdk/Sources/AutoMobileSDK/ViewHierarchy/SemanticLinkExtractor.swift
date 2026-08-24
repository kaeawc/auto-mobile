import Foundation

/// A single inline accessibility link discovered on an owning text element.
///
/// Mirrors the Android `SemanticLink` contract (text + occurrence + optional
/// character range) so the merged AutoMobile hierarchy is shaped identically on
/// both platforms (issue #5560). `centerX`/`centerY` are an iOS-only addition —
/// the in-app SDK can compute a link's on-screen point, which the out-of-process
/// runner uses to activate a specific inline link by coordinate. They are dropped
/// when the node is projected to the Android-parity wire shape.
public struct SdkSemanticLink: Codable, Sendable, Equatable {
    public let text: String
    public let occurrence: Int
    /// UTF-16 offset (NSString semantics) of the link's first character, when the
    /// source is a real attributed string. `nil` for accessibility-element
    /// fallbacks (e.g. SwiftUI inline links) where no range is exposed.
    public let start: Int?
    /// UTF-16 offset one past the link's last character. `nil` when `start` is nil.
    public let end: Int?
    public let centerX: Double?
    public let centerY: Double?

    public init(
        text: String,
        occurrence: Int,
        start: Int? = nil,
        end: Int? = nil,
        centerX: Double? = nil,
        centerY: Double? = nil
    ) {
        self.text = text
        self.occurrence = occurrence
        self.start = start
        self.end = end
        self.centerX = centerX
        self.centerY = centerY
    }
}

/// Extracts inline semantic links from attributed text and ordered accessibility
/// elements. Pure Foundation logic (no UIKit) so it runs on the macOS `swift test`
/// destination; the UIKit walker feeds it live `UITextView`/`UILabel`
/// `attributedText` and, for SwiftUI, the ordered `.link`-trait accessibility
/// elements.
public enum SemanticLinkExtractor {
    /// Discover every `.link` run in `attributed`, assigning an ascending
    /// `occurrence` per distinct visible text so duplicate link labels remain
    /// disambiguable — exactly how Android's `semanticLinksFromText` behaves.
    public static func links(from attributed: NSAttributedString) -> [SdkSemanticLink] {
        let nsText = attributed.string as NSString
        var links: [SdkSemanticLink] = []
        var occurrenceByText: [String: Int] = [:]
        let fullRange = NSRange(location: 0, length: attributed.length)
        attributed.enumerateAttribute(.link, in: fullRange) { value, range, _ in
            guard value != nil, range.length > 0 else { return }
            let text = nsText.substring(with: range)
            let occurrence = occurrenceByText[text, default: 0]
            occurrenceByText[text] = occurrence + 1
            links.append(
                SdkSemanticLink(
                    text: text,
                    occurrence: occurrence,
                    start: range.location,
                    end: range.location + range.length
                )
            )
        }
        return links
    }

    /// Build links from the ordered accessibility labels of a text element's
    /// `.link`-trait children. SwiftUI inline links only surface this way, with no
    /// character range — occurrence is still assigned in document order.
    public static func links(fromAccessibilityLinkLabels labels: [String]) -> [SdkSemanticLink] {
        var links: [SdkSemanticLink] = []
        var occurrenceByText: [String: Int] = [:]
        for label in labels {
            let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let occurrence = occurrenceByText[trimmed, default: 0]
            occurrenceByText[trimmed] = occurrence + 1
            links.append(SdkSemanticLink(text: trimmed, occurrence: occurrence))
        }
        return links
    }
}
