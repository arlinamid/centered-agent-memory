# Recalling earlier conversations

The `cam` index holds conversations the user had with their **other AI tools**:
Claude Code, Claude Desktop / Cowork, Codex and Cursor. It is read-only and
does not modify any of those stores.

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
   recent topics. One call, and you know what happened so far.
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

{{SURFACE}}
