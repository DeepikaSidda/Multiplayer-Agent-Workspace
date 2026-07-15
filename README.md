# Multiplayer Agent Workspace

A real-time collaborative workspace where **multiple humans and one or more AI agents** work together as teammates to develop an idea and produce a concrete, exportable artifact (a plan, PRD, issue, workflow, pitch, or checklist). AI teammates are first-class participants: they share the same document, observe the same context, and contribute directly to the collaborative work product.

> **Live demo:** http://13.220.41.228/ (AWS EC2, us-east-1 — temporary demo instance)


## What it does

- **Shared room** — humans and agents join the same workspace over WebSockets; presence, chat, and the artifact stay in sync in real time.
- **AI teammates** — add an agent (powered by **Amazon Bedrock — Nova Pro**, `amazon.nova-pro-v1:0`), give it a persona/role, and `@mention` it. It responds using the full conversation and the current artifact as context.
- **Co-created artifact** — humans and agents edit one shared Markdown document (a Yjs CRDT), so concurrent edits merge without losing work.
- **Export** — produce the final Markdown artifact when you're done.

## Collaboration signals demonstrated

1. **A human adds an idea/comment/decision** into the shared workspace (chat + artifact editing).
2. **An agent responds using shared workspace context** (complete message log + current artifact content).
3. **An agent creates/updates a shared artifact** (proposed content is applied to the shared plan/PRD/etc.).
4. **The user can edit / respond to the agent's contribution** (co-edit the artifact, reply in chat).
5. **Two or more roles appear** (human + agent; multiple agent personas supported).
6. **Visible history of human + agent contributions** (attributed, ordered, persisted message log).
7. **A final output is generated from the collaborative process** (Export Markdown), not a single prompt.

## Architecture

- **`shared/`** — TypeScript domain types, constants, and the WebSocket event contract.
- **`server/`** — Node.js + TypeScript. WebSocket gateway, per-room manager, and services for messaging, presence, the artifact CRDT (Yjs), export, and the Bedrock agent. Durable persistence via SQLite (`better-sqlite3`).
- **`client/`** — React + TypeScript SPA. Presence, chat, a Markdown artifact editor bound to a local Yjs doc, agent management, and export controls.

## Prerequisites

- Node.js 18+ and npm
- (Optional, for the AI agent) AWS credentials with Amazon Bedrock access to `amazon.nova-pro-v1:0`

## Setup

```bash
npm install
cp .env.example .env   # then edit .env (Windows: copy .env.example .env)
npm run build
```

Set `AWS_REGION` in `.env` to enable the agent. Without it, the app still runs; `@mentioning` an agent just won't call a model.

## Run

Open two terminals from the repo root:

```bash
# Terminal 1 — server (HTTP + WebSocket on :8787)
npm run start -w @maw/server

# Terminal 2 — client dev server (http://localhost:5173)
npm run dev -w @maw/client
```

Then open http://localhost:5173:

1. Enter a display name, choose an artifact type, and **Create workspace**.
2. Add an agent (e.g. `Nova`), then send `@Nova draft a plan for ...`.
3. Watch the agent reply and update the shared artifact; edit it together.
4. **Share link** (top bar) to collaborate with a second browser/person.
5. **Export Markdown** for the final output.

## Testing

```bash
npm test          # all packages
npm run typecheck # type-check all packages
```

The server suite includes **21 property-based tests** (fast-check, ≥100 iterations each) covering message validation/ordering, ID uniqueness, artifact size limits, CRDT convergence, agent orchestration/rollback, export completeness, and persistence round-trips.

## Environment variables

See [`.env.example`](./.env.example). Key variables:

| Variable | Scope | Purpose |
|---|---|---|
| `PORT` | server | HTTP/WebSocket port (default `8787`) |
| `DB_PATH` | server | SQLite file path (default `maw.db`) |
| `AWS_REGION` / `BEDROCK_REGION` | server | Enables the Nova Pro agent when set |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_PROFILE` | server | AWS credentials (via the standard SDK provider chain) |
| `VITE_SERVER_HTTP` / `VITE_SERVER_WS` | client | Override the server URLs if not on localhost:8787 |

No real secrets are committed; `.env` is git-ignored.

## How Kiro was used

See [the "Kiro / agentic development" section below](#kiro--agentic-development).

## Kiro / agentic development

This project was built with **Kiro's spec-driven workflow**, not one-shot prompting. I started from a rough idea and Kiro guided it through three ground-truth artifacts under `.kiro/specs/multiplayer-agent-workspace/`: a **requirements** document (EARS-style acceptance criteria across 8 requirements), a **design** document (architecture, component interfaces, data models, and 21 formal correctness properties), and a dependency-ordered **tasks** list. Each phase was reviewed before moving on, so the design stayed anchored to real requirements.

Implementation was executed as **agentic, spec-driven task runs**. Kiro worked through the task list wave by wave, delegating each task to a focused sub-agent that wrote the code, then ran the build and tests before the next task began. A core principle was **property-based testing**: the design fixed executable correctness properties (e.g. "concurrent edits converge and preserve every committed edit," "artifact size limit is never exceeded," "persistence failure is transactional"), and each was implemented as a fast-check property running ≥100 iterations. This caught edge cases traditional example tests miss and gave objective evidence the system meets its spec — the suite runs 225 tests green.

Kiro also handled the "last mile": wiring runnable server/client entrypoints, diagnosing a duplicate-participant bug (verified with a reproduction script, then fixed by threading a stable participant id through the join flow), and iterating on the UI. Treating specs and correctness properties as the source of truth kept the agentic development loop reliable rather than ad hoc.
