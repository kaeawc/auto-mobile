/**
 * Local HTTP fixture for the prototype "Data, storage and network" acceptance scenario
 * (skills/manual-test/prototype-acceptance.md, #12531).
 *
 *   bun scripts/manual-test/prototype-request-fixture.ts [port] [--host <address>]
 *
 * The port defaults to 8787 and the host to 127.0.0.1. Prototype requests refuse loopback
 * destinations for both transports (#18903), so bind the host's LAN address (or 0.0.0.0) and call
 * the fixture at that address.
 *
 * Routes (JSON):
 *   GET  /items  -> 200 {"items":[{"id","name"}...]}
 *   POST /items  -> 201 the stored item; body {"name": string} is required (400 otherwise)
 *   GET  /fail   -> 500 with a large body, to prove a non-2xx body is never read or capped
 *   GET  /reset  -> 204, restores the two seed items
 * Every request is logged to stdout so the run can show which transport reached the host.
 */
interface Item {
  id: number;
  name: string;
}

const SEED: readonly Item[] = [
  { id: 1, name: "alpha" },
  { id: 2, name: "beta" },
];

const args = process.argv.slice(2);
const hostFlag = args.indexOf("--host");
const hostname = hostFlag === -1 ? "127.0.0.1" : args[hostFlag + 1];
if (!hostname || hostname.startsWith("--")) {
  console.error("--host needs an address, e.g. --host 0.0.0.0");
  process.exit(2);
}
const positional = args.filter((_, index) => index !== hostFlag && index !== hostFlag + 1);
const port = Number(positional[0] ?? 8787);
let items: Item[] = SEED.map((item) => ({ ...item }));
let nextId = SEED.length + 1;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/items" && request.method === "GET") {
    return json(200, { items });
  }
  if (pathname === "/items" && request.method === "POST") {
    const body = (await request.json().catch(() => undefined)) as { name?: unknown } | undefined;
    if (typeof body?.name !== "string" || body.name.length === 0) {
      return json(400, { error: "name is required" });
    }
    const item = { id: nextId++, name: body.name };
    items.push(item);
    return json(201, item);
  }
  if (pathname === "/fail") {
    return json(500, { error: "fixture failure", padding: "x".repeat(400_000) });
  }
  if (pathname === "/reset") {
    items = SEED.map((item) => ({ ...item }));
    nextId = SEED.length + 1;
    return new Response(null, { status: 204 });
  }
  return json(404, { error: "not found" });
}

const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const response = await handle(request);
    console.log(
      `${new Date().toISOString()} ${request.method} ${new URL(request.url).pathname} ${response.status}`,
    );
    return response;
  },
});

console.log(`prototype request fixture listening on http://${hostname}:${server.port}`);

export {};
