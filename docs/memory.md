# Memory layer

The hub does not only find the past, it also learns from it. Without a model.

The basic idea: **a memory becomes long-term not because it looks important,
but because it came back several times, on several days, to several different
questions.** This needs no summary and no network — only that the trace of the
searches is there from the first day.

## What the trace is

Every `cam recall` (and every `cam_recall` MCP call) records what it brought
up:

| table | what is in it |
|---|---|
| `recall_events` | which chunk, for which question (hash), at what score, when |
| `memory_queries` | the question text itself, with the words parsed out of it |

The question **text** is needed because the evidence behind a promotion has to
be showable: "these three questions brought it up, on these days" — a hash
cannot be read. If you do not want this, `recall` with `logQuery: false` writes
only the hash; the mechanism still works, only the evidence has a hash where
the question would be.

## The three passes

`cam memory consolidate` runs all three in one go. Deterministic and offline.

**Light** — the raw recall events folded per chunk: how many times it came up,
on how many different questions, on how many separate days, at what average
hit score. The `memory_traces` table is always recomputable from
`recall_events`, it does not accumulate.

**REM** — which words come back in *different* questions. This is the
deterministic counterpart of a "recurring topic": the words are the ones the
search already parsed, there is no summarising and nothing invented. At least
two different questions are required. (`memory_topics`, `cam memory topics`)

**Deep** — scoring, gates, promotion, budget. What passes becomes a long-term
memory as a `memory_facts` row.

## The score

| component | weight | what it measures |
|---|---|---|
| relevance | 0.30 | how well it fitted, the average of the hit scores |
| frequency | 0.24 | how many times it came up (saturates around 10) |
| diversity | 0.15 | how many different questions reached it (saturates around 5) |
| recency | 0.15 | when it was last needed — 14-day half-life |
| consolidation | 0.10 | on how many *separate days* it came up (saturates at 3) |
| conceptual | 0.06 | how many kinds of word led to it (saturates at 8) |

The counters saturate logarithmically: the tenth recall is worth less than the
second — a single very active excerpt thus cannot push everything else out.

**Gates** (alongside the score, not instead of it): at least 3 recalls, at
least 3 **different** questions, and a score of at least 0.8. The gate cannot
be bought with a high score: something one question recalled nine times is not
a memory.

This is strict. In practice this is the smallest passing trace: **three
questions, on three days, with a good hit score** (0.834). On the reference
machine the real hit score is 0.90–0.93 — on a small corpus bm25 does not
spread, so the tests work with the measured real value rather than one
measured on a fixture.

## Forgetting

From two directions:

- **Recency fades.** The same trace, with a recency term that halves every 14
  days, eventually slips under 0.8, and the promotion is withdrawn. The *trace*
  remains — a single further recall brings it back.
- **Budget.** By default 200,000 characters of promoted material fit
  (`--budget`). If it does not fit, the **oldest promotions** drop first.

The age of a promotion (`promoted_ms`) comes from the trace — from when you
first recalled it — not from the clock. Without this a dropped, then
re-promoted memory would jump to the front of the queue, and every run would
give a different result. This way **running twice from the same database
produces the same outcome.**

## Not a copy

A promoted memory **stores no text**: a chunk reference, and the text comes
back from the source on read, the same way a search hit's does. If the source
has since vanished, the memory prints this. The "reference, not a copy"
invariant does not break on the memory layer either; the character budget
counts the chunk's measured length.

## Commands

```bash
cam memory consolidate [--budget N] [--min-score 0..1]   # the full pass
cam memory list [--project p] [--limit N] [--json]       # the promoted memories
cam memory show <id>                                     # one memory + evidence
cam memory topics                                        # recurring topics
cam memory status                                        # how much trace has been collected
cam memory dream [--dry-run] [--force] [--project p]     # a summary with a model (optional)
cam memory dream forget                                  # drop every dream
```

From MCP the same thing with the `cam_memory` tool: without `id` a list, with
`id` one memory with the evidence, with `topics: true` the topics.

The output of `cam memory show` includes all six components of the score and,
row by row, the evidence: which question, how many times, from when to when.
A promotion never appears without a way to see what justified it.

## Why not a model

A generative summary would be optional and retryable — but that is not the
core. The reason is measurable: Codex's own, LLM-dependent memory pipeline
failed on this machine on 17 of 58 jobs with a context-window error, and has
produced nothing since July. What is deterministic runs every morning.

## The dream phase (optional)

The only place a model gets anywhere near the text at all. What determinism
cannot give is a sentence about what a recalled excerpt **is about**;
`cam memory dream` writes that. It does not promote, does not demote, and
touches no evidence table — promotion is still decided by the trace, not by
opinion.

Three rules make it acceptable:

1. **Off by default, and `consolidate` never calls it.** Only an explicit
   `cam memory dream` sends anything out.
2. **The model is configuration, not code.** Any command that reads a prompt
   and writes text will do, so changing models is not a compile:

```json
{ "memory": { "dream": { "provider": "command", "model": "gpt-5",
    "command": ["codex", "exec", "--model", "{model}", "-"] } } }
```

   The prompt goes to stdin, unless the command contains `{prompt}` or
   `{promptFile}`.
3. **The output is derived text.** Cached by the hash of the input (you do not
   pay twice for the same thing), labelled with the model name, stored apart
   from the sources — and droppable at any time: `cam memory dream forget`.

What would leave, the command **says before it leaves**: how many memories,
how many characters, to which model. This line appears even with `--quiet`,
because it is not a progress indicator but a disclosure. `--dry-run` prints
the same, plus the first prompt verbatim, and starts nothing.

A failing model does not take the run with it: every error is recorded per
memory, the command exits non-zero, and it can be retried tomorrow. The dream
sentence appears everywhere together with the model name — neither
`cam memory list` nor `cam_memory` can return generated text in a way that
looks like a source.
