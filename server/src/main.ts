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
import { WebSocketServer } from "ws";
import { SqliteWorkspaceStore } from "./store/index.js";
import { WorkspaceService } from "./workspace/index.js";
import { RoomManager } from "./room/index.js";
import { WebSocketGateway, wsConnection } from "./gateway/index.js";
import type { BedrockAgentService } from "./agent/index.js";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? "maw.db";
const REGION = process.env.BEDROCK_REGION ?? process.env.AWS_REGION;

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
