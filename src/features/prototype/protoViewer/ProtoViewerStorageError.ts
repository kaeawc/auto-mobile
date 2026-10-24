import { ActionableError } from "../../../models/ActionableError";

/**
 * The bundle never reached ProtoViewer: its shared-storage folders could not be prepared, the push
 * was refused, or the app could not see the pushed file (API 30+ scoped storage, #15174). Nothing
 * was imported, so a save keeps the CtrlProxy path instead of failing.
 */
export class ProtoViewerStorageError extends ActionableError {}
