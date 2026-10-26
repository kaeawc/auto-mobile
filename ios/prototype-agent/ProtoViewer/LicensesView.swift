import SwiftUI

/// Open-source licenses for everything ProtoViewer links, from the generated notices (#14158).
struct LicensesView: View {
    let notices: [ProtoViewerNotice]

    init(notices: [ProtoViewerNotice] = protoViewerNotices) {
        self.notices = notices
    }

    var body: some View {
        List(notices) { notice in
            NavigationLink {
                ScrollView {
                    Text(notice.license)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
                .navigationTitle(notice.name)
                .navigationBarTitleDisplayMode(.inline)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(notice.name)
                    Text(notice.detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("license-\(notice.id)")
        }
        .navigationTitle("Open-source licenses")
        .navigationBarTitleDisplayMode(.inline)
    }
}
