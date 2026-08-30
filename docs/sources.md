# The four sources

This chapter describes what measurement turned up about the stores — including
the traps that are not visible at a glance, and for each of which there is a
regression test.

## Claude Code

```
~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
~/.claude/projects/<cwd-slug>/<sessionId>/subagents/<agentId>.jsonl
```

JSONL, one record per line. On the reference machine **13 kinds** of `type`
occur; of these only `user` and `assistant` are conversation.

- **`message.content` can be a string or a block array.** From the array
  **only** the `type: "text"` blocks are indexed. A `thinking` block carries
  several kilobytes of base64 `signature`, an `attachment` record is inserted
  content — neither is conversation. A whitelist, not a blacklist: a new
  record type thus does not silently pollute the index.
- **The `queue-operation` record contains the prompt text** before it becomes
  a `user` record. Indexing both would duplicate.
- **Title:** `ai-title` (generated) and `custom-title` (manual). Manual wins,
  a later one overwrites an earlier one. Older transcripts have neither —
  their title comes from the Desktop index.
- **The folder-name slug is lossy**: `Documents/tervek/vázlatok` →
  `…-tervek-v-zlatok`. The project therefore always comes from the `cwd` in
  the record, never from the folder name.
- **Every record in a subagent transcript carries the PARENT's `sessionId`.**
  Its identifier can only be the filename, otherwise it dissolves into the
  parent session.

## Claude Desktop

```
<appdata>/Claude/claude-code-sessions/<account>/<org>/local_*.json
```

**Index only**, no transcript: `title`, `cwd`, `model`, `completedTurns`,
`createdAt`, `lastActivityAt`, and a `cliSessionId` that points at the Claude
Code transcript.

This is the only place older sessions have a **human title** ("Komplex
workflow bemutató"), so the collector runs as enrichment: it never overwrites
an existing title. An entry with no local transcript is inserted as a
`turn_count = 0` row — better that the timeline says there was a conversation
than that it vanish without a trace.

There can be several accounts, and one "account" is a fake directory named
`skills-plugin`.

## Cowork (Claude Desktop local agent mode)

```
<appdata>/Claude/local-agent-mode-sessions/<account>/<org>/local_<sid>.json     meta
<appdata>/Claude/local-agent-mode-sessions/<account>/<org>/local_<sid>/
    .claude/projects/<vm-slug>/<cliSessionId>.jsonl                            transcript
    outputs/                                                                   products
```

The transcript format is **identical** to Claude Code's, so the same parser
reads it.

- **`cwd` is useless here**: a generated name inside the sandbox
  (`/sessions/happy-great-cray`). The project comes from
  `userSelectedFolders` — and a Cowork session may legitimately touch several
  projects, so each folder is recorded as evidence.
- The `outputs/` folder holds finished products (docx, pptx, research note)
  that exist nowhere else.
- The sandbox VM image (`vm_bundles/claudevm.bundle/sessiondata.vhdx`) has
  **no** usable data: the session folders exist, but emptied; the conversation
  is on the host.

## Codex

```
~/.codex/state_5.sqlite          threads, thread_spawn_edges
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

The `threads` table is the index, the rollout file is the text.

- **`created_at` and `updated_at` are in SECONDS**, every other source in
  milliseconds. Without conversion every Codex session would fall in 1970.
- **`title` is not a title on most rows**, but an embedded prompt (on the
  reference machine 739 of 917 are longer than 200 characters). A length gate
  is needed, and a fallback to the first line of the first user message.
- **`session_meta.payload.id` is the thread identifier; `session_id` on a
  subagent is the PARENT's.** Joining on the wrong field puts every subagent
  with the parent.
- `cwd` arrives in the `threads` table with a `\\?\` prefix, in
  `session_meta` without.
- The `source` field is either a literal (`exec`, `vscode`) or a JSON
  subagent descriptor (`parent_thread_id`, `agent_role`, `agent_nickname`).
- **`response_item` records are skipped**: they duplicate `event_msg`
  content and bring `developer`-role permission boilerplate.
- The `projects` and `project_roots` tables exist but are empty — a project
  list cannot be bootstrapped from them.

## Cursor

```
<appdata>/Cursor/User/globalStorage/state.vscdb     (7.6 GB on the reference machine)
<appdata>/Cursor/User/History/<hash>/entries.json
```

One SQLite, with `ItemTable` and `cursorDiskKV` tables.

| key | contents |
|---|---|
| `ItemTable['composer.composerHeaders']` | the conversation list: `composerId`, `name`, `createdAt`, `lastUpdatedAt` |
| `composerData:<cid>` | `fullConversationHeadersOnly` — ordered bubble list, `type` 1=user, 2=assistant |
| `bubbleId:<cid>:<bid>` | the message (`text`) |
| `ofsContent:<cid>:<uri>` | **the key carries the open file's URI**; the value is the whole file contents |
| `messageRequestContext:<cid>:<bid>` | request context |

**`LIKE 'prefix%'` falls back to a full index scan.** `key` is UNIQUE, so it
has a BINARY index, but SQLite only turns `LIKE` into a range search when
`case_sensitive_like=ON`. Live measurement, on the same composer:

```
LIKE  'bubbleId:<cid>:%'                       100.4 ms   SCAN
key >= 'bubbleId:<cid>:' AND key < 'bubbleId:<cid>;'   0.0 ms   SEARCH
```

There is a sentinel test that requires `SEARCH` via `EXPLAIN QUERY PLAN`.

Further notes:

- **Conversations have no working directory.** The project comes from file
  paths: `ofsContent` keys (strong), bubble contents (strong), finally file
  history time correlation (medium/weak).
- **Many conversations have no `lastUpdatedAt`** (background and cloud-agent
  threads). For these the sha256 of `composerData` is the change signal —
  but only for these, because editing a bubble does not touch `composerData`.
- Some conversations have no `composerData` row either; these are inserted as
  empty sessions.
- **Bubbles carry no timestamp.** The hub does not invent one per turn; the
  chunk timestamp falls back to the session start.
- The `.backup` file (4.1 GB on the reference machine) is never opened.
- The URI in an `ofsContent` key is percent-encoded: without
  `decodeURIComponent` the `d%3a` fails the drive-letter check.

### Cursor file history

`User/History/<hash>/entries.json` — `resource` is the absolute URI of the
edited file, `entries[]` the save timestamps. On the reference machine 6,076
folders, 34,567 events. This is the only signal for those Cursor threads that
mention no path at all.
