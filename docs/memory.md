# Memory layer

The hub indexes conversations and promotes repeatedly retrieved excerpts.
Consolidation works without a model; semantic retrieval and dreaming are optional.

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

Recall scores now measure the fraction of distinct query terms present in the
source, with cosine similarity also considered when embeddings are enabled.
BM25 breaks ranking ties; its corpus-dependent magnitude is no longer treated
as a relevance probability. Full-query candidates are retrieved alongside OR
candidates, attribution is filtered before limiting, and heavily overlapping
results are suppressed. Two-letter identifiers such as UI and DB are searchable.

Three questions on three days can pass on a small corpus using actual search
scores; the integration tests no longer substitute high scores to force a
promotion. Stale and missing sources remain visible but add no recall evidence.
Earlier stored scores are retained; this change applies to new recalls.

These are retrieval signals, not confirmation that a result was useful or that
its contents are true. Promotion still requires previous searches: an important
decision that nobody has recalled does not automatically become a memory.

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
cam memory embed [--dry-run] [--force] [--project p]       # optional vector index
```

From MCP the same thing with the `cam_memory` tool: without `id` a list, with
`id` one memory with the evidence, with `topics: true` the topics.

The output of `cam memory show` includes all six components of the score and,
row by row, the evidence: which question, how many times, from when to when.
A promotion never appears without a way to see what justified it.

## The relevance layer (qmd)

`cam` bundles [qmd](https://github.com/tobi/qmd) and uses it as a **model
runtime**, not as a second index. Nothing about a conversation is written into
qmd's store: the hub keeps its own chunks, attribution and citations, and
borrows three local models.

| stage | model | what it does |
|---|---|---|
| expansion | `qmd-query-expansion-1.7B-q4_k_m` | turns one question into typed sub-queries (`lex`/`vec`/`hyde`) |
| embedding | `embeddinggemma-300M-Q8_0` | vectors for chunks and for the question |
| reranking | `Qwen3-Reranker-0.6B-Q8_0` | scores each retrieved passage against the question |

The order is: widen, retrieve with everything, then cut. Reranking is where the
de-noising happens — a passage the model scores below `minRerankScore` is
**dropped**, not demoted, because a tool-call dump at position nine is still in
a ten-hit answer.

Everything runs on the machine. Weights are downloaded on first use into
qmd's model cache (`XDG_CACHE_HOME/qmd/models`, or `~/.cache/qmd/models` — on
Windows too; qmd does not use `LOCALAPPDATA`), and the qmd index at
`<cache>/qmd/index.sqlite` is reused so the expansion and rerank caches survive
between runs. `cacheHome` moves both when the home drive has no room for two
gigabytes of weights.

### What it costs

Measured on one Windows machine, Vulkan GPU, uncached query:

| stage | CPU | GPU |
|---|---|---|
| expansion | ~197 s | ~74 s |
| reranking | ~83 s | ~8 s warm, ~22 s cold |
| embedding | ~45 s | ~0.2 s warm, ~15 s cold |

Three things follow, and they are the defaults:

- **`expand` is off.** A minute and a half to phrase the question three more
  ways is not a trade a search should make by itself.
- **`gpu` is `"auto"`.** CPU is not a slower option here, it is not an option.
- **Only the top 10 candidates are reranked, as ~500-character excerpts.** The
  cost scales with the text handed over, not the number of candidates: 24 chunks
  at 2000 characters took 14 s, the same 24 at 600 took 5 s. An answer shows ten
  hits, so judging the sixtieth was never going to matter.

Loading a model takes about a minute, in native code that blocks the event loop
— no timeout can interrupt it. So the two surfaces behave differently, on
purpose:

- **The MCP server does not load models unless told to.** `warmUp: true` makes
  it load the reranker at startup, paying a ~60 s freeze once — during which it
  answers nothing at all, not even the tool listing a client asks for on
  connect. Off (the default) it answers immediately without the relevance model
  and says so, and `cam_docs` falls back to keyword search for the same reason.
- **The CLI waits, without a deadline.** A one-shot command has no next
  question: if it will not wait, it never reranks at all. So `cam recall` does
  rerank — at the cost of loading the model on every run.

The honest summary: reranking is cheap once a model is loaded and expensive to
load, and nothing in-process can make that load interruptible. Running qmd as a
separate daemon (`qmd mcp --http`) would move the load out of cam's process
entirely; until then, the CLI is where reranking is practical, and the MCP
server either accepts one startup freeze or answers without it.

```json
{
  "memory": {
    "qmd": {
      "enabled": true,
      "cacheHome": "D:\.cache",
      "gpu": "auto",
      "expand": false,
      "rerank": true,
      "minRerankScore": 0.3,
      "deadlineMs": 45000,
      "warmUp": false,
      "denoise": true
    },
    "embedding": { "provider": "qmd" }
  }
}
```

Every stage degrades on its own and says so. A missing model costs precision,
never recall: expansion failing costs breadth, embedding failing costs semantic
matches, reranking failing leaves the keyword order — and each prints a warning
rather than an empty answer. Each stage also gets **its own share** of
`deadlineMs` rather than drawing from one pot in order: a slow embedding command
would otherwise spend the whole budget and switch reranking off silently, which
is the one stage the layer exists for. `CAM_QMD=0` turns the whole layer off for
one run, `"enabled": false` for good. Reranking is skipped when only one hit was found;
and if the model rejects *everything*, the best retrieval hit is kept, so a
mis-scoring model can never turn an answer into silence.

`cam doctor` reports which of the three models are cached and which rendering
the hub holds.

### Turn de-noising

With `denoise` on (the default), a turn is cleaned as it is rendered into chunk
text: tool-call blocks, long diffs, pasted files and injected boilerplate are
replaced with counted markers like `[42 lines elided]`. The elision is always
visible — a citation has to mean what it says.

This changes what is indexed, so it is versioned. `meta.render_version` records
which rendering produced a hub's `chunks.text_sha256`, and **both** the chunker
and the hydrator read it, because the hash is written by one and recomputed by
the other. Switching renderings is `cam rebuild`'s job: it re-renders, rewrites
the hashes of chunks that read back cleanly, and leaves a drifted or missing
source alone so the drift signal is not overwritten. Vectors invalidate
themselves afterwards, so follow it with `cam memory embed`.

An existing hub keeps the raw rendering until you rebuild. A fresh one starts
denoised.

## A project's own files, and notes on them

Conversations live in the hub; a project's **files** go into qmd's index, which
is the one place cam writes documents rather than locators. They are already on
disk and already the user's, and qmd chunks `.ts`, `.tsx`, `.js`, `.py`, `.go`
and `.rs` by syntax rather than by line, so a hit lands on a function instead of
halfway through one.

```bash
cam docs add [path] [--project p]      # a collection over the project's files
cam docs index                         # read them and embed them
cam docs query "where is X decided"    # search them
cam docs get <path|#docid>             # one file's text
cam note add src/qmd/runtime.ts "Borrows qmd's models; writes nothing into qmd."
cam note list
```

A **note** is qmd's `context` for a path: a sentence about what a file or folder
is for. The search reads it alongside the file and every hit carries it, because
it is the part a codebase cannot state about itself — why this module exists,
what not to touch. The most specific note wins, so a note on `src/qmd/` describes
the folder and one on `src/qmd/runtime.ts` overrides it for that file.

The default pattern covers code and prose alike; `node_modules`, `dist`, lock
files and other generated trees are excluded, because burying a project's own
files under a hundred thousand someone else wrote is the opposite of the point.

Agents reach the same thing through the `cam_docs` MCP tool (`query`, `get`,
`notes`).

## Optional embeddings without qmd

The `command` provider remains, for a model of your own. Configure a command
that runs it; the hub does not bundle or download anything for this path:

```json
{
  "memory": {
    "embedding": {
      "provider": "command",
      "model": "your-embedding-model-version",
      "command": ["path/to/embedding-adapter"],
      "timeoutMs": 120000,
      "maxInputChars": 8000,
      "minSimilarity": 0.5
    }
  }
}
```

The command reads one JSON object from stdin:
`{"model":"your-embedding-model-version","input":["text to embed"]}`.
It must write only `{"embeddings":[[0.1,0.2,0.3]]}` to stdout, with the actual
model vector replacing those example numbers. Diagnostics belong on stderr.
Use the same vector space for documents and queries; give changed model weights,
dimensions, or preprocessing a new model identifier.

`cam memory embed --dry-run` reports the planned text volume without starting the
command. `cam memory embed --limit 100` embeds uncached chunks; repeat to drain
the backlog. Successful items are cached and failed items can be retried.
`--force` regenerates cached vectors, including after changing `maxInputChars`.
The source excerpt sent to the model is capped at that character limit.

Once configured and indexed, both `cam recall` and MCP `cam_recall` also embed
the query and combine semantic candidates with lexical candidates. With
`provider: "command"` this means query text is handed to the configured command
on each search; whether the command uses a network service is determined by
your adapter. With `provider: "qmd"` it does not leave the machine. Generation of
document embeddings happens only through the explicit `memory embed` command.
Provider failures report a warning and fall back to keyword retrieval.

Vectors are normalized and validated. Model, dimension, source hash, project,
tool, date, and attribution checks apply before returning semantic results.
Content changes invalidate embeddings, dreams, and promotion evidence for that
chunk. Legacy vectors without a source hash are regenerated. Search uses an
exact scan over eligible vectors, so query cost grows with corpus size; it is
not an approximate nearest-neighbor index. Similarity thresholds and model
quality need evaluation on representative Hungarian and English queries.

## Why consolidation does not require a model

A generative summary would be optional and retryable — but that is not the
core. The reason is measurable: Codex's own, LLM-dependent memory pipeline
failed on this machine on 17 of 58 jobs with a context-window error, and has
produced nothing since July. What is deterministic runs every morning.

## The dream phase (optional)

Alongside optional embeddings, this is a model-assisted operation. What determinism
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

The batch limit counts uncached work. Cached high-scoring memories do not block
later memories, and the planner pages beyond the first 200 facts. Only current,
readable sources are sent; digests are hidden when a source becomes stale or
missing. Prompts ask for concrete decisions, preferences, constraints and open
questions, and distinguish proposals from settled decisions. This remains a
per-excerpt digest, not cross-session synthesis or contradiction resolution.

`test/memory-pipeline.test.ts` exercises retrieval, promotion and dreaming
without score overrides, plus vector generation, caching, filtering, fallback,
and source invalidation. Its deterministic providers verify pipeline behavior;
they do not measure the semantic quality of a real embedding or dream model.
