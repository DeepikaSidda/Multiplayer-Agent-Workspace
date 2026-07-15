/**
 * Runnable server bootstrap for the Multiplayer Agent Workspace.
 *
 * Wires the already-implemented pieces into a live process:
 *  - a durable {@link SqliteWorkspaceStore} (file-backed),
 *  - the {@link WorkspaceService} + {@link RoomManager},
 *  - the {@link WebSocketGateway} over a real `ws` server,
 *  - a tiny HTTP API to create a workspace (returns a shareable join reference).
 *
 * The Bedrock agent service is wired only when AWS credentials/region are
 * present in the environment, so the app runs locally without AWS. When absent,
 * @mentioning an agent simply won't trigger a model call.
 *
 * Env:
 *   PORT      - HTTP/WS port (default 8787)
 *   DB_PATH   - SQLite file path (default "maw.db")
 *   AWS_REGION / BEDROCK_REGION - enables the Nova Pro agent service when set
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SqliteWorkspaceStore } from "./store/index.js";
import { WorkspaceService } from "./workspace/index.js";
import { RoomManager } from "./room/index.js";
import { WebSocketGateway, wsConnection } from "./gateway/index.js";
import type { BedrockAgentService } from "./agent/index.js";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? "maw.db";
const REGION = process.env.BEDROCK_REGION ?? process.env.AWS_REGION;

// Directory of the production client build (vite build output). Overridable via
// WEB_ROOT; defaults to `client/dist-web` relative to this compiled file
// (server/dist/main.js -> ../../client/dist-web).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = process.env.WEB_ROOT ?? path.resolve(__dirname, "../../client/dist-web");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve a static asset from the client build, with SPA fallback to index.html.
 * Returns true if the request was handled. Path traversal is prevented by
 * resolving within WEB_ROOT.
 */
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!fs.existsSync(WEB_ROOT)) return false;
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
  const candidate = path.normalize(path.join(WEB_ROOT, urlPath));
  // Reject anything that escapes WEB_ROOT.
  if (!candidate.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    res.end();
    return true;
  }

  let filePath = candidate;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback: unknown routes render the app shell.
    filePath = path.join(WEB_ROOT, "index.html");
    if (!fs.existsSync(filePath)) return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function buildAgentService(): Promise<BedrockAgentService | undefined> {
  if (!REGION) return undefined;
  try {
    const [{ BedrockRuntimeClient }, { BedrockAgentServiceImpl }] = await Promise.all([
      import("@aws-sdk/client-bedrock-runtime"),
      import("./agent/index.js"),
    ]);
    const client = new BedrockRuntimeClient({ region: REGION });
    // The concrete client satisfies the narrow ConverseStreamClient seam.
    return new BedrockAgentServiceImpl(client as never);
  } catch (err) {
    console.warn("[maw] Bedrock agent service unavailable:", err);
    return undefined;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

async function main(): Promise<void> {
  const store = new SqliteWorkspaceStore(DB_PATH);
  const workspaceService = new WorkspaceService(store);
  const agentService = await buildAgentService();
  const roomManager = new RoomManager(store, agentService ? { agentService } : {});
  const gateway = new WebSocketGateway({ workspaceService, roomManager, store });
  gateway.start();

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, { ok: true, agent: agentService ? "nova-pro" : "disabled" });
      return;
    }

    if (req.method === "POST" && req.url === "/api/workspaces") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        void (async () => {
          try {
            const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
            const ownerDisplayName =
              typeof parsed.ownerDisplayName === "string" && parsed.ownerDisplayName.trim()
                ? parsed.ownerDisplayName
                : "Owner";
            const result = await workspaceService.createWorkspace({
              ownerDisplayName,
              artifactType: parsed.artifactType,
            });
            if (!result.ok) {
              json(res, 500, { error: result.error, message: result.message });
              return;
            }
            json(res, 200, {
              workspaceId: result.workspace.id,
              joinReference: result.workspace.joinReference,
              ownerId: result.owner.id,
              artifactType: result.artifact.artifactType,
            });
          } catch {
            json(res, 400, { error: "BAD_REQUEST" });
          }
        })();
      });
      return;
    }

    // Serve the built client (single-origin deploy) for any other GET request.
    if (req.method === "GET" && serveStatic(req, res)) {
      return;
    }

    json(res, 404, { error: "NOT_FOUND" });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    gateway.handleConnection(wsConnection(socket));
  });

  server.listen(PORT, () => {
    console.log(`[maw] server listening on http://localhost:${PORT}`);
    console.log(`[maw] websocket endpoint: ws://localhost:${PORT}/ws`);
    console.log(`[maw] agent service: ${agentService ? "Nova Pro (Bedrock)" : "disabled (set AWS_REGION to enable)"}`);
  });

  const shutdown = () => {
    gateway.stop();
    wss.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
