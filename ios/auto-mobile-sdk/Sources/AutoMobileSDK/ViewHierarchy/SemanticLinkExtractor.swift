import AutoMobileSdkWire
import Foundation

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
        var occurrenceGroups: [(text: String, nextOccurrence: Int)] = []
        let fullRange = NSRange(location: 0, length: attributed.length)
        attributed.enumerateAttribute(.link, in: fullRange) { value, range, _ in
            guard value != nil, range.length > 0 else { return }
            let text = nsText.substring(with: range)
            let occurrence = nextOccurrence(for: text, occurrenceGroups: &occurrenceGroups)
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
        var occurrenceGroups: [(text: String, nextOccurrence: Int)] = []
        for label in labels {
            let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let occurrence = nextOccurrence(for: trimmed, occurrenceGroups: &occurrenceGroups)
            links.append(SdkSemanticLink(text: trimmed, occurrence: occurrence))
        }
        return links
    }

    private static func nextOccurrence(
        for text: String,
        occurrenceGroups: inout [(text: String, nextOccurrence: Int)]
    )
        -> Int
    {
        if let index = occurrenceGroups.firstIndex(where: {
            $0.text.caseInsensitiveCompare(text) == .orderedSame
        }) {
            let occurrence = occurrenceGroups[index].nextOccurrence
            occurrenceGroups[index].nextOccurrence += 1
            return occurrence
        }

        occurrenceGroups.append((text: text, nextOccurrence: 1))
        return 0
    }
}
