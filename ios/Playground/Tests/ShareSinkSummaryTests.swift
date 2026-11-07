import XCTest

final class ShareSinkSummaryTests: XCTestCase {
    func testEmptyShareHasZeroAttachments() {
        XCTAssertEqual(ShareSinkSummary(attachments: []).label, "Attachment count: 0")
    }

    func testTextAndURLPreserveTheirContentsAndInputOrder() {
        let summary = ShareSinkSummary(attachments: [
            ShareSinkAttachment(kind: .text, text: "Hello\nworld"),
            ShareSinkAttachment(kind: .url, url: "https://example.com/?q=share"),
        ])
        XCTAssertEqual(summary.label, [
            "Attachment count: 2",
            "Attachment 1:",
            "Type: text",
            "Text: Hello",
            "world",
            "URL: ",
            "Status: loaded",
            "Attachment 2:",
            "Type: url",
            "Text: ",
            "URL: https://example.com/?q=share",
            "Status: loaded",
        ].joined(separator: "\n"))
    }

    func testImagesAreCountedOncePerAttachment() {
        let summary = ShareSinkSummary(attachments: [
            ShareSinkAttachment(kind: .image),
            ShareSinkAttachment(kind: .image),
        ])
        XCTAssertEqual(summary.attachments.count, 2)
        XCTAssertEqual(summary.attachments.map(\.kind), [.image, .image])
        XCTAssertTrue(summary.label.hasPrefix("Attachment count: 2\nAttachment 1:\nType: image"))
        XCTAssertTrue(summary.label.contains("Attachment 2:\nType: image"))
    }

    func testUnavailableAndUnsupportedAttachmentsRemainInTheCount() {
        let summary = ShareSinkSummary(attachments: [
            ShareSinkAttachment(kind: .image, loaded: false),
            ShareSinkAttachment(kind: .unsupported, loaded: false),
        ])
        XCTAssertEqual(summary.attachments.count, 2)
        XCTAssertTrue(summary.label.contains("Type: image\nText: \nURL: \nStatus: unavailable"))
        XCTAssertTrue(summary.label.contains("Type: unsupported\nText: \nURL: \nStatus: unavailable"))
    }
}
