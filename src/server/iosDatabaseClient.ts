import type { BootedDevice } from "../models";
import { IOSCtrlProxyClient } from "../features/observe/ios";

/** The slice of the iOS CtrlProxy client the database tools and resources use. */
export type IosDatabaseClient = Pick<
  IOSCtrlProxyClient,
  | "queryCoreDataForIos"
  | "executeSQLForIos"
  | "listDatabasesForIos"
  | "listTablesForIos"
  | "getTableDataForIos"
  | "getTableStructureForIos"
>;

/** How iOS database calls reach CtrlProxy; injected into the register* functions. */
export type IosDatabaseClientResolver = (device: BootedDevice) => IosDatabaseClient;

export const defaultIosDatabaseClientResolver: IosDatabaseClientResolver = (device) =>
  IOSCtrlProxyClient.getInstance(device);
