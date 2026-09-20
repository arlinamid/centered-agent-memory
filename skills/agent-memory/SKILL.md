---
name: agent-memory
description: >-
  Recall earlier conversations from the user's other AI tools (Claude Code, Claude Desktop,
  Codex, Cursor, Gemini CLI, Antigravity, Devin). Use before asking about or assuming a
  project's history, and when the user refers to a prior decision, discussion or fix: "as we
  discussed", "the earlier one", "what we did with Codex".
---
# Recalling earlier conversations

The `cam` index holds conversations the user had with their **other AI tools**:
Claude Code, Claude Desktop / Cowork, Codex, Cursor, Gemini CLI, Antigravity
and Devin. It is read-only and does not modify any of those stores.

In this conversation you cannot see what the user did yesterday in another
tool. The index can. That is the difference between "I don't know, let's ask"
and "I'll look it up".

## When to use it

**Before** asking or assuming:

- Starting work in an unfamiliar project → `dossier` before claiming anything
  about it.
- The user refers to something as if you already know: "as we discussed",
  "the earlier fix", "what we did with Codex" → `recall` their words.
- You are about to ask "have we done this" or "why is it this way" → look first.
- You need the reason for a decision and it is not in the code → `recall`,
  then `get` the hit.

Do not use it when the answer is in the open files or the repository. The
index knows about the **past**, not the current workspace.

## Workflow

1. **`projects`** — which project keys the index knows. The key comes from a
   folder name and is not necessarily what you call the project.
2. **`dossier <project>`** — per-tool counts, date range, largest sessions,
   recent topics. One call, and you know what happened so far. Give it
   `focus` and the lists come back ordered by relevance to that topic
   instead of by size.
3. **`recall "<query>"`** — full-text search. Accent-insensitive
   (`arvizturo` finds `árvíztűrő`); words longer than 5 letters match as a
   prefix, so inflection is not a barrier. Narrow with `project` when you
   know which project it is.
4. **`get <citation>`** — the full text of a hit. `recall` returns a
   `tool:sessionId#seqN-M` citation; pass it back unchanged.
5. **`timeline <project>`** — chronological order, when you care about when
   something happened rather than what was said.

`memory` is a different thing: it returns what **your earlier searches**
brought up more than once, across days and questions, with the promotion
evidence. It is a trail, not a summary.

## What recall actually does

The question is widened into several sub-queries, the index is searched with
all of them, and what comes back is then scored by a relevance model — all on
this machine, nothing leaves it. Passages the model rejects are **dropped**,
not pushed down the list.

So read a short answer correctly: **few hits means few relevant hits.** It is
not evidence that the index is empty or that the search was too narrow, and
saying so would be wrong. If you need to see everything that merely matched
the words, ask again with `rerank: false`; to loosen the threshold instead,
lower `minScore`.

Reranking is skipped when there is only one hit — nothing to choose between —
so a single result has no relevance score. If the answer says the relevance
model is **still loading**, the hits are keyword-ordered: ask again in a moment
for the scored version, rather than treating that list as final.

## The project's own files

`docs` is a different index from `recall`: the files on disk now, not what was
said about them. It covers code as well as prose — `.ts`, `.tsx`, `.js`, `.py`
and the rest, chunked by syntax, so a hit lands on a function.

Every file hit may carry a **note**: one sentence about what that path is for,
written by the user. Read it — it is the part the code cannot state about
itself, and it is often the answer to "why is this here". A note on a folder
applies to everything under it unless a file has its own.

Use `docs` for "where is X implemented" and `recall` for "why did we do X".
They answer different questions, and reaching for the wrong one wastes a turn.

## How to read the answers

**Confidence.** Every hit carries a project-attribution strength: `strong`
(from the session working directory or paths mentioned in the conversation),
`medium` (from overlapping file-edit times), `weak` (the same, thin evidence,
filtered by default), `none`. `medium` and `weak` can be wrong — if you cite
one, say it belongs to the project by time overlap.

**Source state.** The index stores locators, not copies, and re-reads the text
at query time. If the source has changed (`stale`) or vanished (`missing`),
the answer says so. Do not pass it on as unchanged.

**Index age.** The last line of every answer says when the index last synced.
If it says `STALE`, conversations since then are **not in it**. Tell the user,
and suggest `cam sync` — do not quote old data as current.

**Relevance.** A hit may carry a `relevance` score: the local model's verdict
on whether the passage answers the question. It says nothing about whether the
passage is *true* or about which project it belongs to — that is what
confidence and availability are for.

**Generated sentence.** If a memory is followed by a sentence tagged
`[model-name]`, a model wrote that about the excerpt; the user did not say it.
Do not quote it as a source.

## Citation

Always include the citation the search returned, and say which tool and when
it is from:

> You moved the Docker port from 3000 to 80 in the June Cursor conversation
> (`cursor:9f2a…#seq12-18`, 2025-06-07).

If there is no hit, say so. An empty index does not prove the thing never
happened — it may live in a tool that is not indexed, or the session may have
no project (`projects --unattributed`).

## What not to do

- **Do not write.** There is no write operation, and the source stores must
  not be modified.
- **Do not search at random.** One `dossier` says more than three blind
  `recall`s.
- **Do not dump old conversations into the reply.** Cite, and write the point.
- **Do not assume the user remembers.** If you quote the past, say where
  from.

## This surface

The `cam_*` MCP tools are also available from the terminal if `cam` is on PATH:
`cam projects`, `cam dossier <project>`, `cam recall "<query>"`, `cam get <citation>`,
`cam timeline <project>`, `cam memory list`. Each accepts `--json`. Rendering is shared,
so you get the same text as from the tools.

The relevance layer has flags there too: `cam recall "<query>" --no-rerank` for the raw
match set, `--min-score 0..1` for the threshold, and `cam dossier <project> --focus "<topic>"`
for a dossier ordered by relevance. `cam doctor` says whether the local models are cached.

File collections are managed from the terminal only: `cam docs add [path]`, `cam docs index`,
`cam docs query "<q>"`, and `cam note add <path> "<what it is for>"`. If nothing is indexed
yet, say so rather than concluding the project has no such file.

If the index is stale, `cam sync` refreshes it. That is the only write, and it writes
only the index.
