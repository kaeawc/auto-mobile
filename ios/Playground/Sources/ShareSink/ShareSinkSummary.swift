import Foundation

struct ShareSinkAttachment: Equatable {
    enum Kind: String {
        case text
        case url
        case image
        case unsupported
    }

    let kind: Kind
    let text: String
    let url: String
    let loaded: Bool

    init(kind: Kind, text: String = "", url: String = "", loaded: Bool = true) {
        self.kind = kind
        self.text = text
        self.url = url
        self.loaded = loaded
    }
}

struct ShareSinkSummary {
    let attachments: [ShareSinkAttachment]

    var label: String {
        let details = attachments.enumerated().map { index, attachment in
            "Attachment \(index + 1):\nType: \(attachment.kind.rawValue)\n"
                + "Text: \(attachment.text)\nURL: \(attachment.url)\n"
                + "Status: \(attachment.loaded ? "loaded" : "unavailable")"
        }
        return (["Attachment count: \(attachments.count)"] + details).joined(separator: "\n")
    }
}
