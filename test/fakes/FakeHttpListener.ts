import { EventEmitter } from "node:events";
import type { HttpListener } from "../../src/daemon/daemonHttpIngress";

/** An HTTP listener double that only reports whether it is listening; it never binds a port. */
export class FakeHttpListener extends EventEmitter implements HttpListener {
  requestTimeout = 0;
  headersTimeout = 0;
  timeout = 0;

  constructor(public listening: boolean) {
    super();
  }

  listen(_port: number, _host: string, callback: () => void): this {
    this.listening = true;
    queueMicrotask(callback);
    return this;
  }

  close(callback: (error?: Error) => void): this {
    this.listening = false;
    callback();
    return this;
  }
}
