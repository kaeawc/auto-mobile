import { Server as HttpServer } from "node:http";

type FakeHttpServerContract = Pick<HttpServer, "listening">;

/** An http.Server that reports a fixed listening state without binding a port. */
export class FakeHttpServer extends HttpServer implements FakeHttpServerContract {
  override listening: boolean;

  constructor(listening: boolean) {
    super();
    this.listening = listening;
  }
}
