// Bun inlines `with { type: "text" }` imports into the bundle, so assets such as
// the iOS Files fixture sources ship inside dist without a separate file copy.
declare module "*.swift" {
  const content: string;
  export default content;
}

declare module "*.plist" {
  const content: string;
  export default content;
}
