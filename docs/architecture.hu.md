# Felépítés

```
források (read-only)                →  kollektorok / get  →  index (SQLite)  →  lekérdezés  →  CLI / MCP
~/.claude/projects/*.jsonl              claude-code          sources            recall
~/.codex/state_5.sqlite                 codex                sessions           timeline
<appdata>/Cursor/state.vscdb            cursor               turns (locator     dossier
<appdata>/Claude/…                      cowork, desktop            vagy inline)
~/.gemini/tmp/…                         gemini-cli           chunks + FTS5
~/.gemini/antigravity*/                 antigravity          path_evidence
<appdata>/devin/cli/sessions.db         devin-cli            attribution
~/.codeium/windsurf/cascade/*.pb        devin-cascade        artifacts
                                        + RPC a `cam get`-nél
```

## A három szabály

**Hivatkozás, nem másolat.** A `turns` sor azt tárolja, *hol* van a szöveg: fájl + bájt-offset + hossz +
egy JSON-mutató (`message.content[*].text`), vagy Cursor esetén a `state.vscdb` kulcsa. A `chunks_fts`
contentless (`content=''`), tehát az invertált index létezik, a szöveg nem. Lekérdezéskor a `Hydrator`
olvassa vissza a forrásból.

Két kivétel, mindkettő `inline`, mindkettő ezen a gépen marad:

- **Múlandó** anyag. A `%TEMP%/claude/**` scratchpadet az OS bármikor törli, a
  Cowork kimenetek az app takarításától függnek — ezek `artifacts.inline_text`-ként
  bekerülnek (256 KB-ig).
- **Titkosított Cascade-törzsek.** Az Antigravity és a Devin asztali olyan
  formában tartja a beszélgetést a lemezen, amit nem tudunk olvasni. A
  `cam get` az élő language servert kérdezi, és a beszédet
  `turns.inline_text`-ként tárolja, mert nincs fájl és bájt-offset, amit
  feljegyezhetnénk. Ez nem része a `cam sync`-nek. Lásd
  [`sources.md`](sources.hu.md#cascade-törzsek-igény-szerint).

**Nem tippelünk.** Ha egy session projektje nem állapítható meg, `unattributed` marad. Minden verdikt
mellett ott a módszer és a megbízhatóság, és a `recall` alapból elrejti a gyenge találatokat.

**Nem írunk a forrásokba.** Minden idegen tároló `openSourceReadonly`-val nyílik (`readonly: true`,
`fileMustExist: true`). Az `immutable` szándékosan nincs bekapcsolva: az élő WAL miatt szakadt lapokat
olvasnánk.

## Inkrementalitás

A `sources` tábla a főkönyv. Egy append-only fájlra:

| állapot | döntés |
|---|---|
| azonos méret **és** mtime | `skip` — nulla olvasás |
| nőtt, és a fix ablakú prefix-hash egyezik | `append` a `bytes_indexed`-től |
| a prefix-hash eltér, vagy zsugorodott | `full` — `status='rotated'`, teljes újraolvasás |
| a fájl eltűnt | `missing` |

A prefix-hash **fix ablakot** használ (`min(4096, bytes_indexed)` bájt). Ha a fájl aktuális méretéig
hashelnénk, minden hozzáfűzés más ablakot fedne le, és minden sync teljes újraolvasás lenne.

A nem append-only fájl ugyanígy az `ext_version`-t használja: a változatlan
verzió `skip`. A Cursornél ez a `lastUpdatedAt` (vagy a `composerData`
sha256-ja, ha nincs időbélyeg — **csak akkor**, mert egy bubble szerkesztése
nem változtatja meg a `composerData`-t). A Codex és a Devin CLI a store által
közölt verziót használja. Az Antigravity összefoglalók a
`last_modified_time + step_count`-ot. Egy Cascade `.pb` az mtime + méretet, és
a kollektor a bájtokat soha nem nyitja ki.

## Igény szerinti letöltés

Egy kollektor, ami titkosított fájlra futna, óránként vendor daemont indítana,
és százával fejtene vissza beszélgetéseket, amiket senki nem kért. Ezért a
`cam sync` azt jegyzi meg, hogy a beszélgetés létezik, és a `cam get` /
`cam_get` az egyetlen pillanat, ami a language serverrel beszél.

Ez az út a `src/sources/` alatt van, nem a `collectors/`-ben. Megkeresi az
összes élő `language_server*` folyamatot, a CSRF tokent az argv-ból vagy a
folyamat környezetéből olvassa (Linuxon `/proc`, macOS-en `sysctl` majd `ps`,
Windowson PEB), mindkét listening portot próbálja, és minden daemont
megkérdez — egy daemon csak a saját felületét ismeri. Nem indít egyet sem. A
bezárt alkalmazás normális válasz.

## Projektfelismerés

Nincs bedrótozott gyökérlista. A `ProjectResolver` felfelé sétál az útvonalon:

1. **Tanult gyökér** (`projects.root_path`) — túléli a projekt mozgatását vagy törlését.
2. **Workspace-gyökér** (`workspace_roots`) — a séta itt megáll, és az alatta lévő mappa a projekt.
   Ezeket a `detectWorkspaceRoots` tanulja a korpuszból: az a mappa gyűjtő, aminek legalább három
   **különböző session** cwd-je van a gyerekei között.
3. **Marker** — `.git`, `package.json`, `pyproject.toml`, `go.mod`, `CMakeLists.txt`, `CLAUDE.md`, …
   A generikus nevek (`src`, `backend`, `dist`) átugorva.

A 2. lépés azért kell, mert egy gyűjtőmappa maga is lehet git-repó, húsz projekttel a hasában — a
markerek ott mind a gyűjtőmappa nevét adnák vissza, ahány projekt, annyiszor. Fájlrendszeri
heurisztikával nem szétválasztható: egy nagy projekt fordítva sül el, saját markere nincs, markeres
almappája sok. Ezért nem a lemez dönt, hanem az, hogy hány különböző session dolgozott alatta.

Generált nevek (UUID, ≥16 jegyű hex, `job-…-20260826-212306`, `codex-runs`, `worktrees`) sosem
projektnevek; ilyenkor a séta tovább megy felfelé, így a `codex-runs/<uuid>` a projektjéhez kerül.

## Attribúciós kaszkád

A bizonyíték (`path_evidence`) külön van a verdikttől (`attribution`). A bizonyíték előállítása drága —
tárolót kell olvasni hozzá; a verdikt olcsó, tiszta függvénye a bizonyítéknak. Ezért a `cam reattribute`
másodperc alatt lefut, és egy alias hozzáadása interaktív művelet.

| lépcső | forrás | súly | megbízhatóság |
|---|---|---|---|
| `manual` | `cam attribute` | 1000 | erős |
| `cwd`, `user_selected_folders`, `workspace_dirs`, `workspace_uris` | a session munkakönyvtára / kiválasztott mappái (három név ugyanarra a tényre; az Antigravitynek cwd-oszlopa sincs) | 3 | erős |
| `ofs_key` | Cursor `ofsContent` kulcsok (nyitott fájlok) | 2 | erős |
| `bubble_scan`, `msg_request_ctx` | a beszélgetésben említett útvonalak | 1 | erős |
| `time_correlation` | Cursor fájltörténet ±30 perc, ≥3 esemény és ≥50% részesedés | 1 | közepes |
| `time_correlation_weak` | ugyanaz, kevesebb bizonyítékkal | 1 | gyenge |

A `runner_up_key` mindig íródik: a 6:5 arányban szavazó szál más állat, mint a 6:0.

A `manual` és a `time_correlation*` bizonyíték **maga hordozza a verdiktet**: a `raw_path`-uk jelölés
(`~manual:<kulcs>`, `~time:9/10`), nem útvonal, ezért az újraszámolás nem oldja fel őket még egyszer.
Enélkül a kézi döntés minden `cam reattribute`-tal elveszne — a `rule_version` 2 pont ezt jelzi.
A `rule_version` 3 ugyanez a `workspace_dirs` és a `workspace_uris` miatt: nélkülük a `cwd`
lépcsőn minden Antigravity-beszélgetés attribuálatlan maradna.

## Keresés

FTS5 `unicode61 remove_diacritics 2` tokenizálóval, tehát `arvizturo` megtalálja az `árvíztűrő`-t.
Stemmer nincs sehol, a magyar meg agglutináló, ezért az 5 karakternél hosszabb tokenek **prefix**-szel
mennek (`projekt*` → `projektben`, `projektet`).

A `snippet()` NULL-t ad contentless táblán, ezért a kivonat és a kiemelés rehidratálásból készül. Az
ékezet-hajtás **hosszőrző**, különben a jelölés elcsúszna minden ékezet után.

## Fájlszerkezet

```
src/
  paths.ts, config.ts        platformfüggő helyek, markerek, kizárt területek
  db/{schema,open}.ts        séma, hub- és forrás-nyitó, SQLite-képesség ellenőrzés
  index/
    jsonl.ts                 offset-követő olvasó, mutató-feloldás
    chunker.ts               turn-határon ablakozó darabolás
    indexer.ts               session/turn/chunk írás, FTS
    hydrate.ts               visszaolvasás: ok / stale / missing
    watermarks.ts            skip / append / full döntés
  attribution/
    projkey.ts               marker + gyökér alapú projektfelismerés
    roots.ts                 workspace-gyökér tanulás
    evidence.ts              útvonal-kinyerés, bizonyíték írás
    resolve.ts               kaszkád, idő-korreláció, újraszámolás
  collectors/                tárolónként egy, közös interfésszel (titkosított
                             Cascade-nél csak metaadat)
  sources/
    language-server.ts       élő Codeium-leszármazott daemonok (port, CSRF)
    process-env.ts           egy env változó idegen folyamatból (Linux / macOS / Windows)
    cascade-rpc.ts           GetCascadeTrajectory minden daemonon
    antigravity-trajectory.ts beszédmező-whitelist
    antigravity-fetch.ts     `cam get antigravity:…`
    devin-fetch.ts           `cam get devin:…` (nem CLI-session)
  memory/                    konszolidáció, pontozás, promotált emlékek, álom
  ops/
    freshness.ts             mennyire friss az index (sync_runs)
    prune.ts                 megőrzés, felejtés, vacuum
    backup.ts                ellenőrzött online mentés
  db/portability.ts          betűhajtás-bélyeg: egy átvitt index nem talál némán semmit
  log.ts                     --quiet / --verbose; a válasz sosem tűnik el
  search/keywords.ts         HU/EN lekérdezés-elemzés, kiemelés
  query/                     recall, timeline, dossier, közös renderelés
  install/
    clients.ts               melyik kliens hol tartja a konfigját és a skilljeit
    mcp.ts                   JSON-merge és TOML tábla-csere, mentéssel
    skills.ts                a közös skill-törzs renderelése kliensenként
    locate.ts                a valódi program megkeresése az indítók mögött
    dream.ts                 ágens-CLI-k mint modell: felderítés, modellek, próba
    schedule.ts              Task Scheduler / launchd / systemd — terv és végrehajtás
    prompt.ts                a két kérdés, amit a telepítő feltehet
  mcp/server.ts              hét read-only tool, mindegyik válaszán az index korával
  cli.ts
assets/skill-body.md         a skill törzse; a {{SURFACE}} helyére a kliens kerül
assets/read-process-env.ps1  Windows PEB-olvasó a `WINDSURF_CSRF_TOKEN`-hez
skills/agent-memory/SKILL.md a nyilvános, felfedezhető skill (`npx skills add`)
```

Az `install/` szándékosan **terv és végrehajtás** kettéválasztva: minden rész előbb kiszámolja, mit
csinálna, és csak utána ír. Ettől a `--dry-run` nem közelítés, hanem ugyanaz a terv, és ettől
tesztelhető egyetlen gépről a három platform ütemezés-receptje is.
