import { ActionableError } from "../../../models/ActionableError";

/**
 * The bundle never reached ProtoViewer: its data container could not be resolved, its folders
 * could not be prepared, the copy was refused, or the app could not read the inbox file
 * (including Android scoped storage, #15174). A save keeps the existing platform path.
 */
export class ProtoViewerStorageError extends ActionableError {}
