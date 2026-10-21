import type { Timer } from "../../utils/interfaces/Timer";
import type { AppBundleMetadata } from "../../utils/ios-cmdline-tools/AppBundleMetadataClient";
import type { PlistReader } from "../../utils/ios-cmdline-tools/PlistClient";
import type { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { DeepLinkElementServices } from "./DeepLinkElementServices";
import type { DeepLinkResult } from "../../models";
import type { ChooserAppMetadata, HostExec, PhysicalIosBundleSource } from "./DeepLinkManager";

/** Optional collaborators for {@link DeepLinkManager}; each defaults to the production one. */
export interface DeepLinkManagerDependencies {
  simctl?: Pick<SimCtlClient, "executeCommandArgs"> | null;
  hostExec?: HostExec | null;
  plist?: PlistReader;
  appBundleMetadata?: AppBundleMetadata;
  /** Physical iOS bundle copy (#14094); defaults to DeviceAppManager. */
  deviceApps?: PhysicalIosBundleSource;
  /** Physical iOS result cache; defaults to a process-wide map. */
  physicalDeepLinkCache?: Map<string, DeepLinkResult>;
  chooserMetadata?: ChooserAppMetadata;
  timer?: Timer;
  /** HandleIntentChooser creates a manager per execution; never share a request signal across calls. */
  chooserSignal?: AbortSignal;
  elementServices?: DeepLinkElementServices;
}
