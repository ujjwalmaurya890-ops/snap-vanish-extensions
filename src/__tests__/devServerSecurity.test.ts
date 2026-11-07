// @vitest-environment node
import fs from "node:fs";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localVisionAssetsPlugin } from "../../vite.config";

interface Response {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(port: number, pathname: string, method = "GET", host = "localhost"): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("local vision asset middleware", () => {
  let fixture: string;
  let server: Server;
  let port: number;
  let symlinksAvailable = false;

  beforeAll(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "snap-vite-security-"));
    for (const name of ["models", "vendor", "models-private"]) {
      fs.mkdirSync(path.join(fixture, "extension", name), { recursive: true });
    }
    fs.mkdirSync(path.join(fixture, "outside"));
    fs.writeFileSync(path.join(fixture, "extension/models/safe.task"), "allowed-model");
    fs.writeFileSync(path.join(fixture, "extension/models-private/secret.task"), "prefix-secret");
    fs.writeFileSync(path.join(fixture, "extension/vendor/secret.mjs"), "other-root-secret");
    fs.writeFileSync(path.join(fixture, "outside/secret.task"), "outside-secret");
    try {
      fs.symlinkSync(path.join(fixture, "outside/secret.task"), path.join(fixture, "extension/models/escape.task"), "file");
      fs.symlinkSync(path.join(fixture, "outside"), path.join(fixture, "extension/wasm"), "dir");
      symlinksAvailable = true;
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }

    let middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void = () => {
      throw new Error("Middleware was not installed");
    };
    const hook = localVisionAssetsPlugin(fixture).configureServer;
    if (typeof hook !== "function") throw new Error("Expected a configureServer hook");
    hook.call({} as ThisParameterType<typeof hook>, { middlewares: { use(fn: typeof middleware) { middleware = fn; } } } as unknown as ViteDevServer);
    server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end("Not found"); }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  });

  it("serves valid local files and HEAD metadata only", async () => {
    const result = await request(port, "/models/safe.task?cache=1");
    expect(result.status).toBe(200);
    expect(result.body).toBe("allowed-model");
    expect(result.headers["content-type"]).toBe("application/octet-stream");
    expect(result.headers["cache-control"]).toBe("public, max-age=3600");
    const head = await request(port, "/models/safe.task", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect((await request(port, "/models/safe.task", "POST")).status).toBe(405);
    expect((await request(port, "/unrelated")).status).toBe(404);
  });

  it.each([
    "/models/../models-private/secret.task",
    "/models/%2e%2e%2fmodels-private/secret.task",
    "/models/../vendor/secret.mjs",
    "/models/%2e%2e/vendor/secret.mjs",
  ])("blocks traversal and similarly prefixed siblings: %s", async (url) => {
    const result = await request(port, url);
    expect(result.status).toBe(403);
    expect(result.body).not.toMatch(/secret/);
  });

  it("rejects malformed encodings, NULs and platform separators", async () => {
    for (const url of ["/models/%", "/models/%00secret.task", "/models/%5csecret.task"]) {
      expect((await request(port, url)).status).toBe(400);
    }
  });

  it("does not serve missing files or directories", async () => {
    expect((await request(port, "/models/missing.task")).status).toBe(404);
    fs.mkdirSync(path.join(fixture, "extension/models/subdir"));
    expect((await request(port, "/models/subdir")).status).toBe(404);
  });

  it("does not follow file or asset-root symlinks outside their permitted folder", async ({ skip }) => {
    if (!symlinksAvailable) skip();
    expect((await request(port, "/models/escape.task")).status).toBe(403);
    expect((await request(port, "/wasm/secret.task")).status).toBe(403);
  });
});

describe("Vite preview-host protection", () => {
  let vite: ViteDevServer;
  let port: number;

  beforeAll(async () => {
    vite = await createViteServer({
      configFile: path.resolve("vite.config.ts"),
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    port = (vite.httpServer!.address() as AddressInfo).port;
  }, 20_000);

  afterAll(async () => { await vite?.close(); });

  it("accepts localhost and Arena preview hosts but rejects unrelated hostnames", async () => {
    const asset = "/vendor/vision_bundle.mjs";
    expect((await request(port, asset, "GET", "localhost")).status).toBe(200);
    expect((await request(port, asset, "GET", "3000-example.e2b.app")).status).toBe(200);
    expect((await request(port, asset, "GET", "attacker.example")).status).toBe(403);
    expect((await request(port, asset, "GET", "e2b.app.attacker.example")).status).toBe(403);
  });
});
