import type { AppearanceConfig, AppearanceMode, AppearanceSyncMode } from "../models";

export type AppearanceSocketCommand =
  | "set_appearance_sync"
  | "set_appearance"
  | "get_appearance_config";

export type AppearanceSocketRequest = {
  id: string;
  type?: "appearance_request";
  command?: AppearanceSocketCommand;
  method?: AppearanceSocketCommand;
  sessionUuid?: string;
  enabled?: boolean;
  mode?: AppearanceSyncMode | string;
  params?: {
    enabled?: boolean;
    mode?: AppearanceSyncMode | string;
  };
};

export type AppearanceSocketResponse = {
  id: string;
  type: "appearance_response";
  success: boolean;
  result?: {
    config?: AppearanceConfig;
    appliedMode?: AppearanceMode;
    warning?: string;
  };
  error?: string;
};
