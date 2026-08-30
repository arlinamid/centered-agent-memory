# A négy forrás

Ez a fejezet azt írja le, amit méréssel derítettünk ki a tárolókról — beleértve azokat a
buktatókat, amelyek ránézésre nem látszanak, és amelyekre mind van regressziós teszt.

## Claude Code

```
~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
~/.claude/projects/<cwd-slug>/<sessionId>/subagents/<agentId>.jsonl
```

JSONL, soronként egy rekord. A referenciagépen **13-féle** `type` fordul elő; ebből csak a `user` és az
`assistant` beszélgetés.

- **A `message.content` lehet string vagy blokk-tömb.** A tömbből **csak** a `type: "text"` blokkok
  indexelődnek. A `thinking` blokk több kilobájtnyi base64 `signature`-t hordoz, az `attachment` rekord
  beillesztett tartalom — egyik sem beszélgetés. Fehérlista, nem feketelista: egy új rekordtípus így nem
  szennyezi be némán az indexet.
- **A `queue-operation` rekord a prompt szövegét tartalmazza,** mielőtt `user` rekord lenne belőle.
  Mindkettő indexelése duplázna.
- **Cím:** `ai-title` (generált) és `custom-title` (kézi). A kézi erősebb, a későbbi felülírja a korábbit.
  Régebbi átiratokban egyik sincs — azok címét a Desktop-index adja.
- **A mappanév-slug lossy**: `Documents/tervek/vázlatok` → `…-tervek-v-zlatok`. A projekt ezért
  mindig a rekordbeli `cwd`-ből jön, soha a mappanévből.
- **Az alügynök-átirat minden rekordjában a SZÜLŐ `sessionId`-je áll.** Az azonosítója csak a fájlnév
  lehet, különben beleolvad a szülő sessionbe.

## Claude Desktop

```
<appdata>/Claude/claude-code-sessions/<account>/<org>/local_*.json
```

Csak **index**, átirat nélkül: `title`, `cwd`, `model`, `completedTurns`, `createdAt`, `lastActivityAt`
és egy `cliSessionId`, ami a Claude Code átiratra mutat.

Ez az egyetlen hely, ahol a régebbi sessionöknek **emberi címük** van („Komplex workflow bemutató"),
ezért a kollektor gazdagításként fut: meglévő címet sosem ír felül. Amelyik bejegyzéshez nincs helyi
átirat, az `turn_count = 0` sorként kerül be — jobb, ha az idővonal azt mondja, hogy volt egy
beszélgetés, mint hogy nyomtalanul eltűnjön.

Több fiók lehet, és az egyik „fiók" egy `skills-plugin` nevű álkönyvtár.

## Cowork (Claude Desktop local agent mode)

```
<appdata>/Claude/local-agent-mode-sessions/<account>/<org>/local_<sid>.json     meta
<appdata>/Claude/local-agent-mode-sessions/<account>/<org>/local_<sid>/
    .claude/projects/<vm-slug>/<cliSessionId>.jsonl                            átirat
    outputs/                                                                   termékek
```

Az átirat formátuma **azonos** a Claude Code-éval, ezért ugyanaz a parser olvassa.

- **A `cwd` itt használhatatlan**: a sandboxon belüli generált név (`/sessions/happy-great-cray`). A
  projekt a `userSelectedFolders`-ből jön — és egy Cowork session jogosan érinthet több projektet, ezért
  mindegyik mappa bizonyítékként rögzül.
- Az `outputs/` mappa kész termékeket tartalmaz (docx, pptx, kutatási jegyzet), amik sehol máshol nem
  léteznek.
- A sandbox VM image-ében (`vm_bundles/claudevm.bundle/sessiondata.vhdx`) **nincs** használható adat: a
  session-mappák léteznek, de kiürítve; a beszélgetés a hoston van.

## Codex

```
~/.codex/state_5.sqlite          threads, thread_spawn_edges
~/.codex/sessions/ÉV/HÓ/NAP/rollout-*.jsonl
```

A `threads` tábla adja az indexet, a rollout fájl a szöveget.

- **A `created_at` és `updated_at` MÁSODPERCBEN van**, minden más forrás ezredmásodpercben.
  Konverzió nélkül minden Codex-session 1970-be esne.
- **A `title` a sorok többségénél nem cím**, hanem beágyazott prompt (a referenciagépen 917-ből 739 hosszabb
  200 karakternél). Hosszkapu kell, és visszaesés az első user-üzenet első sorára.
- **A `session_meta.payload.id` a szál azonosítója; a `session_id` alügynöknél a SZÜLŐÉ.** Rossz
  mezőre join-olva minden alügynök a szülőhöz kerül.
- A `cwd` a `threads` táblában `\\?\` prefixszel jön, a `session_meta`-ban anélkül.
- A `source` mező vagy literál (`exec`, `vscode`), vagy JSON alügynök-leíró (`parent_thread_id`,
  `agent_role`, `agent_nickname`).
- **A `response_item` rekordok kihagyva**: duplikálják az `event_msg` tartalmát, és `developer` szerepű
  engedély-boilerplate-et hoznak.
- A `projects` és `project_roots` tábla létezik, de üres — nem lehet belőle projektlistát bootstrapelni.

## Cursor

```
<appdata>/Cursor/User/globalStorage/state.vscdb     (a referenciagépen 7,6 GB)
<appdata>/Cursor/User/History/<hash>/entries.json
```

Egy SQLite, `ItemTable` és `cursorDiskKV` táblákkal.

| kulcs | tartalom |
|---|---|
| `ItemTable['composer.composerHeaders']` | a beszélgetéslista: `composerId`, `name`, `createdAt`, `lastUpdatedAt` |
| `composerData:<cid>` | `fullConversationHeadersOnly` — rendezett bubble-lista, `type` 1=user, 2=assistant |
| `bubbleId:<cid>:<bid>` | az üzenet (`text`) |
| `ofsContent:<cid>:<uri>` | **a kulcs hordozza a nyitott fájl URI-ját**; az érték egész fájltartalom |
| `messageRequestContext:<cid>:<bid>` | kérés-kontextus |

**A `LIKE 'prefix%'` teljes indexszkenre esik vissza.** A `key` UNIQUE, tehát van BINARY indexe, de a
SQLite csak `case_sensitive_like=ON` mellett alakítja a `LIKE`-ot tartomány-kereséssé. Élő méréssel,
ugyanazon a composeren:

```
LIKE  'bubbleId:<cid>:%'                       100,4 ms   SCAN
key >= 'bubbleId:<cid>:' AND key < 'bubbleId:<cid>;'   0,0 ms   SEARCH
```

Van rá őrszem-teszt, ami `EXPLAIN QUERY PLAN`-nel megköveteli a `SEARCH`-öt.

További tudnivalók:

- **A beszélgetéseknek nincs munkakönyvtáruk.** A projekt fájlútvonalakból jön: `ofsContent` kulcsokból
  (erős), a bubble-tartalmakból (erős), végül a fájltörténet idő-korrelációjából (közepes/gyenge).
- **Sok beszélgetésnek nincs `lastUpdatedAt`-je** (háttér- és cloud-agent szálak). Ezekre a
  `composerData` sha256-ja a változásjel — de csak ezekre, mert egy bubble szerkesztése nem érinti a
  `composerData`-t.
- Egyes beszélgetéseknek `composerData` soruk sincs; ezek üres sessionként kerülnek be.
- **A bubble-ök nem hordoznak időbélyeget.** A hub nem talál ki egyet turnönként, hanem a chunk
  időbélyege a session kezdetére esik vissza.
- A `.backup` fájlt (a referenciagépen 4,1 GB) sosem nyitjuk meg.
- Az `ofsContent` kulcs URI-ja percent-kódolt: `decodeURIComponent` nélkül a `d%3a` elbukik a
  betűjel-ellenőrzésen.

### Cursor fájltörténet

`User/History/<hash>/entries.json` — a `resource` a szerkesztett fájl abszolút URI-ja, az `entries[]`
pedig a mentések időbélyegei. A referenciagépen 6076 mappa, 34 567 esemény. Ez az egyetlen jel azokhoz a
Cursor-szálakhoz, amelyek egyetlen útvonalat sem említenek.
