import UIKit
import UniformTypeIdentifiers

@MainActor
final class ShareSinkViewController: UIViewController {
    private let summaryLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        summaryLabel.numberOfLines = 0
        summaryLabel.accessibilityIdentifier = "share_sink_summary"
        summaryLabel.text = "Loading attachments"

        let done = UIButton(type: .system)
        done.setTitle("Done", for: .normal)
        done.accessibilityIdentifier = "share_sink_done"
        done.addTarget(self, action: #selector(finish), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [summaryLabel, done])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
        ])

        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        load(items.flatMap { $0.attachments ?? [] }, index: 0, attachments: [])
    }

    private func load(_ providers: [NSItemProvider], index: Int, attachments: [ShareSinkAttachment]) {
        guard index < providers.count else {
            summaryLabel.text = ShareSinkSummary(attachments: attachments).label
            return
        }
        let provider = providers[index]
        // Choose one representation per attachment; URLs can also advertise plain text.
        let candidates: [(UTType, ShareSinkAttachment.Kind)] = [(.image, .image), (.url, .url), (.text, .text)]
        guard let (type, kind) = candidates
            .first(where: { provider.hasItemConformingToTypeIdentifier($0.0.identifier) })
        else {
            load(
                providers,
                index: index + 1,
                attachments: attachments + [ShareSinkAttachment(kind: .unsupported, loaded: false)]
            )
            return
        }
        provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { [weak self] item, error in
            let attachment: ShareSinkAttachment
            if error != nil || item == nil {
                attachment = ShareSinkAttachment(kind: kind, loaded: false)
            } else if kind == .url, let url = item as? URL {
                attachment = ShareSinkAttachment(kind: kind, url: url.absoluteString)
            } else if kind == .text, let text = item as? String {
                attachment = ShareSinkAttachment(kind: kind, text: text)
            } else if kind == .text, let data = item as? Data, let text = String(data: data, encoding: .utf8) {
                attachment = ShareSinkAttachment(kind: kind, text: text)
            } else {
                attachment = ShareSinkAttachment(kind: kind, loaded: kind == .image)
            }
            DispatchQueue.main.async {
                self?.load(providers, index: index + 1, attachments: attachments + [attachment])
            }
        }
    }

    @objc
    private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
