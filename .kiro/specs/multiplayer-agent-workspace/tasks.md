# Implementation Plan: Multiplayer Agent Workspace

## Overview

This plan builds the Multiplayer Agent Workspace incrementally: first the shared types and persistence store, then the pure server services (messaging, presence, artifact CRDT, export), then the Bedrock Agent Service using Amazon Nova Pro (`amazon.nova-pro-v1:0`) via ConverseStream, then the WebSocket gateway and room manager that wire everything together, and finally the React + TypeScript client UI. Each step builds on the previous ones and ends by integrating into the running system so no code is left orphaned.

Property-based tests use `fast-check` + Vitest, run a minimum of 100 iterations, and are tagged with a comment of the form `// Feature: multiplayer-agent-workspace, Property {number}: {property_text}`. Test sub-tasks are marked with `*` and are optional.

## Tasks

- [x] 1. Set up project structure, shared types, and tooling
  - [x] 1.1 Scaffold monorepo workspaces and tooling
    - Create `server/` (Node.js + TypeScript) and `client/` (React + TypeScript) packages with a shared `tsconfig` base
    - Add dependencies: server (`ws`, `yjs`, `@aws-sdk/client-bedrock-runtime`, `better-sqlite3`), client (`react`, `yjs`), dev (`vitest`, `fast-check`, `typescript`)
    - Configure Vitest for the server package and add npm scripts for build and `vitest --run`
    - _Requirements: 1.1, 6.1_

  - [x] 1.2 Define shared domain types and constants
    - Create a shared types module for `Workspace`, `Participant`, `Message`, `ArtifactSnapshot`, `ParticipantType`, `PresenceState`, `ArtifactType`, `MessageKind`
    - Define constants: message length bounds (1..4000), artifact content limit (100000), agent capacity (5), valid `ArtifactType` set, agent timeout (60s)
    - Define the WebSocket event envelope type `{ type, workspaceId, payload }` and the client→server / server→client event payload types
    - _Requirements: 3.1, 4.1, 6.1, 6.5_

- [x] 2. Implement the persistence store
  - [x] 2.1 Implement the WorkspaceStore interface with SQLite
    - Define the `WorkspaceStore` interface (createWorkspace, getWorkspaceByJoinRef, workspaceExists, appendMessage, loadMessages, saveArtifactSnapshot, loadArtifact, upsertParticipant, removeParticipant)
    - Implement a `SqliteWorkspaceStore` using `better-sqlite3` with tables for workspaces, participants, messages, and artifact snapshots (storing `yjsState`)
    - Implement an in-memory `WorkspaceStore` for tests and a failure-injecting decorator that can force persistence failures
    - Ensure `createWorkspace` is a single transactional insert (no partial workspace/owner rows on failure)
    - _Requirements: 1.1, 1.2, 8.1, 8.3_

  - [x]* 2.2 Write property test for persistence round-trip
    - **Property 20: Persistence round-trip restores full state** — for any persisted workspace state, rejoining restores identical artifact content and the complete message log in (timestamp, sequence) order
    - **Validates: Requirements 8.1, 8.3, 8.5**

- [x] 3. Implement workspace lifecycle and join resolution
  - [x] 3.1 Implement workspace creation and join-reference resolution
    - Implement create-workspace logic that generates a unique id and a shareable join reference resolving to that id, assigns the requesting human as Owner, and initializes an artifact
    - Initialize the artifact with the Owner-selected `ArtifactType` when valid, defaulting to `"plan"`, with empty content
    - Implement join resolution: resolve a join reference to a workspace, add a human as a Participant idempotently (reconnect without duplicate), and return `WORKSPACE_NOT_FOUND` for unknown references
    - On creation failure, write no workspace/owner rows and surface a `WORKSPACE_CREATE_FAILED` error
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 6.2_

  - [x]* 3.2 Write property test for unique ids and ownership
    - **Property 1: Workspace creation produces unique identifiers and correct ownership** — across creation requests, all ids are pairwise distinct and each records its requester as Owner
    - **Validates: Requirements 1.1**

  - [x]* 3.3 Write property test for join-reference round-trip
    - **Property 2: Join reference round-trip** — resolving a workspace's generated join reference returns exactly that workspace's id
    - **Validates: Requirements 1.3**

  - [x]* 3.4 Write property test for idempotent join membership
    - **Property 3: Join membership is idempotent** — joining via a valid reference adds the participant exactly once; rejoining when already a member leaves the set unchanged
    - **Validates: Requirements 1.4, 1.5**

  - [x]* 3.5 Write property test for artifact initialization type
    - **Property 16: Artifact initialization uses a valid type** — the initialized artifact has empty content and the Owner-selected type when valid, otherwise "plan"
    - **Validates: Requirements 6.1, 6.2**

- [x] 4. Implement the Message Service
  - [x] 4.1 Implement message validation, stamping, and ordering
    - Validate content (≥1 non-whitespace char, ≤4000 chars); reject with reasons `EMPTY`, `WHITESPACE_ONLY`, `TOO_LONG`
    - On valid content, stamp millisecond `timestamp` and monotonic per-workspace `sequence`, persist before adding to in-memory state (persist-before-broadcast), and return the stamped message
    - On persistence failure, reject the append, exclude the message from the log, and return a save error without broadcasting
    - Provide an ordering helper that sorts messages by ascending `(timestamp, sequence)`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 8.1, 8.2_

  - [x]* 4.2 Write property test for valid message append
    - **Property 6: Valid messages are appended with identity and millisecond timestamp** — a valid message yields exactly one appended log entry with sender identity and ms timestamp, delivered to all active participants
    - **Validates: Requirements 3.1, 3.3, 3.5**

  - [x]* 4.3 Write property test for invalid message rejection
    - **Property 7: Invalid messages are rejected** — empty, whitespace-only, or over-4000-char content is rejected, leaves the log unchanged, and returns a rejection error
    - **Validates: Requirements 3.2**

  - [x]* 4.4 Write property test for total message ordering
    - **Property 8: Message display order is total by (timestamp, sequence)** — presented order equals sorting by ascending timestamp with ties broken by ascending sequence
    - **Validates: Requirements 3.4**

  - [x]* 4.5 Write property test for transactional persistence failure
    - **Property 21: Persistence failure is transactional** — a failed message/artifact persist rejects the operation, retains last persisted state, never broadcasts, and returns a save error
    - **Validates: Requirements 8.2, 8.4**

- [x] 5. Implement the Presence Service
  - [x] 5.1 Implement presence tracking and active-count reporting
    - Track participant presence states (`active`, `processing`, `disconnected`) and maintain the active set on join, graceful leave, and heartbeat-based disconnect reaping (grace window under 30s)
    - Compute presence updates and active-count updates consistent with the current active set
    - Distinguish agent presence (support `processing` state) from human presence for downstream visual treatment
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 4.2_

  - [x]* 5.2 Write property test for presence/count consistency
    - **Property 5: Presence and active count are consistent with the active set** — across joins and leaves, the presence set and reported active count equal the currently active participants
    - **Validates: Requirements 2.1, 2.2, 2.5, 4.2**

- [x] 6. Checkpoint - core store and pure services
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement the Artifact Service (Yjs CRDT)
  - [x] 7.1 Implement CRDT edit application with size guard and metadata
    - Wrap an authoritative `Y.Doc` / `Y.Text` per workspace; apply incoming Yjs updates and compute resulting length
    - Enforce the 100,000-character limit on the resulting document; reject over-limit updates (`SIZE_LIMIT`) and preserve prior content
    - Persist the artifact snapshot (content + encoded `yjsState`) before broadcast; on persist failure revert to last persisted `yjsState` and return `PERSIST_FAILED`
    - Record `lastEditorId` and `lastEditedAt` on every applied change; expose `getContent`
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 6.7, 8.3, 8.4_

  - [x] 7.2 Implement origin-tagged snapshot and rollback for agent edits
    - Implement `snapshotOrigin` / `rollbackOrigin` so an agent's edits are applied in a transaction tagged with the agent id and can be undone via a scoped `Y.UndoManager` without discarding concurrent human edits
    - _Requirements: 5.4, 6.7_

  - [x]* 7.3 Write property test for author-agnostic valid edits
    - **Property 14: Valid-size edits are applied regardless of author** — any edit (human or agent) resulting in ≤100,000 chars is applied, records editor identity and timestamp, and is delivered to all active participants
    - **Validates: Requirements 6.3, 6.4, 6.6**

  - [x]* 7.4 Write property test for size-limit enforcement
    - **Property 15: Artifact size limit is never exceeded** — any edit that would exceed 100,000 chars is rejected, existing content preserved, and stored length never exceeds the limit
    - **Validates: Requirements 6.5**

  - [x]* 7.5 Write property test for CRDT convergence
    - **Property 17: Concurrent edits converge and preserve every committed edit** — concurrent edits in any interleaving converge to identical content containing every committed edit
    - **Validates: Requirements 6.7**

- [x] 8. Implement the Export Service
  - [x] 8.1 Implement Markdown export
    - Read current artifact content; if it has no non-whitespace character, return `EXPORT_EMPTY` and produce nothing
    - Otherwise wrap the full content verbatim with a header derived from `ArtifactType` + workspace metadata and return `{ filename, markdown }`; on unexpected failure return `EXPORT_FAILED` and leave the artifact unchanged
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x]* 8.2 Write property test for complete export content
    - **Property 18: Export contains the complete artifact content** — the exported Markdown contains the full current content verbatim (extracted body equals the original)
    - **Validates: Requirements 7.1, 7.3**

  - [x]* 8.3 Write property test for empty export refusal
    - **Property 19: Empty artifact export is refused** — empty/whitespace-only content yields no export and an "artifact is empty" message
    - **Validates: Requirements 7.4**

- [x] 9. Implement the Bedrock Agent Service (Amazon Nova Pro)
  - [x] 9.1 Implement context assembly and Nova Pro invocation via ConverseStream
    - Build the system prompt framing Nova Pro (`amazon.nova-pro-v1:0`) as a named teammate for the given `ArtifactType`, embedding current artifact content
    - Implement `mapLogToConverseMessages`: agent's own messages → `assistant`, others → `user` with a `Sender:` prefix, merging consecutive same-role messages
    - Call `ConverseStreamCommand` with `inferenceConfig` (maxTokens/temperature/topP), accumulate `contentBlockDelta` text, and parse an optional fenced ```artifact``` block into `proposedArtifact`
    - _Requirements: 4.3, 5.1, 5.2_

  - [x] 9.2 Implement timeout and failure handling
    - Wrap the stream in a 60s `AbortController`; on expiry abort and return `TIMEOUT`
    - Map SDK/model errors to `MODEL_ERROR` and malformed artifact blocks to `PARSE_ERROR`, returning a structured `AgentGenerationResult` failure
    - _Requirements: 5.4, 5.5_

  - [x]* 9.3 Write property test for agent context targeting and completeness
    - **Property 11: Agent context is complete and correctly targeted** — a message naming/replying to an agent triggers generation for that agent with context including the complete message log and current artifact content (using a mock BedrockAgentService)
    - **Validates: Requirements 4.3, 5.1**

- [x] 10. Implement the Room Manager and agent orchestration
  - [x] 10.1 Implement per-room in-memory state and operation serialization
    - Maintain participant set, presence map, authoritative `Y.Doc`, and message sequence counter per workspace; serialize state-changing operations per room
    - Implement add/remove agent with capacity guard (≤5, `AGENT_LIMIT_REACHED`) and unknown-agent guard (`AGENT_NOT_FOUND`), notifying participants
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6_

  - [x] 10.2 Implement the agent response orchestration flow
    - On a message that names or replies to an agent: set agent presence to `processing`, snapshot the artifact origin, invoke the Bedrock Agent Service, and on success append exactly one agent-attributed message and apply the proposed artifact edit as the tagged transaction, then revert presence to idle
    - On failure/timeout: append an agent-attributed error message, roll back only the agent's tagged CRDT transaction (preserving concurrent human edits), and revert presence to idle
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x]* 10.3 Write property test for agent capacity cap
    - **Property 9: Agent capacity is capped at five** — agent count never exceeds five and any add while five present is rejected with an error and adds no participant
    - **Validates: Requirements 4.1, 4.5**

  - [x]* 10.4 Write property test for agent add/remove round-trip
    - **Property 10: Agent add/remove round-trip** — adding then removing an agent restores the prior participant set and count; removing a non-participant agent is rejected and leaves the roster unchanged
    - **Validates: Requirements 4.1, 4.4, 4.6**

  - [x]* 10.5 Write property test for successful agent response
    - **Property 12: Successful agent generation appends one attributed response** — successful generation adds exactly one agent-attributed message and shows processing presence during generation, reverting afterward
    - **Validates: Requirements 5.2, 5.3**

  - [x]* 10.6 Write property test for failed-generation rollback
    - **Property 13: Failed agent generation rolls back its artifact changes and preserves human edits** — on failure, append an agent error message and revert only the agent's artifact changes while preserving concurrent committed human edits
    - **Validates: Requirements 5.4, 5.5**

- [x] 11. Implement the WebSocket Gateway and wire services together
  - [x] 11.1 Implement the gateway transport and event routing
    - Accept connections, authenticate the session to a workspace, schema-validate all inbound envelopes (drop malformed ones with an `error`), and route typed client→server events (join, sendMessage, artifactUpdate, addAgent, removeAgent, leave, export) to the Room Manager and services
    - Emit server→client events (workspaceSnapshot, presenceUpdate, participantCountUpdate, messageAppended, messageRejected, artifactUpdate, artifactRejected, agentResponseDelta, agentAdded/agentRemoved, exportReady, error) and implement heartbeat ping/pong for disconnect detection
    - On join/rejoin, build and send the `workspaceSnapshot` with current artifact content and the complete message log in (timestamp, sequence) order
    - _Requirements: 1.4, 1.7, 2.1, 2.2, 2.3, 3.3, 8.5_

  - [x]* 11.2 Write property test for join snapshot correctness
    - **Property 4: Join snapshot reflects current state** — the snapshot delivered on join equals the current artifact content and the complete message log ordered by ascending timestamp with ties broken by append sequence
    - **Validates: Requirements 1.7, 8.5**

- [x] 12. Checkpoint - server end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Implement the client SPA
  - [x] 13.1 Implement the WebSocket provider and Yjs sync
    - Implement a client transport that connects over WebSocket, sends client intents, handles server events, and syncs a local `Y.Doc` (apply `artifactUpdate`, emit local edits as `artifactUpdate`)
    - Handle join/create flows and render the `workspaceSnapshot` on join, including reconnect
    - _Requirements: 1.4, 1.7, 6.3, 8.5_

  - [x] 13.2 Implement presence, messaging, and artifact editor UI
    - Render the Presence_Indicator with a distinct visual marker for agents vs humans and the active participant count
    - Render the Message_Log ordered by (timestamp, sequence) with sender identity, using distinct visual treatment for agent messages; provide message input with client-side validation feedback
    - Provide a Markdown-capable artifact editor bound to the local `Y.Doc`
    - _Requirements: 2.1, 2.4, 2.5, 3.4, 3.5, 3.6, 6.3_

  - [x] 13.3 Implement agent management and export controls
    - Provide UI to add/remove agents (surfacing `AGENT_LIMIT_REACHED` / `AGENT_NOT_FOUND` errors) and to mention/reply to a specific agent
    - Provide an export control that requests export and downloads/copies the returned Markdown, surfacing empty/failed export messages
    - Surface message and artifact rejection errors (validation, size limit, save failures) to the responsible participant
    - _Requirements: 4.1, 4.4, 4.5, 4.6, 5.1, 7.1, 7.2, 7.4, 7.5, 3.2, 6.5, 8.2, 8.4_

- [x] 14. Final checkpoint - full system integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Implement hash-driven join-reference invite entry
  - [x] 15.1 Extract and integrate initial URL-hash join-reference parsing
    - Add a pure, testable helper that removes the leading `#`, safely decodes percent-encoding, trims the decoded value, and treats an empty or malformed hash as no invite reference.
    - Read the browser hash on initial load and preserve that parsed reference as the attempted invite target instead of repeatedly deriving it from mutable location state.
    - Keep the existing manual join-reference input path available when the initial hash contains no usable reference.
    - _Requirements: 1.3, 1.4, 1.6_

  - [x] 15.2 Add an invite-specific gate and wire its join action
    - Extract the gate into testable React component/controller seams rather than relying on browser-entry side effects.
    - When an initial invite reference exists, render a focused gate that asks only for the participant display name and provides a clearly labeled `Join shared workspace` action; do not show workspace creation, artifact type, or manual reference controls in this mode.
    - Submit the decoded, trimmed invite reference through `WorkspaceConnection`; when no invite reference exists, retain the current create flow and manual join-reference entry.
    - Keep the joining state visible until a snapshot confirms entry to the shared workspace.
    - _Requirements: 1.3, 1.4, 1.7_

  - [x] 15.3 Add focused helper and gate component tests
    - Cover plain, percent-encoded, whitespace-padded, empty, and malformed URL hashes with deterministic unit tests for the extracted parser.
    - Cover invite mode showing only display name plus `Join shared workspace`, submitting the normalized reference, and no-hash mode retaining manual reference entry.
    - _Requirements: 1.3, 1.4, 1.6, 1.7_

- [x] 16. Recover cleanly from invalid invite references
  - [x] 16.1 Handle `WORKSPACE_NOT_FOUND` as a terminal attempted-join failure
    - Subscribe to structured connection errors before starting the attempted join so an immediate `WORKSPACE_NOT_FOUND` response cannot be missed.
    - On `WORKSPACE_NOT_FOUND`, intentionally close and destroy the attempted `WorkspaceConnection`, cancel/suppress reconnect behavior, clear it from rendered workspace state, and return to the gate without adding or displaying workspace state.
    - Show a useful not-found message and a clear recovery/back action that exits invite mode so the participant can use manual join-reference entry; preserve normal handling for unrelated connection errors.
    - _Requirements: 1.4, 1.6, 1.7_

  - [x] 16.2 Add invalid-invite cleanup and recovery tests
    - Drive a fake connection/server error to verify `WORKSPACE_NOT_FOUND` closes and destroys the attempted connection, schedules no reconnect, returns to the gate, and displays the useful error.
    - Verify the recovery/back action removes invite mode and restores manual join-reference entry, while a successful invite snapshot still enters the workspace and exposes current state.
    - _Requirements: 1.4, 1.6, 1.7_

- [x] 17. Validate the client join-reference experience
  - [x] 17.1 Run the client TypeScript typecheck
    - Run `npm run typecheck -w @maw/client` and fix any type errors introduced by the hash parser, gate extraction, connection cleanup, or recovery state.
    - _Requirements: 1.3, 1.4, 1.6, 1.7_

  - [x] 17.2 Run the client automated tests in non-watch mode
    - Run `npm run test -w @maw/client` (the client script uses `vitest --run`) and fix any failing parser, gate, connection, or existing client regression tests.
    - _Requirements: 1.3, 1.4, 1.6, 1.7_

  - [x] 17.3 Run the production web build
    - Run `npm run build:web -w @maw/client` and fix any production bundling or browser-entry integration failures.
    - _Requirements: 1.3, 1.4, 1.6, 1.7_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; tasks 15.3, 16.2, and 17.1–17.3 are intentionally required regression coverage and validation for the join-reference fix.
- Each task references specific requirements for traceability, and each property test references its property from the design document.
- Property-based tests use `fast-check` + Vitest, run a minimum of 100 iterations, and are tagged `// Feature: multiplayer-agent-workspace, Property {number}: {property_text}`.
- The Bedrock Agent Service is exercised through a mock in agent-flow property tests (11, 12, 13); persistence properties (20, 21) use the in-memory store plus the failure-injecting decorator.
- AI teammates run on Amazon Bedrock using Amazon Nova Pro (`amazon.nova-pro-v1:0`) via Converse/ConverseStream — not Claude.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2", "3.1", "4.1", "5.1", "7.1", "8.1", "9.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.4", "3.5", "4.2", "4.3", "4.4", "4.5", "5.2", "7.2", "8.2", "8.3", "9.2", "9.3"] },
    { "id": 5, "tasks": ["7.3", "7.4", "7.5", "10.1"] },
    { "id": 6, "tasks": ["10.2", "10.3", "10.4"] },
    { "id": 7, "tasks": ["10.5", "10.6", "11.1"] },
    { "id": 8, "tasks": ["11.2", "13.1"] },
    { "id": 9, "tasks": ["13.2"] },
    { "id": 10, "tasks": ["13.3"] },
    { "id": 11, "tasks": ["15.1"] },
    { "id": 12, "tasks": ["15.2"] },
    { "id": 13, "tasks": ["15.3", "16.1"] },
    { "id": 14, "tasks": ["16.2"] },
    { "id": 15, "tasks": ["17.1"] },
    { "id": 16, "tasks": ["17.2"] },
    { "id": 17, "tasks": ["17.3"] }
  ]
}
```
