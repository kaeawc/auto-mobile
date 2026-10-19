import { Server as HttpServer } from "node:http";

/** An http.Server that reports a fixed listening state without binding a port. */
export class FakeHttpServer extends HttpServer {
  override listening: boolean;

  constructor(listening: boolean) {
    super();
    this.listening = listening;
  }
}
