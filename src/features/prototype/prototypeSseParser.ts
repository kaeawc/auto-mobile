/**
 * Incremental parser for a `text/event-stream` body, following the WHATWG EventSource processing
 * model: lines end in LF, CR or CRLF (a CRLF split across chunks counts once), a leading BOM is
 * ignored, comment lines are skipped, `data` lines join with LF, and the last event id persists
 * across events. Retry values are reported through `onRetry`.
 */
export interface SseEvent {
  /** Event name; absent for the default `message` event. */
  event?: string;
  data: string;
  /** The stream's last event id when the event was dispatched. */
  id?: string;
}

export interface SseParserHandlers {
  onEvent(event: SseEvent): void;
  onRetry?(ms: number): void;
}

export class SseParser {
  private buffer = "";
  private pendingCr = false;
  private atStart = true;
  private eventName = "";
  private dataLines: string[] = [];
  private hasData = false;
  private lastEventId = "";

  constructor(private readonly handlers: SseParserHandlers) {}

  /**
   * Characters buffered for the event being assembled: the data lines as they will join, the event
   * name and the retained id (both relayed with the event), plus the line still arriving (which
   * includes its `field:` prefix). For size limits.
   */
  get pendingChars(): number {
    const joined = this.dataLines.reduce((sum, line) => sum + line.length, 0);
    return (
      this.buffer.length +
      joined +
      Math.max(0, this.dataLines.length - 1) +
      this.eventName.length +
      this.lastEventId.length
    );
  }

  seedLastEventId(id: string): void {
    this.lastEventId = id;
  }

  push(chunk: string): void {
    let text = chunk;
    if (this.atStart && text.length > 0) {
      this.atStart = false;
      text = text.startsWith("﻿") ? text.slice(1) : text;
    }
    for (const char of text) {
      if (this.pendingCr) {
        this.pendingCr = false;
        if (char === "\n") {
          continue;
        }
      }
      if (char === "\r") {
        this.pendingCr = true;
        this.endLine();
      } else if (char === "\n") {
        this.endLine();
      } else {
        this.buffer += char;
      }
    }
  }

  private endLine(): void {
    const line = this.buffer;
    this.buffer = "";
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    this.applyField(field, value);
  }

  private applyField(field: string, value: string): void {
    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.dataLines.push(value);
      this.hasData = true;
    } else if (field === "id") {
      if (!value.includes("\0")) {
        this.lastEventId = value;
      }
    } else if (field === "retry" && /^[0-9]+$/.test(value)) {
      this.handlers.onRetry?.(Number(value));
    }
  }

  private dispatch(): void {
    const name = this.eventName;
    const hadData = this.hasData;
    const data = this.dataLines.join("\n");
    this.eventName = "";
    this.dataLines = [];
    this.hasData = false;
    if (!hadData) {
      return;
    }
    this.handlers.onEvent({
      ...(name === "" ? {} : { event: name }),
      data,
      ...(this.lastEventId === "" ? {} : { id: this.lastEventId }),
    });
  }
}
