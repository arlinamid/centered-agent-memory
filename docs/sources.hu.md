# A források

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

## Gemini CLI

```
~/.gemini/tmp/<projekt>/chats/session-*.json
~/.gemini/tmp/<projekt>/.project_root
```

Sessionönként egy teljes JSON dokumentum, nem JSONL: `sessionId`, `startTime`,
`lastUpdated`, `kind` (`main` | `subagent` | hiányzik) és `messages[]`.

- **A projektkönyvtár nevéből nem lehet visszafejteni az útvonalat.** A
  legtöbb egy sima mappanév (`scripts`), ami akárhány könyvtárra illik; a többi
  hash — és a `projectHash` **nem** a munkakönyvtár SHA-256-a. A
  `~/.gemini/projects.json` minden útvonalát végigpróbáltuk minden kis/nagybetűs
  és elválasztó-variánsban a hash nevű könyvtárak ellen: egy sem egyezett. Ezért
  a munkakönyvtár a chatek mellett fekvő `.project_root`-ból jön, és a
  `.project_root` nélküli projekt attribuálatlan marad. A referenciagépen ez 13
  könyvtárból 11, ami 159 chatfájlból 157-et fed le.
- **A fájlon belüli `projectHash` nem feltétlenül egyezik az őt tartalmazó
  könyvtáréval.** Egy subagent session a saját hash-ét viszi, miközben a szülő
  mappájában lakik — ez is indok arra, hogy az attribúció a könyvtárra épüljön.
- **A két szerep `user` és `gemini`, és más az alakjuk.** A `user` üzenet mindig
  `{text}` blokkok tömbje, a `gemini` üzenet mindig sima string. 159 fájlon
  mérve: 193 `user:array`, 359 `gemini:string`, kivétel nélkül.
- **Az `info` és az `error` a CLI önmagával beszél** — bővítmény-frissítési
  értesítők, kvótahibák —, ezeket nem indexeljük. Ahogy a `gemini` rekord
  `thoughts` és `toolCalls` mezőit sem.
- **A session növekedés közben helyben íródik újra**, tehát fél dokumentum nem
  parse-olható: a megváltozott fájlt egészben olvassuk újra. A `classifyFile`
  így is hasznos, mert a változatlan fájl nulla olvasásba kerül.
- **A Gemini rögzíti, hogy egy session subagent, de azt soha, hogy kié.** A
  kapcsolatot nyitva hagyjuk, nem következtetjük ki időzítésből.
- A chatek melletti `logs.json` ugyanazokat a user-üzeneteket tartalmazza, külön
  nem olvassuk: a `chats/*.json` a bővebb halmaz.

## Antigravity

```
~/.gemini/antigravity-cli/conversation_summaries.db     (SQLite)
~/.gemini/antigravity-cli/history.jsonl
~/.gemini/antigravity{,-ide}/brain/<uuid>/*.md
~/.gemini/antigravity{,-ide}/conversations/*.pb         (titkosított, nem olvassuk)
```

**Maguk a beszélgetések titkosítva vannak, nem csak sémátlanok.** 64 KiB-os
ablakon mérve a `conversations/*.pb` és az `implicit/*.pb` **7,997–7,998 bit
entrópiát** hordoz bájtonként, olvasható fejléc nélkül — miközben a mellettük
fekvő sima protobuf (`user_settings.pb`) 3,6-ot mér és protobufként olvasható.
A törzsek tehát nincsenek az indexben, és a collector ezt kimondja ahelyett,
hogy üres store-t jelentene. A szöveg igény szerint jön — lásd
[Cascade törzsek](#cascade-törzsek-igény-szerint). Amit offline indexelünk, az
az, amit az Antigravity a beszélgetéseiről *feljegyez*:

- `conversation_summaries.db` — beszélgetésenként egy sor. A **`title` minden
  sorban üres** a referenciagépen; a `preview` a generált egysoros összefoglaló,
  amit a felület mutat, tehát az lesz a cím. Turn nélkül.
- `history.jsonl` — a felhasználó által begépelt promptok, `workspace`-szel és
  általában `conversationId`-vel. Ez az egyetlen olvasható nyoma annak, ami
  elhangzott. A `conversationId` nélküli sor (egy session első promptja és
  minden slash-parancs) semmilyen beszélgetéshez nem köthető, ezért kihagyjuk
  ahelyett, hogy találgatás alá sorolnánk.
- `brain/<uuid>/*.md` — `task.md` és `implementation_plan.md`, az ügynök saját
  terv-dokumentumai, git-repóban. Csak `.md`: ugyanezek a könyvtárak több ezer
  képernyőképet és minden dokumentum `.resolved.N` történetét is tartalmazzák.
  A referenciagépen 480 dokumentum, 1,6 MB szöveg.

Csapdák:

- **A `last_user_input_time` minden sorban `0001-01-01 00:00:00+00:00`** — a
  .NET „soha” alapértéke. A `Date.parse` elfogadja, és **2001-et** ad vissza,
  tehát változatlanul tárolva minden beszélgetés huszonöt évvel korábbinak
  vallaná magát. A 2020 előtti értékeket hiányzónak tekintjük.
- **A `workspace_uris` percent-kódolt file URI-k JSON tömbje**
  (`["file:///d%3A/tool/demo"]`). Ez a store egyetlen közvetlen projektjelzése —
  munkakönyvtár-oszlop nincs benne —, ezért erős origó az attribúciós
  kaszkádban. 104 sorból 100-ban kitöltött.
- **Három könyvtár, egy adatkészlet.** Az `antigravity/` (IDE), az
  `antigravity-ide/` és az `antigravity-cli/` ugyanazokat a beszélgetés-azonosítókat
  tartalmazza; az első kettőben a `.pb` fájlok pár tucat bájtban térnek el.
  Mindent a beszélgetés-azonosító kulcsol, és deduplikálunk.
- A `~/.gemini/antigravity/mcp_config.json` **symlink** a
  `~/.gemini/config/mcp_config.json`-ra, amit a `config/.migrated` jelöl meg
  kanonikusként. A telepítő a célfájlt írja, nem a linket.

## Devin CLI

```
<appdata>/devin/cli/sessions.db     (SQLite, WAL)
```

A `sessions` adja a `working_directory`-t — valódi munkakönyvtár, tehát az
attribúció közvetlen és erős —, plusz a `title`-t, a `model`-t, és epoch
**másodperceket** a `created_at` / `last_activity_at` mezőkben. A
`message_nodes.chat_message` egy JSON string:
`{message_id, role, content, metadata}`, ahol a `content` mindig sima string.

- **A store erdő, nem átirat.** Minden újrapróbálkozás és szerkesztett prompt új
  ágat nyit, és mind bent marad a `message_nodes`-ban. A tábla végigolvasása
  egy kérdést négyszer indexelne (mérve: 4 `user` node 1 `prompt_history` sorra).
  A `sessions.main_chain_id` a beszélgetés jelenlegi állapotának levele; a szülők
  visszasétálása az egyetlen olvasat, ami azzal egyezik, amit a felhasználó lát
  — a referenciagépen 37 node-ból 16.
- **A rövidülő lánc a sessiont is rövidíti.** A visszalépés turnöket dob el, ezért
  a sessiont minden változásnál újraépítjük, nem hozzáfűzünk.
- A `system` rekordok a beinjektált környezet: a munkakönyvtár-kiíratás és egy
  always-on szabályblokk, ami a felhasználó saját utasításfájljait ágyazza be. A
  `tool` rekordok eszközeredmények. Egyik sem beszéd, és mindkettő ugyanazt a
  szöveget tenné az indexbe sessiononként egyszer.
- **Egy assistant node üres stringet is tarthat**, amíg egy eszközhívás fut.
- **A store nagy része a WAL-ban él** (1,9 MB WAL egy 4 KB-os adatbázisfájl
  mellett). A fixture ezért épül WAL módban.
- A `transcripts/*.json` (`ATIF-v1.7`) csak akkor keletkezik, ha a felhasználó
  exportál, és részhalmaza annak, amit a `sessions.db` már tartalmaz. Nem olvassuk.

## Devin asztali / Windsurf Cascade

```
~/.codeium/windsurf/cascade/<uuid>.pb
```

A Devin asztali alkalmazás Windsurf-fork, és ezt a store-t használja (a
`state.vscdb`-je tele van `windsurf*` kulcsokkal). A `.pb` fájlok ugyanúgy
titkosítottak, mint az Antigravityé, és **nincs mellettük összefoglaló
adatbázis**. A `cam sync` azt jegyzi meg, hogy a beszélgetés létezik — UUID
fájlnév, mtime, méret —, és a bájtokat nem nyitja ki.

A citáció `devin:<cascadeId>` marad. Ha ugyanaz az id a Devin CLI-ben is
megvan, az nyer: az a store már olvasható, és a `cam get` nem cseréli le a
turnjeit.

Egy megmaradt, nem Devin Windsurf-telepítés ugyanez a store és ugyanez a
protokoll, tehát ugyanaz az út lefedi, ha az az alkalmazás fut.

## Cascade törzsek, igény szerint

Az Antigravity és a Devin is titkosítva tartja a beszélgetéseket. Az egyetlen
komponens, ami vissza tudja fejteni őket, az a language server, amit az
alkalmazás már futtat: Connect-RPC sima HTTP-n localhoston. A `.pb` fájlt
nem fejtjük, és daemont nem indítunk.

Ez **nem** része a `cam sync`-nek. Csak akkor fut, ha valaki egy beszélgetést
név szerint kér (`cam get antigravity:<id>` / `cam get devin:<id>`, vagy
`cam_get` MCP-n). Amit lehúz, azt megőrzi, tehát a második kérdés egy
hívásba kerül. A bezárt alkalmazás normális állapot, nem hiba.

```
POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory
x-codeium-csrf-token: <token>
{"cascadeId": "<conversation id>"}
```

Minden alább mért, és minden sor egy rossz válasz, ami jónak látszott:

- **A header `x-codeium-csrf-token`.** Mindkét app Codeium-leszármazott, és
  megtartotta a gyártói előtagot. `x-csrf-token`, `x-csrf` vagy `csrf-token`
  mellett a daemon `401 {"code":"unauthenticated","message":"missing CSRF token"}`
  választ ad — ami rossz tokennek olvasható, nem rossz header-névnek.
- **A token a `--csrf_token` az argv-n, vagy a `WINDSURF_CSRF_TOKEN` a
  folyamat környezetében.** Az Antigravity a flaget írja. A Devin a
  környezeti változót, és az argv-n nincs token (mérve, újraindítás után is).
  Ha mindkettő megvan, az argv nyer. A `--extension_server_csrf_token` másik
  szolgáltatást véd, nem cserélhető. A parent pipe-ot nem nyitjuk ki, és az
  értéket nem írjuk le.
- **Ennek a környezetnek az olvasása platformfüggő, mint a portoké.** Linuxon
  a `/proc/<pid>/environ`. macOS-en először a `sysctl -b kern.procargs2.<pid>`,
  aztán a `ps eww`. Windowson a PEB, az `assets/read-process-env.ps1`-en
  keresztül. Az üres válasz az, hogy „nincs token”, ugyanaz, mint a „nem fut”.
- **A port nem a naplóból jön.** A `language_server.log` 49361/49362-t
  rögzített, miközben az élő processz 55026/55027-en hallgatott. A processz
  saját listening socketjeiből jön: Windowson `Get-NetTCPConnection`, Linuxon
  előbb `ss -ltnp`, aztán `lsof` (`ss` az, amit egy mai disztribúció szállít;
  egyik sem garantált), macOS-en `lsof`.
- **Két port van, és csak az egyik HTTP.** A másik HTTPS/gRPC, és
  `Client sent an HTTP request to an HTTPS server.`-rel válaszol. A sorrend
  nem stabil (Devinen mérve: bármelyik lehet a HTTP-s), ezért mindkettőt
  próbáljuk.
- **Egy daemon csak a saját felületét ismeri.** A rossz language servertől
  `{"code":"unknown","message":"trajectory not found"}` a válasz. Az
  Antigravity és a Devin ugyanazokra a metódusokra válaszol, ezért minden
  élő daemont megkérdezünk.
- **Daemont nem indítunk, és nem is próbálunk.** Lezárt Antigravity mellett
  az `agy agentapi` csak az alparancs-listáját írja ki, az
  `agy agentapi get-conversation-metadata <id>` pedig 1-gyel lép ki
  `{"error":"ANTIGRAVITY_LS_ADDRESS is not set"}` üzenettel — egy daemon
  kliense, nem indítási mód. A `language_server.exe` közvetlen futtatása egy
  dokumentálatlan bináris argumentumkészletének kitalálása lenne, egy valódi
  `agy` session indítása pedig számlázott modellhívás helyi adat olvasásához.

Ami a két store között különbözik:

| | Antigravity | Devin / Windsurf |
|---|---|---|
| Citáció | `antigravity:<id>` | `devin:<id>` |
| `GetAllCascadeTrajectories` | `{}` (proto3 az üres repeated mezőt elhagyja) | map cascade id szerint (`summary`, `stepCount`, `workspaces`) |
| Azonosítók / változásjelzés | `conversation_summaries.db` (`last_modified_time` + `step_count`) | a `.pb` fájlnév; a verzió mtime + méret |
| Ismeretlen id | nem húzza le (`not-found`) | lehúzza; a sikeres válasz beszúrja a sessiont |
| Ha a `.pb` eltűnt, és a törzs megvan | — | a megőrzött példány aktuális |

**Ami visszajön, és ami megmarad.** A trajectory lépésnapló, nem átirat: a
mért beszélgetésben 523 lépés 46 turn volt. Egy ilyen trajectory népszámlálása:

```
167  PLANNER_RESPONSE   158  EPHEMERAL_MESSAGE   58  VIEW_FILE   29  CODE_ACTION
 23  RUN_COMMAND         23  GREP_SEARCH         13  COMMAND_STATUS
 12  USER_INPUT          11  ERROR_MESSAGE        6  CONVERSATION_HISTORY
  6  KNOWLEDGE_ARTIFACTS  6  LIST_DIRECTORY       6  CHECKPOINT
  3  BROWSER_SUBAGENT     2  SEND_COMMAND_INPUT   …  NOTIFY_USER
```

Három mező a beszéd, és a csapda a `PLANNER_RESPONSE`:

| Lépés | Felvett mező |
|---|---|
| `USER_INPUT` | `userInput.items[*].text`, tartalékként `userResponse` |
| `NOTIFY_USER` | `notifyUser.notificationContent` |
| `PLANNER_RESPONSE` | **csak** a `plannerResponse.response` |

A planner-lépések többsége a modell gondolatmenete: `thinking`, `toolCalls[]`
és egy base64 `thinkingSignature` — ugyanaz a forma, amit a Claude Code
átiratokból is kihagyunk. De *néhány* hoz `response`-t is, azt a mondatot,
amit a felhasználó olvas. Egy beszélgetés három legnagyobb planner-lépésének
mintájában egyik sem volt, és pont így marad ki a mező: az egész lépés
felvétele a gondolatmenetet indexelné, az egész kihagyása a beszélgetés
felét veszíti. Csak a `response` olvasása 12 turn helyett 46-ot hozott
ugyanabból az 523 lépésből.

**A turnök inline tárolódnak.** A sima szöveg sehol nincs a lemezen — a store
titkosítva tartja —, tehát nincs fájl és bájt-offset, amit feljegyeznénk. Ez
ugyanaz a kivétel, amit a volatilis scratchpadek már használnak, és azt
jelenti, hogy a lehúzott beszélgetés olvasható és kereshető marad akkor is,
miután az alkalmazás újra bezárult.

**Semmit sem húzunk le kétszer.** Amíg a fenti verzió nem mozdult, a
megőrzött másolat aktuális, és nincs hívás. Ha elmozdult, a beszélgetést
újra lekérjük, és a turnjeit **cseréljük**, mert a folytatott beszélgetésnek
új lépései vannak, és a hozzáfűzés megduplázná, ami előttük volt.
