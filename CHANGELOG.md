# Changelog

Formátum: [Keep a Changelog](https://keepachangelog.com/), verziózás: [SemVer](https://semver.org/).

## [0.5.0] — 2026-08-29

### Nyilvános repó — CI, kiadás, és a gépspecifikus nyomok kitakarítása

**Cél volt:** a projekt eddig egyetlen gépen élt, és ez látszott rajta. Egy eszköz, ami valakinek a
teljes beszélgetéstörténetét indexeli, nem mehet ki úgy nyilvánosra, hogy közben a szerzője gépéről
mutat útvonalakat és valódi projektneveket — pláne nem tesztfixtúraként, ahol senki nem keresi.

- **Minden gépspecifikus nyom kicserélve.** A tesztfixtúrák valódi projektnevei, a gyűjtőmappa
  útvonala, a Node verziókezelő telepítési helye és a launchd-címkébe épített vezetéknév
  (`io.github.arlinamid.cam` lett) mind kitalált megfelelőt kaptak. Két teszt ettől elhasalt, és
  mindkettő jogosan: az egyik aláhúzós elnevezést várt vissza, a másik a találatok ábécésorrendjét
  ellenőrizte. Amit a csere elmosott, azt kézzel állítottam helyre, nem az elvárást igazítottam a
  kimenethez.
- **A tiltás strukturális, nem névlista.** A `check-privacy.mjs` nem azt keresi, hogy szerepel-e a
  szerző neve — egy ilyen lista pont azt tenné közzé, amit ki akar zárni. Azt nézi, hogy minden
  home-könyvtár neve **helyőrzőnek látszik-e** (`me`, `dev`, `user`, egyetlen betű), és hogy
  adatfájl nem került-e a repóba. Ez a szabály minden jövőbeli közreműködőre is igaz marad.
- **A nyilvános történet egyetlen commitból indul.** A régi 8 commit diffje ugyanezeket a nyomokat
  vitte volna fel, és egy `git grep` a történeten mindet előhalássza. A fejlődés menetét a changelog
  amúgy is részletesebben őrzi, mint a commit-üzenetek; az eredeti történet helyben, bundle-ben
  maradt meg.
- **CI mind a három platformon** (`.github/workflows/ci.yml`): típusellenőrzés, teszt Node 22-n és
  24-en, majd — és ez az új rész — **a lefordított csomag tényleges telepítése** tarballból, és
  annak ellenőrzése, hogy a telepített példány *válaszol is*. A `cam --help` egy néma no-opot is
  átenged, ezért a lépés azt kéri számon, hogy a `cam status` kiír-e bármit; pont ez a hiba
  fordult elő élesben. Az MCP-szervert külön indítja `initialize`-zal, üres indexen.
- **A tesztfuttató két workerre korlátozva CI-n.** A suite nagy része valódi alfolyamatként
  indítja a CLI-t, tehát itt egy worker sokkal többe kerül a szokásosnál; a leglassabb futtatón ez
  egyszer kiéheztette a vitest saját főszálát („Timeout calling onTaskUpdate"), miközben mind a
  454 teszt átment. Nem kerül semmibe: mérve a falióra-idő ugyanannyi, a versengés viszont
  kevesebb (115 s → 55 s tesztidő).
- **A `vitest.config.ts` nem írja felül némán a hívót.** A `test.env` erősebb a shell környezeti
  változójánál, tehát a beégetett `CAM_CASE_FOLD: "1"` csendben eldobta, ha valaki a másik hajtást
  kérte. Most alapértelmezés (`process.env.CAM_CASE_FOLD ?? "1"`), nem parancs.
- **Nincs második, megfordított hajtású teljes tesztfutás — és ez tudatos.** Írtam egyet, aztán
  kiderült, hogy a fenti felülírás miatt sosem futott le ténylegesen; amikor végre lefutott, 32
  teszt bukott el. Egyik sem termékhiba volt: a suite szándékosan **rögzíti** a hajtást, hogy
  ugyanaz az elvárás álljon mind a három platformon, tehát az állításai kis betűs útvonalakat
  írnak le szó szerint. Megfordítva futtatva csak azt bizonyítanák, hogy a másik beállításhoz
  írták őket. Zöldre hozni annyit tenne, hogy az állítások harmadát származtatottra írom át — az a
  kódot hasonlítaná önmagához. A hajtás ott van lefedve, ahol értelme van: a `normalizePath`
  paraméterként kapja meg, és a `test/projkey.test.ts` mindkét értékkel meghívja.
- **A csomag tartalma ellenőrzött:** ha forrás, teszt vagy source map kerülne a tarballba, a CI
  elbukik. A verzió három helyen szerepel (`package.json`, `SERVER_VERSION`, changelog-szakasz), és
  a CI megköveteli, hogy egyezzenek.
- **Kiadás tagre** (`.github/workflows/release.yml`): a tarball nem épül és reménykedik — előbb
  mind a három platformon feltelepül és elindul, és a release csak akkor jön létre, ha mind a három
  rendben volt. A kiadási jegyzetet a changelogból emeli ki, mert két prózai leírás ugyanarról a
  kiadásról előbb-utóbb elkezd egymásnak ellentmondani.
- **A `private: true` marad**, a nyilvános repó ellenére is. A kiadási csatorna a GitHub release és
  a tarball, nem az npm registry — így a mező pontosan egy dolgot csinál: megfog egy véletlen
  `npm publish`-t.
- **A telepítési recept pontosítva:** az `npm link` és az `npm install -g .` is a checkoutra
  **linkel**, nem másol, tehát a checkout elmozdítása vinné magával a bekötött klienseket. A README
  most tarballt ajánl, és megmondja, miért.

**Amit az első CI-futás talált — három hiba, mindhárom olyan platformon, amit fejlesztés közben nem
tudtam futtatni:**

- **`better-sqlite3` 11 → 13.** Node 24-en a folyamat `SIGABRT`-tel elszállt a leálláskor
  (`RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr`), a `Statement`
  destruktorából. A 12-es és alatti kiadások a nyers V8 `node::ObjectWrap`-re épülnek, amihez a Node
  24.19 cleanup hookot adott; a hook eltávolítása a már megszűnt `Environment`-en hasal el. A 13.0.0
  N-API-ra váltott, ezzel a hibaosztály nem javítva, hanem **megszüntetve** lett. Nekünk ez azon
  túl is nyereség, hogy a CI zöld: az N-API build nincs Node ABI-hoz kötve, márpedig ezt az eszközt
  tetszőleges Node-verzió alá telepítik globálisan.
- **A frissesség-figyelmeztetés tesztje a platformot nézte, nem a beállítást.** A „másik
  útvonal-hajtással írt index" esetét úgy állította elő, hogy Windowson `0`-t írt, máshol `1`-et —
  csakhogy a macOS is hajt, mint a Windows, tehát ott nem az ellenkezőjét írta, és a figyelmeztetés
  jogosan maradt el. Most a tényleges `CASE_INSENSITIVE_FS` ellenkezőjét írja, ami a `CAM_CASE_FOLD`
  megfordított futásában is helyes marad.
- **A telepítő-tesztek fixtúrája feloldatlan tempkönyvtárat használt.** macOS-en a `/var` a
  `/private/var`-ra mutat, és a `locate` — helyesen — feloldott útvonalat ad vissza. Nem az
  elvárást igazítottam a kimenethez: a fixtúra gyökere lett feloldott, mert az installer is
  szándékosan feloldott útvonalat ír (egy symlinkre mutató ütemezett feladat a link elmozdulásának
  napján törik el).
- **`--ignore-scripts` a telepítésnél, és ez nem CI-kerülőút.** A 13-as `better-sqlite3` minden
  támogatott platformra hoz előre fordított binárist a csomagban, az npm mégis lefuttatja rá a
  beépített `node-gyp rebuild`-et. A `binding.gyp` ilyenkor no-oppá teszi magát — csakhogy a
  node-gyp Windowson *előbb* keres Visual Studiót, hogy aztán egy üres projektet generáljon. A
  futtatón ez elhasalt (a VS 18-at nem ismerte fel), pedig fordítani nem kellett volna semmit.
  Fordító nélküli gépen ugyanez a felhasználót érné el, ezért a README és a `docs/install.md` is
  `--ignore-scripts`-tel telepít. Ellenőrizve: tiszta `npm ci --ignore-scripts` után nem keletkezik
  `build/` mappa, a kötés a prebuildből töltődik, és mind a 454 teszt zöld.

---

### Telepítés — egy parancs, ami beköti magát mindenhova

**Cél volt:** a kézi bekötés négy kliensben, négy formátumban, plusz az ütemezés — ez az a lépés,
ahol egy egyébként kész eszközt nem kezd el használni senki. Hogyan:
[`docs/install.md`](docs/install.md).

- **`cam install` / `cam uninstall`**, `--dry-run`-nal és részenkénti kikapcsolással
  (`--no-mcp`, `--no-skills`, `--no-dream`, `--no-schedule`), globálisan vagy `--project`-tel a
  repóba. A telepítő kiírja azt is, **melyik indexet** fogja használni a bekötött szerver — az
  útvonal nem magától értetődő, és minden más rész ezt a fájlt olvassa.
- **`npx`-ből nem telepítünk, mert nem lehet tartósan.** Az `npx` az npm gyorsítótárába csomagol ki
  (`_npx/<hash>`), és a saját `node_modules/.bin`-jét teszi a `PATH`-ra a futás idejére — tehát az
  abszolút útvonal a gyorsítótár kitakarításáig él, a puszta `cam-mcp` pedig a folyamat kilépéséig.
  Mindkettő olyan konfigurációt ad, ami ma jónak látszik, és később némán nem indul el. A telepítő
  felismeri az ideiglenes csomagmappát, nem ír semmit, és `npm i -g`-t javasol.
- **A szerver mindig abszolút útvonallal kerül a konfigurációba**, akkor is, ha a `cam-mcp` a
  `PATH`-on van. Eddig ilyenkor a puszta parancsot írtuk be, holott a klienst nem a telepítő shellje
  indítja: egy dockból indított asztali alkalmazásnak nincs bejelentkezési `PATH`-a. A dokumentáció
  egyébként eddig is ezt állította — most a kód is ezt csinálja.
- **Egy csomag, egy ütemezés.** A feladatnevek rögzítettek, tehát duplikálni nem lehetett őket —
  átvenni viszont igen: egy második telepítés némán a saját példányára állította volna a meglévő
  feladatot, és az előző úgy nézett volna ki, mintha telepítve volna, miközben semmi nem fut a
  nevében. A telepítő mostantól megnézi, kié a regisztrált feladat: ugyanez a példány esetén nincs
  teendő, másiknál nem ír, megnevezi mindkét parancsot, és `1`-gyel lép ki. Átvétel: `--force`.
  (A `scheduleInstalled` eddig is megvolt, csak soha senki nem hívta meg.)
- **A háttérfeladat és az MCP-parancs feloldott symlinkekkel íródik.** Egy Node-verziókezelő mozgó
  linket tesz a Node bináriba és a globális `node_modules`-ba is; egy óránként futó feladat nem
  változhat attól, hogy valaki verziót váltott egy terminálban.

### Javítva

- **A globálisan telepített CLI semmit nem csinált, és nullával lépett ki.** A belépéspont-vizsgálat
  az `import.meta.url`-t hasonlította a `process.argv[1]`-hez nyersen, a Node viszont az elsőt
  feloldott symlinkekkel adja, a másodikat úgy, ahogy a shell írta. Egy Node-verziókezelő pontosan
  ide tesz linket (`C:\nvm\current` → `…\nvm\v22.21.1`), tehát a két érték sosem egyezett: a `cam`
  elindult, nem futtatott semmit, és sikert jelentett. Ütemezett feladatként ez óránkénti zöld
  futás, üres eredménnyel. Az összehasonlítás mostantól feloldott útvonalakon történik.
- **A kliensek konfigurációja sértetlen marad.** A JSON-ok a saját behúzásukkal íródnak vissza, a
  Codex TOML-jában szövegszinten cseréljük a saját táblánkat (a kommentek megmaradnak), és az első
  változtatás előtt biztonsági másolat készül. Egy **sérült konfigurációt nem írunk felül**: a
  parancs megmondja, melyiket, folytatja a többivel, és `1`-gyel lép ki.
- **Ami nincs telepítve, azt nem telepítjük.** Egy klienst a saját könyvtára jelent be; enélkül a
  parancs kihagyja, ahelyett hogy egy soha nem használt eszköznek konfigurációt írna.
- **Skill kliensenként**, egy közös törzsből (`assets/skill.md`). Az MCP-bekötéstől az ágens még nem
  használja az indexet — attól használja, hogy tudja, mikor érdemes. Ami eszközönként eltér, az egy
  szakasz: van-e terminál, vagy csak az MCP-toolok.
- **Az álom fázis modellt kap a gépen már meglévő ágens-CLI-kból** (Codex, Claude Code, Cursor
  Agent, Gemini, Antigravity, Ollama), és a modellt is a felhasználó választja — a listát a Codex a
  saját `models_cache.json`-jéből, az Antigravity az `agy models`-ből, a Cursor a `--list-models`-ből
  adja. **Csak akkor kerül a konfigurációba, ha egy éles promptra válaszolt:** egy rossz kapcsolóval
  megírt sablon pontosan úgy néz ki, mint egy működő, egészen az első éjszakai futásig.
- **A sablonok nem engedik a modellt a lemezhez** (`-s read-only`, `--tools ""`, `--mode ask`), és
  **kikapcsolják a session-mentést** ott, amit a `cam` maga is indexel (`--ephemeral`,
  `--no-session-persistence`) — enélkül a következő szinkron beolvasná az álom-promptokat, és az
  index lassan megtelne a saját tükörképével.
- **Ütemezés telepítése** mind a három platformon: Task Scheduler, launchd, systemd user timer,
  óránkénti szinkronnal és éjszakai karbantartással, mindenhol bekapcsolt pótlással. A tervező tiszta
  függvény, ezért mind a három recept tesztelhető egyetlen gépről.

#### Javítva

- **A `.cmd`-shim mögötti valódi program.** Windowson egy npm-es CLI három fájl, és egyik sem a
  program; a Node 18.20 óta shell nélkül el sem indítja őket. A keresés mostantól az egész `PATH`-t
  végignézi, átolvas az indítókon, és vagy natív futtathatónál, vagy `node <szkript>`-nél köt ki.
  Ez nem kozmetika: a `PATH` sorrendje rossz döntőbíró, ha egy eszköz kétszer van fent (a
  fejlesztőgépen épp a shim mögötti npm-verzió volt hibás), és a beírt parancsot később egy ütemezett
  feladat futtatja, aminek nincs shellje és nincs `PATH`-a.
- **`appSupportDir` a kapott profilt használja, nem a környezeti változót.** Az `APPDATA` és az
  `XDG_CONFIG_HOME` a futó folyamat profilját írja le; más home-mal hívva némán ide irányítottak
  vissza — így írt volna egy fixture-be irányított telepítés a valódi Claude Desktop-konfigba.
- **A `cam memory dream` a `stdout` helyett fájlból veszi a választ, ahol az eszköz tudja**
  (`codex exec -o`), mert a `stdout`-on ott a banner és a tokenszámláló is.

---

## [0.4.0] — 2026-08-29

### Álom fázis — az egyetlen hely, ahol modell dolgozik

**Cél volt:** a determinizmus nem tud megmondani egy mondatban, hogy egy előhívott részlet miről szól.
Ez az egy dolog hiányzott, és csak ez kerül modell közelébe. Hogyan működik:
[`docs/memory.md`](docs/memory.md#az-álom-fázis-opcionális).

- **`cam memory dream [--dry-run] [--force] [--project p] [--model m]`** és a
  **`cam memory dream forget`** (`src/memory/dream.ts`, `memory_dreams` tábla). Nem promotál, nem von
  vissza, egyetlen bizonyíték-táblát sem ír.
- **Alapból ki van kapcsolva, és a `consolidate` sosem hívja.** Modell nélkül a parancs nem küld
  semmit, hanem megmondja, mit kell beállítani, és `2`-vel lép ki.
- **A modell konfiguráció, nem kód:** bármilyen parancs jó, ami promptot olvas és szöveget ír
  (`"memory": { "dream": { "provider": "command", … } }`), tehát modellt cserélni nem fordítás.
- **Ami kimegy, azt a parancs megmondja, mielőtt kimenne** — hány emlék, hány karakter, melyik
  modellnek. Ez a sor `--quiet` mellett is megjelenik: nem haladásjelzés, hanem közlés. A `--dry-run`
  emellett az első promptot szó szerint kiírja, és nem indít el semmit.
- **A kimenet gyorsítótárazva van a bemenet hashével**, a modell nevével megjelölve, a forrásoktól
  külön tárolva — ugyanazért kétszer nem fizetsz, és `dream forget`-tel bármikor eldobható.
- **Egy elszálló modell nem viszi magával a futást:** a hiba emlékenként van feljegyezve, a parancs
  nem nulla kóddal lép ki, és holnap újrapróbálható. Az időtúllépés is ide tartozik.
- **A generált mondat sosem látszik forrásnak:** a `cam memory list`, a `cam memory show` és a
  `cam_memory` mind a modell nevével együtt írja ki.

### M4 — Üzemeltetés

**Cél volt:** felügyelet nélkül is használható maradjon. Hogyan üzemeltesd:
[`docs/operations.md`](docs/operations.md).

#### Hozzáadva

- **Frissesség-jelzés** (`src/ops/freshness.ts`). A `sync_runs` táblát az első verzió óta írjuk, és
  eddig senki nem olvasta — ami ugyanaz, mintha nem lenne. Mostantól **minden MCP-válasz utolsó sora**
  megmondja, mikor szinkronizált utoljára az index, mit tartalmaz, elavult-e, és hibázott-e az utolsó
  futás. A kor a legutóbbi **befejezett** futásból jön, nem a legutóbbi sorból: egy elszállt futás nem
  teheti frissnek az indexet.
- **`cam status`** és a hetedik MCP-tool, a **`cam_status`**: ugyanez a jelentés önállóan, `--json`-nal
  is. A `cam doctor` is kiírja, a méret és a betűhajtás-figyelmeztetés mellett.
- **`cam get <tool:id[#seqN-M]>`** — a `cam_get` MCP-tool CLI-párja, ami eddig hiányzott. A
  `cam recall` hivatkozásokat írt ki (`cursor:217d5d40…#seq16-23`), amiket terminálból semmi nem
  tudott megnyitni: a keresés fele CLI-ból zsákutca volt. A hivatkozás-elemző és a turn-renderelő
  ezzel a lekérdező rétegbe került (`parseCitation` a `recall.ts`-be, `formatTurns` a `format.ts`-be),
  tehát a két felület ugyanazt a szöveget és ugyanazokat a hibaeseteket adja. Az elemezhetetlen
  hivatkozás `2`-vel, a nem létező session `1`-gyel lép ki.
- **`cam prune`** — megőrzési szabály a régi előhívási nyomra, a futásnaplóra és az eltűnt forrású
  sessionökre. `--dry-run` ugyanazokat a számokat adja, mint az éles futás; `--vacuum` a helyet is
  visszaadja. Beállítható a konfigban (`retention`) és kapcsolóval (`--recall-days`, `--keep-runs`,
  `--missing-days`).
- **`cam forget --project <kulcs> | <tool:sessionId>`** — egy projekt vagy egy session elfelejtése az
  indexből, a promotált emlékeivel együtt. A forrásfájlokhoz nem nyúl.
- **`cam backup [<fájl>]`** — ellenőrzött, önálló másolat az SQLite online backup API-jával, `--json`
  kimenettel. Utána megnyitja a másolatot, `quick_check`-eli, és összecsukja a WAL-t; ha az ellenőrzés
  hibát talál, `1`-gyel lép ki, és nem nevezi mentésnek.
- **`--quiet` és `--verbose`** minden parancson (`src/log.ts`). A `--quiet` hiba esetén beszél,
  egyébként hallgat; a parancs *válaszát* sosem nyeli el — egy `cam recall --json --quiet`, ami semmit
  nem ír ki, csapda lenne. A `--verbose` fázisonkénti időt ad a synchez.
- **Ütemezési minta mind a négy platformra**: Task Scheduler, launchd, systemd timer, cron —
  [`docs/operations.md`](docs/operations.md).
- **Betűhajtás-bélyeg** (`src/db/portability.ts`, `meta.path_case_fold`). Egy Windowson írt index
  kisbetűs útvonalakat tárol; Linuxon megnyitva **némán** semmit nem talál. A `cam backup` behozta ezt
  a hibalehetőséget, ezért az index megjelöli magát, a `cam doctor` és a `cam_status` pedig
  összeveti a futó rendszerrel, és megmondja, mit kell beállítani.
- **`npm run smoke`** (`scripts/mcp-smoke.ts`) — a kiadott MCP-szervert valódi stdio-alproceszként
  hajtja meg a valódi indexen, és ellenőrzi, hogy mind a hét tool válaszán rajta van az index kora, a
  hibaválaszokon is. A tool-listát a szervertől kérdezi, tehát egy le nem tesztelt toolt is kiszúr.

#### Javítva

- **A `resolveFileEvents` nem a feloldás miatt volt lassú, hanem az írás miatt.** A terv gyanúja a
  6 064 útvonal újra-feloldása volt; a valóság az, hogy a régi kód 6 064 külön `UPDATE`-et adott ki a
  `file_events` táblára, aminek nem volt indexe a `resource` oszlopon — 6 064 teljes tábla-scan
  34 567 soron. Az új `idx_fe_resource` index és az egyetlen halmaz-alapú `UPDATE` mellett, a
  referenciagép indexén mérve: **14 982 ms → 228 ms**. A `path_keys` gyorsítótár a maradékot viszi
  (a teljes fázis 804 ms → 128 ms), és túléli a Cursor-fájltörténet napi újratöltését, ami eddig
  nullázta a kiszámolt `project_key`-t. A `cam reattribute` teljes újraszámolást kér, mert egy új
  alias megváltoztatja, mire old fel egy útvonal.
- **A `sync_runs.sources_synced` sosem forrásokat számolt, hanem sessionöket.** A frissesség-jelentés
  hozta elő. Az oszlop marad a történeti értékeivel (oszlopot nem törlünk és nem nevezünk át), az új
  futások a `sessions_seen`-be írnak. Séma verzió 3 → 4.

#### Amit a megőrzés nem tesz

- **Élő promóció bizonyítéka nem törölhető.** Egy promotált emlék állítása az, hogy meg tudja mutatni,
  mikor és milyen kérdésekre jött elő; ha a prune kiürítené a `recall_events`-ét, az állítás hamissá
  válna, miközben az emlék ott marad. Ezért egy `memory_facts`-ban szereplő chunk nyoma korra való
  tekintet nélkül marad, és csak a visszavonás engedi el.
- **A hiányzó forrás alapból nem ok a törlésre** (`missingDays: 0`). Egy fel nem csatolt külső meghajtó
  pontosan úgy néz ki, mint egy véglegesen eltűnt forrás.
- **A `cam forget` az indexből töröl, nem a történelemből.** A beszélgetések fájljai máséi; egy
  következő `cam sync` újraindexeli őket, ha még megvannak.

#### Mérések (referenciagép, 2026-08-29, M4 után)

1 643 session · 32 054 turn · 16 448 chunk · 451 melléktermék · 57,6 MB.

| fázis | M3 | M4 |
|---|---|---|
| kollektorok (mind a hét) | ~320 ms | ~330 ms |
| `resolveFileEvents` | ~20 s | 128 ms |
| `reattribute` | ~4,2 s | ~3,5 s |
| **`cam sync` végig** | **~26 s** | **~4,6 s** |

A szűk keresztmetszet ezzel a `reattribute`-ba került, nem a fájlútvonalakba.

**404 teszt zöld** (293 → 404), `tsc --noEmit` tiszta, `npm run build` OK. Új tesztfájlok:
`test/ops.test.ts` (frissesség, megőrzés, felejtés, vacuum, mentés, hordozhatóság) és
`test/dream.test.ts` (konfiguráció, közlés, gyorsítótár, elszálló és beragadó modell, felejtés).

A lefedettség két ponton **önmagát tartja karban**: a `test/cli.test.ts` minden parancsot meghajt, és
a listája a `SPECS`-hez van kötve, tehát egy később hozzáadott parancs addig buktatja a tesztet, amíg
nincs meghajtva; a `test/mcp.test.ts` pedig a szervertől lekért tool-listát sorolja fel, tehát egy
később regisztrált tool is automatikusan beleesik az index-kor ellenőrzésébe. Az álom CLI-oldala
(mit tagad meg modell nélkül, mit közöl küldés előtt, mit tesz `--quiet` mellett) a
`test/cli.test.ts`-ben van, a fázis maga a `test/dream.test.ts`-ben.

## [0.3.0] — 2026-08-29

Az M1 (első használható állapot), az M1.5 (megszilárdítás), az M2 (telepíthető csomag) és az M3
(memória-réteg) együtt.

### Hozzáadva

- **Váz és adatbázis.** TypeScript/Node ESM projekt (`better-sqlite3`, `vitest`), teljes séma:
  `sources`, `sessions`, `turns`, `chunks`, `chunks_fts`, `path_evidence`, `attribution`,
  `file_events`, `artifacts`, `recall_events`, `sync_runs`. A `chunks_fts` **contentless**
  (`content=''`, `contentless_delete=1`, `unicode61 remove_diacritics 2`), így az invertált index
  létezik, a szöveg nem — ez teszi a „nem duplikálunk" szabályt valóságossá.
- **Platform- és profilfüggetlen tárolóhelyek.** `appSupportDir()` Windows / macOS / Linux alatt old,
  minden út `os.homedir()`-ből és `os.tmpdir()`-ből származik.
- **Projektfelismerés autodetektálással.** Marker-alapú séta (`.git`, `package.json`, `pyproject.toml`,
  `go.mod`, `CMakeLists.txt`, …) a generikus mappanevek átugrásával; a workspace-gyökereket a korpuszból
  tanulja (`detectWorkspaceRoots`); a `projects.root_path` túléli a projekt mozgatását; alias-tábla a
  felhasználó döntéseinek. Semmilyen bedrótozott útvonal vagy profilnév.
- **Inkrementális index.** `sources` vízjeltábla: azonos méret+mtime → nulla olvasás; növekvő fájl →
  olvasás a `bytes_indexed`-től; fix ablakos `prefixHash` különbözteti meg az appendet az újraírástól.
- **Hivatkozás, nem másolat.** A `turns` locatort tárol (fájl+offset, vagy SQLite kulcs), a szöveget a
  `Hydrator` olvassa vissza, és `ok` / `stale` / `missing` állapotot ír vissza.
- **Claude Code kollektor.** Fő és alügynök-átiratok, csak `text` blokkok indexelése, cím `ai-title` /
  `custom-title` rekordokból.
- **Codex kollektor.** `state_5.sqlite` (`threads`, `thread_spawn_edges`) + rollout fájlok;
  másodperc→ezredmásodperc konverzió, hosszkapus címkezelés, `payload.id` alapú azonosítás.
- **Cursor kollektor.** `state.vscdb` fél-nyílt tartomány-lekérdezésekkel; `ofsContent` kulcsokból és a
  bubble-tartalmakból származó projekt-bizonyíték.
- **Cursor fájltörténet kollektor.** `User/History/*/entries.json` → `file_events`, az attribúciós
  idő-korreláció bemenete.
- **CLI:** `cam sync`, `cam projects`, `cam timeline`, `cam doctor`.

### Javítva

- `prefixHash` fix ablakot használ. Korábban a fájl aktuális méretéig hashelt, ezért egy rövid,
  append-only átirat minden hozzáfűzését újraírásnak („rotated") jelezte volna — vagyis minden sync
  teljes újraolvasás lett volna.
- A Claude Code alügynök-átiratok a **szülő** `sessionId`-jét hordozzák minden rekordjukban; az
  azonosító ezért a fájlnévből jön, különben az alügynök beleolvad a szülő sessionbe.
- A projektfelismerés generált mappaneveket (UUID, ≥16 jegyű hex, időbélyeges job-nevek, `codex-runs`,
  `worktrees`) sosem fogad el projektnévnek, és ilyenkor tovább lép felfelé. Nélküle 41 szemét-projekt
  keletkezett a `codex-runs/<hash>` mappákból.
- A tanult workspace-gyökerek átmennek a kizárt prefixek (OS temp, ágens-dotfile-ok) szűrőjén.
- Cursor: a `lastUpdatedAt` nélküli beszélgetések (háttér/cloud szálak) minden futáskor újraolvasódtak;
  most a `composerData` sha256-ja a változásjel — de **csak ha időbélyeg egyáltalán nincs**, mert egy
  bubble szövegének szerkesztése nem változtatja meg a `composerData`-t.
- Az útvonal-kinyerő „lenyelte" a következő szót (Windows útvonalnévben lehet szóköz), így ugyanaz az
  útvonal kétszer szavazott.

- **Cowork kollektor.** `local-agent-mode-sessions` meta + átirat; a projekt a `userSelectedFolders`-ből
  jön, a sandbox `cwd` súlytalan bizonyítékként rögzül.
- **Claude Desktop gazdagítás.** A `cliSessionId` alapján címet ad a cím nélküli Claude Code
  sessionöknek; a helyi átirat nélküli bejegyzések üres sessionként megmaradnak.
- **Melléktermék-kollektor.** Temp-scratchpad és Cowork-kimenetek (múlandó → másolat), `~/.claude/plans`
  tervdokumentumok (stabil → hivatkozás, a sessionhöz a fájlnév-slug alapján kötve).
- **Idő-korrelációs attribúció.** A Cursor fájltörténetből (`file_events`) közepes/gyenge megbízhatóságú
  hozzárendelés azoknak a szálaknak, amelyek egyetlen útvonalat sem említenek.
- **Keresési réteg.** HU/EN stopszavak, prefix-illesztés az agglutináció miatt, dátumszavak
  (`ma`, `tegnap`), hosszőrző ékezet-hajtás, saját kiemelő (a contentless FTS `snippet()`-je NULL).
- **Lekérdezések:** `recall`, `timeline`, `dossier`, `getTurns` — közös rendereléssel a CLI és az MCP
  között. A `recall` naplózza a találatokat (`recall_events`), hogy a későbbi memória-réteg tudjon miből
  promótálni.
- **MCP szerver.** Öt read-only tool (`cam_dossier`, `cam_timeline`, `cam_recall`, `cam_get`,
  `cam_projects`) az SDK `StdioServerTransport`-ján, `InMemoryTransport`-tal tesztelve.
- **Teljes CLI:** `sync`, `projects`, `timeline`, `dossier`, `recall`, `alias`, `attribute`,
  `reattribute`, `doctor`.
- **Dokumentáció:** `docs/architecture.md`, `docs/sources.md`, `docs/mcp.md`.
- **Terv** (`docs/roadmap.md`): mit kell tartalmaznia a projektnek, mérföldkövekre bontva,
  mindegyiknél ellenőrizhető „mikor kész" feltétellel. Tartalmazza a jelenlegi ismert hiányokat
  (M1.5), a kiadás feltételeit (M2), a memória-réteget (M3), az üzemeltetést (M4), az adatvédelmi
  álláspontot, és hogy mely részek alszanak szándékosan.

### Javítva (folytatás)

- A kiemelés elcsúszott minden ékezet után: az NFD-alapú ékezet-eltávolítás megváltoztatja a szöveg
  hosszát, így a folded stringben talált pozíciók nem feleltek meg az eredetinek. Az összehasonlítás
  mostantól **hosszőrző** (karakterenként egy karakter).
- A Cursor bubble-ök nem hordoznak időbélyeget, ezért minden Cursor-turn `ts_ms`-e null volt, és a
  `--since` szűrés rájuk nem működött. A hub nem talál ki turnönkénti időpontot: a chunk időbélyege a
  session kezdetére esik vissza.
- Az azonos promptból ismételten futtatott Codex-sessionök nyolcszor töltötték ki a dosszié „legutóbbi
  témák" listáját; a lista mostantól cím szerint deduplikál.

### Javítva (kód-review nyomán)

Egy review-agent hét megállapítása közül öt valódi, néma hibaosztály volt — mind kapott regressziós
tesztet (`test/regressions.test.ts`):

- **Azonos méretre átírt fájl elveszett.** A „változatlan" gyorsút csak méretet és mtime-ot nézett;
  egy azonos hosszra átírt fájl az mtime granularitásán belül **véglegesen és némán** kimaradt volna.
  A prefix-ablak hash-e most a skip úton is ellenőrződik (egy 4 KiB olvasás).
- **Zsugorodó fájl a vízjel mögé került.** Ha a fájl a vízjel-ellenőrzés és az olvasás között lett
  kisebb, a `readJsonlFrom` „nincs új tartalom"-ot jelzett, a vízjel a kisebb méretre állt, és az
  átírt tartalom soha többé nem került beolvasásra. Most rotációként jelez, és a vízjel nullázódik.
- **Az indexelés és a visszaolvasás nem ugyanazt szűrte.** Indexeléskor csak a `type: "text"` blokkok
  számítottak, visszaolvasáskor a `content[*].text` mutató mindegyiket vitte. A mutató mostantól maga
  hordozza a szűrőt (`content[*type=text].text`), így a kettő nem mondhat mást — különben minden ilyen
  turn tartósan „stale"-nek látszana.
- **A melléktermék-kollektor minden futáskor mindent újraolvasott**, és tervenként végigolvasta az
  összes ismert átiratot (O(tervek × átiratok) teljes fájlolvasás, korlátlanul növekedve). Most
  méret+mtime alapján kihagyja a változatlant, és a terv gazdáját csak egyszer keresi meg.
  Mérve: 8,1 s → 87 ms.
- **Árva FTS-sorok.** A `chunks_fts` contentless, nincs idegen kulcsa; egy `delete from sessions`
  SQLite-on belül kaszkádolt volna a `chunks`-ra, az FTS-sorok megkerülésével. Trigger enforce-olja
  a sémaszinten.
- Kisebbek: az `artifacts.tool` mező írásra került (eddig átadtuk, de sehol nem tárolódott); a
  `cam sync` hibaágon is lezárja az adatbázist; a `claude-desktop` kollektor nem jelenti újnak a már
  ismert sessionöket.

### Hozzáadva (folytatás)

- **Migráció** (`src/db/migrate.ts`): additív, idempotens oszlop-hozzáadás, hogy egy korábbi verzióval
  létrehozott adatbázis is frissüljön. A DDL `IF NOT EXISTS`, tehát új tábla/index/trigger magától
  megjelenik; oszlopot csak ez tud hozzáadni.

### M1.5 — megszilárdítás

Az első használható állapot után a [terv](docs/roadmap.md) M1.5 mérföldköve: a meglévő működés legyen
igaz, tesztelt és üzembiztos.

**Javítva**

- **A CLI nem nyeli le többé a pozicionális argumentumot.** A régi elemző minden `--kapcsoló` után
  elfogyasztotta a következő tokent, ezért a `cam recall --json "kérdés"` nulla pozicionálist látott és
  a súgót írta ki; ugyanígy a `cam timeline --subagents <projekt>`. Az új elemző (`src/args.ts`)
  parancsonként ismeri, melyik kapcsoló vár értéket, kezeli a `--flag=érték` és a `--` formát, és az
  elgépelt kapcsolót **hibaként** jelzi ahelyett, hogy csendben eldobná.
- **A `--limit` mindenhol él**, nem csak a `recall`-ban: a `timeline` nem vág némán 200-nál, a
  `projects` és a `dossier` is figyelembe veszi. A nem szám vagy nulla/negatív érték hiba.
- **Kilépési kódok.** `0` rendben, `1` hiba, `2` hibás használat. A `cam sync` nem nulla kóddal jelez,
  ha egy forrás olvashatatlan volt — enélkül egy ütemezett futás nem tudta észrevenni, hogy elromlott.
  Ismeretlen alparancs is nem nulla kódot ad.
- **A kézi hozzárendelés túléli az újraszámolást.** A `reattribute` a `manual` bizonyíték `raw_path`-ját
  (`~manual:<kulcs>`) útvonalként próbálta feloldani, az pedig semmire nem oldódott — vagyis minden
  `cam attribute` döntés elveszett a következő szinkronnál. A `manual` mostantól — a
  `time_correlation`-höz hasonlóan — maga hordozza a verdiktet. `rule_version` 1 → **2**, tehát a
  `cam doctor` eltérést jelez, és a `cam reattribute` javítja.
- **A séma-frissítés sorrendje.** Az `initSchema` a feltételes DDL *után* migrált, holott a
  `CREATE INDEX IF NOT EXISTS` egy hiányzó oszlopra akkor is elhasal, ha az index feltételes. A migráció
  most a DDL előtt fut (és utána is), és tűri, ha egy tábla még egyáltalán nem létezik.
- **Nem szivárog adatbázis-kapocs.** Sérült fájlon a `new Database()` még sikerül, az első pragma bukik
  el — a kapocs eddig nyitva maradt, és fogva tartotta a fájlt (Windowson törölni sem lehetett).
  Az `openHub` és az `openSourceReadonly` is lezárja a kapcsot, mielőtt tovább dobja a hibát.
- **Hordozhatóság.** A POSIX útvonal-kinyerés `file:///home/...` alakú URI-t is felismer (eddig
  drive-betűt követelt, tehát Linuxon a Cursor-attribúció némán idő-korrelációra esett vissza), és
  több gyökeret ismer (`/mnt`, `/media`, `/data`, `/projects`, …).

**Hozzáadva**

- **`cam rebuild`:** a contentless szövegindex újraépítése a forrásokból. A `sync --repair` erre nem
  képes — az csak azt olvassa újra, ami még nincs indexelve —, egy contentless FTS-index pedig nem
  építhető újra tartalomtáblából. A hiányzó forrású chunk kimarad az indexből és jelentve lesz; a
  részben olvasható chunk bekerül, a hiányzó turnök jelölése nélkül.
- **Párhuzamosság-védelem.** A `sync` és a `rebuild` tanácsadó zárat vesz a `meta` táblában (pid, gép,
  idő). A második futás udvariasan kilép, nem ront bele az elsőbe; az elárvult zár egy óra után vagy a
  folyamat eltűnésével átvehető. A törlés-majd-újratöltés mind a négy helyen egy tranzakcióban van
  (`file_events`, `path_evidence` origó szerint, `workspace_roots`, `collectCwdEvidence`), tehát egy
  közben érkező lekérdezés sosem lát üres táblát.
- **A `cam doctor` sérült adatbázison is lefut.** Integritás-ellenőrzést végez (`quick_check`), és
  megmondja, mi a teendő: szövegindex-hiba → `cam rebuild`, olvashatatlan fájl → mentés és újraszinkron.
  Kiírja az indexelt chunkok számát és az élő sync-zárat is.
- **Verziózott tárolónevek jelzése.** Ha a `~/.codex` létezik, de a `state_5.sqlite` nem (vagy a Cursor
  `User` mappa megvan, de a `state.vscdb` nincs), a kollektor figyelmeztet ahelyett, hogy nulla
  sessiont jelentene.
- **`CAM_HOME` és `CAM_CASE_FOLD`.** Az előbbi a profilkönyvtárat írja felül (a CLI így végigfuttatható
  fixtúra-profilon), az utóbbi az útvonalak kisbetűsítését — ez utóbbi platformfüggő döntés, amitől
  minden tárolt útvonal alakja függ.
- **CI** (`.github/workflows/ci.yml`): Ubuntu, macOS és Windows, Node 22, típusellenőrzés, teszt,
  build, és egy `node dist/cli.js --help` füstteszt.

**Tesztek** — 163 → **255 zöld**, hat új fájllal a terv által megnevezett vakfoltokra:

- `test/cli.test.ts` — a CLI `run()`-on át, kilépési kóddal együtt: kapcsoló-elemzés, `--limit`,
  ismeretlen parancs, zár, `doctor` sérült fájlon, `rebuild`.
- `test/args.test.ts` — az argumentum-elemző önmagában.
- `test/lock.test.ts` — zár, elárvult zár átvétele, idegen gép, garbázs érték.
- `test/attribution.test.ts` — a kaszkád minden lépcsője, a kézi döntés túlélése, az idő-korreláció
  közepes/gyenge útja, az ablak széle, a tanult gyökerek.
- `test/collector-cursor-history.test.ts` — a fájltörténet-kollektor (eddig nulla teszt), a vízjellel és
  a tranzakciós újratöltéssel együtt.
- `test/migrate.test.ts` — régi adatbázis frissítése, adatvesztés nélkül, kétszer futtatva.
- `test/chunker.test.ts` — a túl nagy turn végtelenciklus-őre, az átfedés, a lefedettség.
- Bővítve: `test/query.test.ts` a `recall` megbízhatósági aszimmetriájával (projektszűrő nélkül a
  besorolatlan találat átmegy, a gyenge nem) és a `stale` úttal végponttól végpontig;
  `test/collector-cursor.test.ts` a POSIX útvonalakkal; `test/projkey.test.ts` a hajtás rögzítésével.

### M2 — Kiadható csomag

**Cél volt:** más gépén is telepíthető, önálló eszköz.

- **Licenc:** MIT, `LICENSE` fájlként és `license` mezőként.
- **Csomagolás:** `files` (dist JS + dokumentáció + README/CHANGELOG/LICENSE, semmi más — 41 fájl,
  76 kB), `prepare` script (a `dist/` gitignore-olt, enélkül a gitből telepítés üres csomagot adna),
  `repository`, `author`, `keywords`, `engines`. A **`private: true` szándékosan marad**: a repó privát,
  a kiadási csatorna a git/tarball telepítés, nem a nyilvános registry — a mező csak a véletlen
  `npm publish` ellen véd, a `npm pack`-et és a telepítést nem akadályozza.
- **`cam-mcp` belépéspont:** a `docs/mcp.md` mind a négy klienshez ugyanazt a gépfüggetlen parancsot
  adja (`{"command": "cam-mcp"}`), abszolút útvonal másolgatása nélkül.
- **Az adatbázis alapértelmezett helye a felhasználói adatmappa** — Windowson `LOCALAPPDATA`, máshol
  `XDG_DATA_HOME` (illetve `~/.local/share`). Eddig a telepítési mappa alá írt volna, tehát globális
  telepítésnél a `node_modules`-ba, `npx`-nél pedig két hívás között eldobódott volna az index. Az a
  checkout, amelyikben már van `.data/hub.sqlite`, azt használja tovább.
- **`--db <útvonal>` kapcsoló** minden parancson, és **konfigurációs fájl** (`CAM_CONFIG`, alapból az
  `APPDATA` / `XDG_CONFIG_HOME` alatt). A fájlból a `dbPath`, a `maxInlineBytes` és mind a **tíz
  tárolóhely** felülírható — eddig a `loadConfig` fogadott override-ot, de egyetlen hívó sem adott neki.
  Sorrend: kapcsoló > környezeti változó > konfigurációs fájl > alapértelmezés. A hibás konfigurációs
  fájl figyelmeztetés, nem végzetes hiba.
- **A MCP belépéspont-heurisztikája kijavítva:** fájlnév-egyezés helyett a `process.argv[1]`
  fájl-URL-jének pontos összehasonlítása, tehát egy `server.js` nevű modul importálása nem indít
  véletlenül stdio-szervert. A `cam-mcp` is elfogad `--db` kapcsolót.
- **Angol `README.md`**, a magyar a `README.hu.md`-be került; a `docs/` marad magyarul.
- A MCP-szerver verziója nem sodródhat el a `package.json`-tól: teszt köti össze a kettőt.

**Ellenőrizve tiszta környezetben** (becsomagolt tarball, üres projektbe telepítve): a `cam` és a
`cam-mcp` felkerül a PATH-ra, a `cam --help` lefut, a `cam-mcp` válaszol az `initialize` kérésre, és két
egymás utáni futás **ugyanazt** az indexet látja a felhasználói adatmappában.

**Tesztek:** 255 → **266** (`test/config.test.ts` az útvonal-feloldásra és a precedenciára, `--db` a
CLI-tesztekben, verzió-egyezés a MCP-tesztekben).

### M3 — Memória-réteg

**Cél volt:** a hub ne csak megtalálja a múltat, hanem tanuljon is belőle — modell és hálózat nélkül.
Hogyan működik: [`docs/memory.md`](docs/memory.md).

- **Konszolidáció három menetben** (`src/memory/consolidate.ts`): **Light** összehajtja az előhívási
  nyomot chunkonként (hányszor, hány kérdésre, hány külön napon, milyen átlagos találati pontszámmal);
  **REM** kiszedi a *különböző* kérdésekben visszatérő szavakat — ez a „visszatérő téma"
  determinisztikus megfelelője, összefoglalás és kitalálás nélkül; **Deep** pontoz, kapuz, promotál és
  budgetel.
- **Promóciós pontszám** (`src/memory/score.ts`) a tervben megadott súlyokkal: 0,30 relevancia +
  0,24 gyakoriság + 0,15 diverzitás + 0,15 frissesség + 0,10 konszolidáció + 0,06 fogalmi. A számlálók
  logaritmikusan telítődnek, a frissesség felezési ideje 14 nap. Kapuk: legalább 3 előhívás, legalább
  3 **különböző** kérdés, 0,8 pontszám. A kapu nem váltható ki magas pontszámmal.
- **Felejtés két irányból:** a frissesség elhalványul (a promóció visszavonódik, de a nyom megmarad —
  egyetlen újabb előhívás visszahozza), és a karakter-budget (alapból 200 000) kiejti a legrégebbi
  promóciókat.
- **A promotált emlék sem tárol szöveget.** Chunk-hivatkozás, olvasáskor rehidratálva; ha a forrás
  eltűnt, az emlék ezt kiírja. A „hivatkozás, nem másolat" invariáns a memória-rétegen sem sérül.
- **`cam memory consolidate | list | show <id> | topics | status`** és a hatodik MCP-tool,
  a **`cam_memory`**. A `cam doctor` is jelenti a memória állapotát.
- **A `recall_events` mostantól olvasásra is szolgál** — eddig szándékosan csak gyűlt.

**Új tábla a kérdésekhez.** A `recall_events` csak a kérdés hashét tárolta, márpedig „milyen kérdésekre
jött elő" hash-sel nem mutatható meg. A `memory_queries` a kérdés szövegét és a belőle kiparsolt
szavakat őrzi. Ez **bővíti azt, ami az adatbázisba kerül** (a saját keresési kérdéseid szövegével), és
kikapcsolható: `recall(..., { logQuery: false })` esetén csak a hash marad. A README és a terv
adatvédelmi szakasza ennek megfelelően frissült. Séma verzió 1 → 2.

**Determinizmus.** A promóció kora a nyomból származik (mikor hívtad elő először), nem az órából.
Enélkül egy budget miatt kiesett, majd újra promotált emlék a sor elejére ugrana, és minden futás más
eredményt adna — így viszont ugyanabból az adatbázisból kétszer futtatva ugyanaz jön ki. Tesztelve.

**Mérés a valódi indexen:** a teljes konszolidáció 18 előhívási eseményen és 16 428 chunkon 7–19 ms.
Promóció még nincs: a nyom három kérdésből, egyetlen napról van — a kapuk pontosan ezt szűrik ki.

**Tesztek:** 266 → **293** (`test/memory.test.ts` a pontozásra, a három menetre, a promócióra, a
visszavonásra, a budgetre és a determinizmusra; `test/cli.test.ts` a `cam memory` parancsokra).

### Mérések (referenciagép, 2026-08-29)

Egyetlen, a végállapoton mért táblázat. Az első sync ideje az üres adatbázisból induló futásé.

| | session | turn | első sync | ismételt sync |
|---|---|---|---|---|
| codex | 917 | 15 511 | 37 s | 167 ms |
| cursor | 465 | 9 622 | 42 s | 110 ms |
| claude_code | 54 | 5 987 | 4,2 s | 42 ms |
| claude_desktop | 133 | — (index, turn nélkül) | 0,4 s | 0,4 s |
| cowork | 67 | 785 | 5,8 s | 142 ms |
| **összesen** | **1 636** | **31 922** | | **~320 ms** |

Chunk: 16 414. Melléktermék: 446 fájl. Projekt: 133. Projekthez kötve: 1 381 / 1 636 (84%).

Az „ismételt sync" oszlop a **kollektorok** ideje. A `cam sync` teljes ideje ennél sokkal több, mert az
olvasás után jön az attribúció; fázisonként mérve, változatlan forrásokon:

| fázis | idő |
|---|---|
| kollektorok (mind a hét) | ~320 ms |
| `collectCwdEvidence` + `learnRoots` + `correlateTime` | ~60 ms |
| `resolveFileEvents` (6 064 különböző fájlútvonal feloldása) | ~20 s |
| `reattribute` | ~4,2 s |
| **`cam sync` végig** | **~26 s** |

A korábbi „ismételt teljes sync: ~320 ms" állítás tehát a kollektorokra igaz, a parancsra nem. A
`resolveFileEvents` minden futáskor újra feloldja az összes fájlútvonalat, mert a Cursor-fájltörténet
kollektor naponta újratölti a `file_events` táblát — ennek gyorsítása az M4 tétele.

MCP éles adaton, alproceszként mérve: `cam_projects` 8 ms, `cam_dossier` 8 ms, `cam_recall` 55 ms,
`cam_get` 5 ms, `cam_timeline` 2 ms.

**293 teszt zöld**, `tsc --noEmit` tiszta, `npm run build` OK.
