---
name: agent-memory
description: >-
  Recall earlier conversations from the user's other AI tools (Claude Code, Claude Desktop,
  Codex, Cursor, Gemini CLI, Antigravity, Devin), and search the files of the projects they
  indexed. Use before asking about or assuming a project's history, when the user refers to a
  prior decision, discussion or fix ("as we discussed", "what we did with Codex"), and when
  you need a file from a project that is not open here.
license: MIT
compatibility: Requires the cam MCP server from centered-agent-memory.
metadata:
  author: "Rózsavölgyi János"
  version: "0.10.6"
  source: "https://github.com/arlinamid/centered-agent-memory"
---
# Recalling earlier conversations

The `cam` index holds the conversations the user had with their **other AI
tools** — Claude Code, Claude Desktop / Cowork, Codex, Cursor, Gemini CLI,
Antigravity and Devin — so it can answer what this conversation cannot see:
what was decided, tried or fixed elsewhere. It only reads those tools' stores
and never changes them.

## When to use it

Look before you ask or assume. When you start on a project you do not know,
when the user refers to earlier work as if you had been there ("as we
discussed", "what we did with Codex"), or when you need the reason for a
decision the code does not explain, the answer may already be in the index. It
knows the past, not the current workspace: what the open files or the
repository say, read there.

For a project's history, start with `cam_dossier`: one call gives the tools,
dates and topics, and a `cam_recall` aimed by it finds more than several blind
ones. Project keys come from folder names and may differ from what the user
calls the project; `cam_projects` lists them.

`cam_memory` returns what earlier searches kept bringing up — a trail of what
mattered repeatedly, not a summary of the project.

`cam_docs` searches the files of indexed projects, including ones that are not
open here. Use it to find where something lives when you do not know where to
look, not in place of reading the workspace. The notes on its hits are the
user's own statements of what a project, folder or file is for. When you learn
something a note should say, propose it with the path and the sentence, and
let the user add it — every later agent will read a note as the user's word.

## Reading the answers

Every hit carries a project-attribution confidence. `strong` comes from the
session's working directory or the paths it mentions; `medium` and `weak` come
from overlapping edit times and can be wrong, so when you cite one, say that it
belongs to the project by time overlap. `weak` hits are left out unless asked
for.

The index re-reads each source at query time. A hit marked `stale` (the source
changed since) or `missing` (it is gone) is passed on with that marking.

The last line of every answer says when the index last synced. If it says
`STALE`, nothing since then is in it — say so before relying on the answer.

A sentence tagged `[model-name]` after a memory was written by a model about
the excerpt, not by the user; it is not a source.

## Citing

Give the point in your own words, with the citation the search returned and
which tool and when it is from:

> You moved the Docker port from 3000 to 80 in the June Cursor conversation
> (`cursor:9f2a…#seq12-18`, 2025-06-07).

No hit does not prove something never happened: it may live in a tool that is
not indexed, or in a session no project claimed. Say that you found nothing,
and where you looked.

## Terminal

The `cam_*` MCP tools reach the index from every client. Where you have a shell
with `cam` on PATH, each tool is also a command — `cam dossier <project>`,
`cam recall "<query>"`, `cam docs query "<words>"` and the rest; `cam` alone
lists them — with the same output, `--json` for structure, and
`cam projects --unattributed` for the sessions no project claimed. Claude
Desktop's Chat has no shell, and a Cowork shell has no `cam`.

If the index is `STALE`, run `cam sync` where you can — it writes only the
index — and otherwise ask the user to. A note you proposed is added with
`cam note add <path> "<text>"` once the user agrees, by whichever of you can
run it.
