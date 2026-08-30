# The sources

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

## Gemini CLI

```
~/.gemini/tmp/<project>/chats/session-*.json
~/.gemini/tmp/<project>/.project_root
```

One whole JSON document per session, not JSONL: `sessionId`, `startTime`,
`lastUpdated`, `kind` (`main` | `subagent` | absent) and `messages[]`.

- **The project directory name cannot be turned back into a path.** Most are a
  bare folder name (`scripts`), which matches any number of directories; the
  rest are a hash — and `projectHash` is **not** the SHA-256 of the working
  directory. Every path in `~/.gemini/projects.json` was hashed in every case
  and separator variant against the hash-named directories: nothing matched.
  So the working directory comes from `.project_root` beside the chats, and a
  project without one stays unattributed. On the reference machine that is 11
  directories of 13, covering 157 chat files of 159.
- **`projectHash` inside a file need not match the directory holding it.** A
  subagent session carries its own hash while living in the parent's folder,
  which is another reason attribution uses the directory, not the field.
- **The two roles are `user` and `gemini`, and their shapes differ.** A `user`
  message always holds an array of `{text}` blocks; a `gemini` message always
  holds a plain string. Measured over 159 files: 193 `user:array`, 359
  `gemini:string`, no exceptions.
- **`info` and `error` are the CLI talking to itself** — extension-update
  notices, quota refusals — and are not indexed. Neither are a `gemini`
  record's `thoughts` and `toolCalls`.
- **A session is rewritten in place as it grows**, so half a document does not
  parse: a changed file is re-read whole. `classifyFile` still earns its keep,
  because an unchanged one costs zero reads.
- **Gemini records that a session IS a subagent, never whose it is.** The link
  is left open rather than inferred from timing.
- `logs.json` beside the chats holds the same user messages and is not read
  separately: `chats/*.json` is its superset.

## Antigravity

```
~/.gemini/antigravity-cli/conversation_summaries.db     (SQLite)
~/.gemini/antigravity-cli/history.jsonl
~/.gemini/antigravity{,-ide}/brain/<uuid>/*.md
~/.gemini/antigravity{,-ide}/conversations/*.pb         (encrypted, not read)
```

**The conversations themselves are encrypted, not merely schemaless.** Measured
over a 64 KiB window, `conversations/*.pb` and `implicit/*.pb` carry
**7.997–7.998 bits of entropy per byte** with no readable header, while the
plain protobuf next to them (`user_settings.pb`) measures 3.6 and reads as
protobuf. So the bodies are not in the index, and the collector says so rather
than reporting an empty store. What is indexed is what Antigravity records
*about* its conversations:

- `conversation_summaries.db` — one row per conversation. **`title` is empty in
  every row** on the reference machine; `preview` is the generated one-line
  summary the UI shows, so that is the title. No turns.
- `history.jsonl` — the prompts the user typed, with a `workspace` and usually
  a `conversationId`. This is the only readable record of what was said. A line
  without a `conversationId` (the first prompt of a session, and every slash
  command) belongs to no conversation we could attach it to, and is skipped
  rather than filed under a guess.
- `brain/<uuid>/*.md` — `task.md` and `implementation_plan.md`, the agent's own
  plan documents, in a git repository. Only `.md`: the same directories hold
  thousands of screenshots and a `.resolved.N` history of every document.
  On the reference machine, 480 documents and 1.6 MB of text.

Traps:

- **`last_user_input_time` is `0001-01-01 00:00:00+00:00` in every row** — the
  .NET default for "never". `Date.parse` accepts it and returns **the year
  2001**, so stored as-is every conversation would claim to have happened
  twenty-five years before it did. Anything before 2020 is treated as absent.
- **`workspace_uris` is a JSON array of percent-encoded file URIs**
  (`["file:///d%3A/tool/demo"]`). It is the only direct project signal the
  store has — there is no working-directory column — so it is a strong origin
  in the attribution cascade. Filled in 100 rows of 104.
- **Three directories, one data set.** `antigravity/` (IDE), `antigravity-ide/`
  and `antigravity-cli/` hold the same conversation ids; the `.pb` files in the
  first two differ by a couple of dozen bytes. Everything is keyed by
  conversation id and deduplicated.
- `~/.gemini/antigravity/mcp_config.json` is a **symlink** to
  `~/.gemini/config/mcp_config.json`, which `config/.migrated` records as the
  canonical location. The installer writes the target, not the link.

## Devin CLI

```
<appdata>/devin/cli/sessions.db     (SQLite, WAL)
```

`sessions` gives `working_directory` — a real working directory, so attribution
is direct and strong — plus `title`, `model`, and epoch **seconds** for
`created_at` / `last_activity_at`. `message_nodes.chat_message` is a JSON
string: `{message_id, role, content, metadata}`, with `content` always a plain
string.

- **The store is a forest, not a transcript.** Every retry and edited prompt
  forks a branch, and all of them stay in `message_nodes`. Reading the table
  would index one question four times over (measured: 4 `user` nodes for 1 row
  in `prompt_history`). `sessions.main_chain_id` names the leaf of the
  conversation as it stands; walking its parents is the only reading that
  matches what the user would see — 16 nodes of 37 on the reference machine.
- **A shortened chain has to shorten the session.** Reverting drops turns, so
  the session is rebuilt on every change rather than appended to.
- `system` records are the injected environment: the working-directory dump and
  an always-on rules block that inlines the user's own instruction files. `tool`
  records are tool results. Neither is speech; both would put the same text into
  the index once per session.
- **An assistant node can hold an empty string** while a tool call runs.
- **Most of the store lives in the WAL** (1.9 MB of WAL against a 4 KB database
  file). The fixture is built in WAL mode for that reason.
- `transcripts/*.json` (`ATIF-v1.7`) appears only when the user exports, and is
  a subset of what `sessions.db` already holds. Not read.

## Windsurf — known, and not indexable

```
~/.codeium/windsurf/cascade/*.pb
```

Cascade conversations are stored the same encrypted way as Antigravity's, and
**there is no summaries database beside them** — so unlike Antigravity there is
not even a metadata layer to attribute or title from. Nothing would be honest
to index, so there is no Windsurf collector.

The Devin desktop app is a Windsurf fork and uses this same store (its
`state.vscdb` is full of `windsurf*` keys); the Devin **CLI** is a separate,
readable store and is indexed. If the key handling ever lands for Antigravity,
the same module would cover Windsurf with a different key name.

### Antigravity conversation bodies, on demand

The encrypted `.pb` files can be read after all — not by decrypting them, but by
asking the component that already can. Antigravity runs a language server that
answers a Connect-RPC service over plain HTTP on localhost, and that daemon
decrypts its own store.

This is **not** part of `cam sync`. It runs only when somebody asks for one
conversation by name (`cam get antigravity:<id>`, or `cam_get` over MCP), and
what it fetches is kept, so asking twice costs one call.

```
POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory
x-codeium-csrf-token: <token>
{"cascadeId": "<conversation id>"}
```

Everything below was measured, and each line is a wrong answer that looked
right:

- **The header is `x-codeium-csrf-token`.** Antigravity is a Codeium fork and
  kept the vendor prefix. With `x-csrf-token`, `x-csrf` or `csrf-token` the
  daemon answers `401 {"code":"unauthenticated","message":"missing CSRF token"}`
  — which reads like a wrong token rather than a wrong header name.
- **The token is `--csrf_token` from the daemon's command line**, and not the
  `--extension_server_csrf_token` sitting beside it, which guards a different
  service. Matching the flag by substring picks whichever comes first.
- **The port does not come from the log.** `language_server.log` recorded
  49361/49362 while the live process was listening on 55026/55027. It comes
  from the process's own listening sockets: `Get-NetTCPConnection` on Windows,
  `ss -ltnp` then `lsof` on Linux (`ss` is what a current distribution ships;
  neither is guaranteed), `lsof` on macOS. An empty answer is treated as
  "Antigravity is not running".
- **There are two ports and one is useless.** The lower is HTTPS/gRPC and
  answers `Client sent an HTTP request to an HTTPS server.`; the higher is the
  plain HTTP one. The reader probes rather than trusting the order.
- **`GetAllCascadeTrajectories` returns `{}`.** In proto3 JSON an empty
  repeated field is omitted, so there is no listing to page through: the
  conversation ids come from `conversation_summaries.db`, which is also where
  change detection comes from.
- **A daemon only knows its own surface.** Asking the IDE's language server for
  a conversation created by the CLI answers
  `{"code":"unknown","message":"trajectory not found"}`.
- **We cannot start a daemon, and do not try.** With Antigravity closed,
  `agy agentapi` only prints its subcommand list, and
  `agy agentapi get-conversation-metadata <id>` exits 1 with
  `{"error":"ANTIGRAVITY_LS_ADDRESS is not set"}` — it is a client of a daemon,
  not a way to start one. Running `language_server.exe` directly would mean
  inventing the argument set of an undocumented binary, and starting a real
  `agy` session would mean making a billed model call to read local data. So
  when Antigravity is closed the answer is to say so.

**What comes back, and what is kept.** A trajectory is a step log, not a
transcript: 523 steps carried 46 turns in the measured conversation. The census
of one such trajectory:

```
167  PLANNER_RESPONSE   158  EPHEMERAL_MESSAGE   58  VIEW_FILE   29  CODE_ACTION
 23  RUN_COMMAND         23  GREP_SEARCH         13  COMMAND_STATUS
 12  USER_INPUT          11  ERROR_MESSAGE        6  CONVERSATION_HISTORY
  6  KNOWLEDGE_ARTIFACTS  6  LIST_DIRECTORY       6  CHECKPOINT
  3  BROWSER_SUBAGENT     2  SEND_COMMAND_INPUT   …  NOTIFY_USER
```

Three fields are speech, and the trap is `PLANNER_RESPONSE`:

| Step | Field taken |
|---|---|
| `USER_INPUT` | `userInput.items[*].text`, falling back to `userResponse` |
| `NOTIFY_USER` | `notifyUser.notificationContent` |
| `PLANNER_RESPONSE` | `plannerResponse.response` **only** |

Most planner steps are the model thinking: `thinking`, `toolCalls[]` and a
base64 `thinkingSignature` — the same shape excluded from Claude Code
transcripts. But *some* also carry `response`, the sentence the user reads. A
sample of the three largest planner steps in one conversation had none of them,
which is exactly how that field gets missed: taking the step whole would index
the reasoning, and skipping it whole loses half the conversation. Reading only
`response` cost the difference between 12 turns and 46 from the same 523 steps.

**Turns are stored inline.** The plaintext exists nowhere on disk — the store
holds it encrypted — so there is no file and byte offset to record. This is the
same exception the volatile scratchpads already use, and it means a fetched
conversation stays readable, and searchable, after Antigravity is closed again.

**Nothing is fetched twice.** The summaries row's `last_modified_time` and
`step_count` are the version; while it has not moved, the kept copy is current
and no call is made. When it has, the conversation is re-fetched and its turns
are **replaced**, because a conversation that continued has new steps and
appending would double what came before them.
