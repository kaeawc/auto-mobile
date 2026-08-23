import Foundation
import SwiftUI
import UIKit

// MARK: - Semantic Links Demos

/// A positive fixture for semantic accessibility-link activation.
///
/// Both variants deliberately repeat the visible "Terms of Service" link text
/// in one owner paragraph. This makes `subtext: { text, occurrence }` useful:
/// occurrence 0 and 1 have independent actions, while the standalone Privacy
/// Policy link is addressable through `selector.accessibilityLink`.
private enum SemanticLinkDestination: String {
    case termsFirst = "terms-first"
    case termsSecond = "terms-second"
    case support
    case privacy

    var url: URL {
        var components = URLComponents()
        components.scheme = "automobile-playground"
        components.host = "semantic-links"
        components.path = "/\(rawValue)"
        return components.url ?? URL(filePath: "/semantic-links/\(rawValue)")
    }

    var activationName: String {
        switch self {
        case .termsFirst:
            "Terms of Service (first)"
        case .termsSecond:
            "Terms of Service (second)"
        case .support:
            "Support"
        case .privacy:
            "Privacy Policy"
        }
    }

    init?(url: URL) {
        self.init(rawValue: url.lastPathComponent)
    }
}

private struct SemanticLinksResult: View {
    let lastActivated: String
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        Text("Last activated: \(lastActivated)")
            .font(theme.typography.titleMedium)
            .foregroundStyle(theme.textPrimary)
            .accessibilityIdentifier("semantic_links_result")
    }
}

private struct SemanticLinksInstructions: View {
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        Text(
            "Activate either Terms of Service occurrence, Support, or the standalone Privacy Policy link. "
                + "Each activation changes the result below without navigating."
        )
        .font(theme.typography.bodyMedium)
        .foregroundStyle(theme.textSecondary)
    }
}

struct SwiftUISemanticLinksDemo: View {
    @State private var lastActivated = "None"
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                SemanticLinksInstructions()

                Text(swiftUIInlineLinks)
                    .font(theme.typography.bodyLarge)
                    .accessibilityIdentifier("swiftui_semantic_links_inline")

                Link("Privacy Policy", destination: SemanticLinkDestination.privacy.url)
                    .font(theme.typography.titleMedium)
                    .accessibilityIdentifier("swiftui_semantic_links_standalone")

                SemanticLinksResult(lastActivated: lastActivated)
            }
            .padding()
        }
        .navigationTitle("Semantic Links (SwiftUI)")
        .navigationBarTitleDisplayMode(.inline)
        .environment(\.openURL, OpenURLAction { url in
            activate(url)
            return .handled
        })
        .trackNavigation(destination: "SwiftUISemanticLinksDemo")
    }

    private var swiftUIInlineLinks: AttributedString {
        var firstTerms = AttributedString("Terms of Service")
        firstTerms.link = SemanticLinkDestination.termsFirst.url
        var support = AttributedString("Support")
        support.link = SemanticLinkDestination.support.url
        var secondTerms = AttributedString("Terms of Service")
        secondTerms.link = SemanticLinkDestination.termsSecond.url

        var text = AttributedString("Read the ")
        text += firstTerms
        text += AttributedString(", contact ")
        text += support
        text += AttributedString(", or review the ")
        text += secondTerms
        text += AttributedString(" again.")
        return text
    }

    private func activate(_ url: URL) {
        guard let destination = SemanticLinkDestination(url: url) else {
            return
        }
        lastActivated = destination.activationName
    }
}

struct UIKitSemanticLinksDemo: View {
    @State private var lastActivated = "None"
    @Environment(\.autoMobileTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                SemanticLinksInstructions()

                UIKitSemanticLinkTextView(
                    attributedText: uikitInlineLinks,
                    accessibilityIdentifier: "uikit_semantic_links_inline",
                    onActivate: activate
                )
                .frame(minHeight: 72)

                UIKitSemanticLinkTextView(
                    attributedText: uikitStandaloneLink,
                    accessibilityIdentifier: "uikit_semantic_links_standalone",
                    onActivate: activate
                )
                .frame(height: 28)

                SemanticLinksResult(lastActivated: lastActivated)
            }
            .padding()
        }
        .navigationTitle("Semantic Links (UIKit)")
        .navigationBarTitleDisplayMode(.inline)
        .trackNavigation(destination: "UIKitSemanticLinksDemo")
    }

    private var uikitInlineLinks: NSAttributedString {
        let text = NSMutableAttributedString(
            string: "Read the Terms of Service, contact Support, or review the Terms of Service again.",
            attributes: [
                .font: UIFont.preferredFont(forTextStyle: .body),
                .foregroundColor: UIColor.label
            ]
        )
        addLink(.termsFirst, label: "Terms of Service", occurrence: 0, to: text)
        addLink(.support, label: "Support", occurrence: 0, to: text)
        addLink(.termsSecond, label: "Terms of Service", occurrence: 1, to: text)
        return text
    }

    private var uikitStandaloneLink: NSAttributedString {
        let text = NSMutableAttributedString(
            string: "Privacy Policy",
            attributes: [
                .font: UIFont.preferredFont(forTextStyle: .body),
                .foregroundColor: UIColor.label
            ]
        )
        addLink(.privacy, label: "Privacy Policy", occurrence: 0, to: text)
        return text
    }

    private func addLink(
        _ destination: SemanticLinkDestination,
        label: String,
        occurrence: Int,
        to text: NSMutableAttributedString
    ) {
        guard let range = range(of: label, occurrence: occurrence, in: text.string as NSString) else {
            return
        }
        text.addAttribute(.link, value: destination.url, range: range)
    }

    private func range(of label: String, occurrence: Int, in text: NSString) -> NSRange? {
        var searchRange = NSRange(location: 0, length: text.length)
        for index in 0 ... occurrence {
            let foundRange = text.range(of: label, options: [], range: searchRange)
            guard foundRange.location != NSNotFound else {
                return nil
            }
            if index == occurrence {
                return foundRange
            }
            let nextLocation = NSMaxRange(foundRange)
            searchRange = NSRange(location: nextLocation, length: text.length - nextLocation)
        }
        return nil
    }

    private func activate(_ url: URL) {
        guard let destination = SemanticLinkDestination(url: url) else {
            return
        }
        lastActivated = destination.activationName
    }
}

private struct UIKitSemanticLinkTextView: UIViewRepresentable {
    let attributedText: NSAttributedString
    let accessibilityIdentifier: String
    let onActivate: (URL) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onActivate: onActivate)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.isEditable = false
        textView.isScrollEnabled = false
        textView.backgroundColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.adjustsFontForContentSizeCategory = true
        textView.accessibilityTraits = .link
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        textView.attributedText = attributedText
        textView.accessibilityIdentifier = accessibilityIdentifier
        context.coordinator.onActivate = onActivate
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: UITextView,
        context: Context
    ) -> CGSize? {
        let width = proposal.width ?? UIScreen.main.bounds.width
        return uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var onActivate: (URL) -> Void

        init(onActivate: @escaping (URL) -> Void) {
            self.onActivate = onActivate
        }

        func textView(
            _ textView: UITextView,
            primaryActionFor textItem: UITextItem,
            defaultAction: UIAction
        ) -> UIAction? {
            guard case let .link(url) = textItem.content else {
                return defaultAction
            }
            return UIAction { [onActivate] _ in
                onActivate(url)
            }
        }
    }
}

#Preview("SwiftUI Semantic Links") {
    NavigationStack {
        SwiftUISemanticLinksDemo()
    }
    .autoMobileTheme()
}

#Preview("UIKit Semantic Links") {
    NavigationStack {
        UIKitSemanticLinksDemo()
    }
    .autoMobileTheme()
}
