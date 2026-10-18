import type { Timer } from "../../utils/interfaces/Timer";
import type { AppBundleMetadata } from "../../utils/ios-cmdline-tools/AppBundleMetadataClient";
import type { PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import type { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { ChooserAppMetadata, HostExec } from "./DeepLinkManager";

/** Optional collaborators for {@link DeepLinkManager}; each defaults to the production one. */
export interface DeepLinkManagerDependencies {
  simctl?: Pick<SimCtlClient, "executeCommandArgs"> | null;
  hostExec?: HostExec | null;
  plist?: PlistReader;
  appBundleMetadata?: AppBundleMetadata;
  chooserMetadata?: ChooserAppMetadata;
  timer?: Timer;
  /** HandleIntentChooser creates a manager per execution; never share a request signal across calls. */
  chooserSignal?: AbortSignal;
}
