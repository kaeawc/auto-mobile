/** Public bundle contract. Library metadata/store manifests remain separate from transport. */
export * from "./bundle/bundleContract";
export { readPrototypeBundle } from "./bundle/bundleReader";
export {
  exportPrototypeBundle,
  type BundleExportInput,
  type BundleExportAsset,
} from "./bundle/bundleExport";
export { commitBundleToDirectory, type BundleCommitFileSystem } from "./bundle/bundleCommit";
export { scanBundleForSecrets } from "./bundle/bundleSecrets";
