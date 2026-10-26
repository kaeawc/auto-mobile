# Third-party licenses linked into ProtoViewer

One `<swiftpm-package-identity>.txt` per third-party Swift package the viewer links (including
transitive ones), holding that package's license text. `scripts/ios/protoviewer-notices.ts`
embeds them in the generated acknowledgements list and fails on a missing or orphaned file.
There are none today: the viewer links first-party code only.
