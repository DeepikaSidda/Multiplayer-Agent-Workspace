# 30–60s Demo Script

A tight run-through that hits 6 of the 7 collaboration signals. Have the server
and client running first (see README → Run).

| Time | Action | Signal shown |
|---|---|---|
| 0:00 | Open http://localhost:5173, enter a name, pick **PRD**, click **Create workspace**. | Shared workspace / room |
| 0:08 | (Optional) Copy the **Share link** and open it in a second browser window so two participants show in presence. | Two+ roles / multiplayer |
| 0:15 | Add an agent named **Nova** with persona `senior product manager`. | Two+ roles |
| 0:22 | Type: `@Nova draft a one-page PRD for a weekend to-do app` and **Send**. | Human adds an idea |
| 0:30 | Nova shows "generating…", then replies in chat and fills the shared **Artifact (PRD)** panel. | Agent responds using context; agent updates shared artifact |
| 0:42 | Edit a line in the artifact yourself, then send `@Nova add a success-metrics section`. | User edits/responds to the agent's contribution |
| 0:52 | Scroll the chat to show the attributed human+agent history, then click **Export Markdown**. | Visible history; final output from the collaboration |

Tips:
- Speak one sentence per step; keep it under 60s.
- If the artifact panel stays empty, explicitly ask: `@Nova put the full PRD into the artifact as markdown`.
- Record the browser window only (1280×720 is plenty).
