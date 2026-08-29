# Terv

Mit kell tartalmaznia a projektnek, milyen sorrendben, és mit nem csinálunk.

A mérföldkövek sorrendje kötelezettség: mindegyik lezárja az előzőt, és mindegyiknél ott van, hogy
**mikor kész** — ellenőrizhető feltétellel, nem érzésre. A „Távlati irányok" szakasz ezzel szemben
nem kötelezettség; ott az van, amerre az eszköz mehet, ha érdemes lesz.

Fájlokra név szerint hivatkozunk (modul és függvény), nem sorszámmal — a sorszám hetek alatt elavul,
a név nem.

## Hol tart most

Mért állapot a referenciagépen, 2026-08-29:

| | |
|---|---|
| session | 1 643 |
| turn | 32 054 |
| chunk | 16 448 |
| melléktermék | 451 |
| projekt | 133 |
| projekthez kötve | 1 387 / 1 643 (84%) |
| adatbázis | 57,6 MB |
| teszt | 454 zöld |
| ismételt sync — kollektorok | ~330 ms |
| ismételt sync — végig (attribúcióval) | ~4,6 s |

Részletek: [`CHANGELOG.md`](../CHANGELOG.md). Felépítés: [`architecture.md`](architecture.md).
Üzemeltetés: [`operations.md`](operations.md).

**Kész (M1–M6):** hét kollektor, tizennyolc CLI-parancs, hét MCP-tool, inkrementális index,
projektfelismerés autodetektálással, attribúciós kaszkád, teljes szövegű keresés magyar kezeléssel,
telepíthető csomag, a determinisztikus memória-réteg, a felügyelet nélküli üzem (ütemezés,
frissesség-jelzés, megőrzés, mentés), a bekötés egyetlen paranccsal minden megtalált
ágens-eszközbe, és a nyilvános kiadás három platformon ellenőrzött CI-vel. Ezen felül egyetlen
opcionális, alapból kikapcsolt lépés használ modellt: az álom fázis.

---

## Alapelvek, amik nem változnak

**Hivatkozás, nem másolat.** Egy turn azt tárolja, *hol* van a szövege (fájl + bájt-offset +
JSON-mutató, vagy SQLite-kulcs); a `chunks_fts` contentless. A találatok szövege lekérdezéskor
olvasódik vissza a forrásból, és ha a forrás azóta megváltozott vagy eltűnt, azt a válasz kiírja.

**Nem tippelünk.** Amelyik session projektje nem állapítható meg, `unattributed` marad. Minden verdikt
mellett ott a módszer és a megbízhatóság; a gyenge találatok alapból ki vannak szűrve.

**Nem írunk a forrásokba.** Minden idegen tároló read-only nyílik. Ez nem fegyelem kérdése, hanem
szerkezeti garancia (`openSourceReadonly`).

### Szándékosan alvó részek

Ezek **nem hiányok** — ne „javítsd ki" őket:

- **`chunk_embeddings`** — a tábla létezik, üres. A szemantikus keresésre vár (lásd Távlati irányok).
  Amíg nincs embedding, addig sem tölteni, sem olvasni nem kell.
- ~~**`recall_events`**~~ — már nem alszik: az M3 memória-rétege ebből promótál
  ([`memory.md`](memory.md)). Jól tette, hogy az első naptól gyűlt.

---

## M1.5 — Megszilárdítás ✅

**Cél volt:** ami ma van, az legyen igaz, tesztelt és üzembiztos.

Lezárva. A tételes lista a [`CHANGELOG.md`](../CHANGELOG.md) „M1.5 — megszilárdítás" szakaszában van;
itt csak az marad, ami a mérföldkő feltétele volt:

- `cam recall --json "kérdés"` és `cam timeline --subagents <projekt>` működik — az argumentum-elemzés
  parancsonként tudja, melyik kapcsoló vár értéket (`src/args.ts`), és az elgépelt kapcsoló hiba.
- A `--limit` mind a négy lekérdező parancsban él.
- Kilépési kód: `0` / `1` (hiba) / `2` (hibás használat). Az ütemezett `cam sync` észreveszi, ha
  elromlott.
- Két egyidejű `cam sync` közül a második kilép; a törlés-majd-újratöltés mindenhol tranzakcióban van.
- Sérült adatbázison a `cam doctor` lefut, diagnosztizál, és `cam rebuild`-et javasol. A `cam rebuild` a
  contentless szövegindexet a forrásokból építi újra.
- A README és az `architecture.md` állításai megfelelnek a kódnak; a `turns.inline_text` és a két nem
  használt locator-fajta a típusnál és a sémában is meg van jelölve fenntartottként.
- 255 teszt zöld, köztük a terv által megnevezett vakfoltok: CLI, argumentum-elemző, zár, attribúciós
  kaszkád, Cursor-fájltörténet, migráció, chunker, `recall` megbízhatósági aszimmetriája, `stale` út.
- Az útvonal-hajtás (`CAM_CASE_FOLD`) rögzítve a tesztkészletben, a POSIX útvonal-kinyerés kijavítva,
  a verziózott tárolónév eltűnése figyelmeztet.

**Ami ebből még nyitva van:** a CI (`.github/workflows/ci.yml`) meg van írva, de a
Linux- és macOS-futás csak az első push után igazolható. Amíg nem futott le zölden, a hordozhatóság
állítás, nem tény.

---

## M2 — Kiadás ✅

**Cél volt:** más gépén is telepíthető, önálló eszköz. Részletek a
[`CHANGELOG.md`](../CHANGELOG.md) „M2 — Kiadható csomag" szakaszában.

A mérföldkő feltételei, mérve:

- Becsomagolt tarballból üres projektbe telepítve a `cam` elindul és kiírja a súgót; a `cam-mcp`
  válaszol az `initialize` kérésre.
- Két egymás utáni futás ugyanazt az indexet látja: az alapértelmezett hely a felhasználói adatmappa
  (`LOCALAPPDATA`, illetve `XDG_DATA_HOME`), nem a telepítési mappa.
- `npm pack`: 62 fájl, 147 kB — dist JS, `docs/`, `assets/skill.md`, README(-ek), CHANGELOG, LICENSE.
  Se forrás, se teszt, se source map. (M2-nél 41 fájl, 76 kB; a különbség az M4 és az M5.)
- A dokumentációban nincs másolandó gépspecifikus útvonal. Az M5 óta ez erősebb: az abszolút
  útvonalat nem a felhasználó másolja be, hanem a `cam install` írja oda, arról a gépről, ahol fut.
  A repó egyetlen fájljában sincs valódi felhasználónév, gépspecifikus mappa vagy projektnév — a
  tesztfixtúrák kitalált útvonalakkal dolgoznak.

**Egy szándékos eltérés a tervtől:** a `private: true` **marad**, azután is, hogy a repó nyilvános
lett. A terv a mező megszüntetését írta elő, de az a nyilvános **npm registryre** vonatkozott, nem a
repó láthatóságára. A kiadási csatorna továbbra is a GitHub release és a tarball; a mező így pontosan
egy dolgot csinál, és azt jól: megakadályoz egy véletlen `npm publish`-t. Ha valaha tényleg felmegy a
registryre, ez az egy sor törlendő.

---

## M3 — Memória-réteg ✅

**Cél volt:** a hub ne csak megtalálja a múltat, hanem tanuljon is belőle — modell nélkül.

Kész, a terv szerinti szerkezettel: rövid táv (`recall_events` + `memory_queries`), konszolidáció
(Light → REM → Deep), promóciós pontszám a megadott súlyokkal és kapukkal, hosszú táv karakter-budgettel,
`cam memory` parancsok és `cam_memory` MCP-tool. Hogyan működik: [`memory.md`](memory.md).

A mérföldkő feltételei:

- **Egy promotált tény a bizonyítékával együtt megjeleníthető.** A `cam memory show <id>` kiírja a
  pontszám mind a hat összetevőjét, és soronként azt, hogy melyik kérdés hányszor és mikortól meddig
  hívta elő.
- **A pipeline hálózat nélkül végigfut.** Semmi nem hálózik benne; a valódi indexen 7–19 ms.
- **Ugyanabból az adatbázisból kétszer futtatva ugyanaz a promóció jön ki.** Tesztelve; ehhez a
  promóció kora a nyomból származik, nem az órából — enélkül egy kiesett, majd újra promotált emlék a
  sor elejére ugrana, és a két futás eltérne.

Két dolog, ami menet közben derült ki:

- **A `recall_events` csak a kérdés hasht tárolta**, márpedig „milyen kérdésekre jött elő" hash-sel nem
  megmutatható. Ezért új tábla (`memory_queries`) őrzi a kérdés szövegét és a belőle kiparsolt
  szavakat. Ez bővíti azt, ami az adatbázisban van — lásd az Adatvédelem szakaszt —, és kikapcsolható
  (`logQuery: false`), a hash marad.
- **A 0,8-as kapu szigorúbb, mint amilyennek látszik.** A legkisebb átmenő nyom három kérdés három
  napon, jó találati pontszámmal (0,834). Kis korpuszon a bm25 nem szór, ezért a tesztek a
  referenciagépen mért 0,90–0,93-as relevanciával dolgoznak, nem fixtúrán mérttel.

---

## M4 — Üzemeltetés ✅

**Cél volt:** felügyelet nélkül is használható maradjon. Hogyan üzemeltesd:
[`operations.md`](operations.md). Tételes lista a [`CHANGELOG.md`](../CHANGELOG.md) „M4 —
Üzemeltetés" szakaszában.

A mérföldkő feltételei, mérve:

- **A sync felügyelet nélkül fut, és hibát nem nulla kilépési kóddal jelez.** Ütemezési minta mind a
  négy platformra ([`operations.md`](operations.md)), és `--quiet`, ami hiba esetén beszél, egyébként
  hallgat. A `--quiet` a parancs *válaszát* nem nyeli el — egy `cam recall --json --quiet`, ami
  semmit nem ír ki, csapda lenne.
- **Minden MCP-válasz tartalmazza az index korát.** Nem fegyelemből: a tool-regisztráció egy
  burkolón megy át, tehát nincs mód olyan toolt regisztrálni, amiről lemarad. A hibaválaszokon is
  rajta van. Ellenőrizve valódi stdio-klienssel mind a hét toolon (`scripts/mcp-smoke.ts`).
- **Az adatbázis mérete korlátos: a megőrzési szabály mérhetően fog.** `cam prune` a nyomra, a
  futásnaplóra és az eltűnt forrású sessionökre, `cam prune --vacuum` a helyért, `cam forget` egy
  projektre vagy sessionre. A `--dry-run` ugyanazokat a számokat adja, mint az éles futás.

Öt dolog, ami menet közben derült ki:

- **A `cam recall` hivatkozásait CLI-ból nem lehetett megnyitni.** A `cam_get` MCP-tool megvolt, a
  CLI-párja nem — a keresés fele terminálból zsákutcába vezetett, és ez csak valódi adaton, egy
  „mit beszéltünk erről legutóbb" kérdésnél derült ki, mert a tesztek mindkét felületet külön-külön
  hajtották meg, a kettő közti aszimmetriát nem nézte senki. A `cam get` ezt pótolja; a
  hivatkozás-elemző és a turn-renderelő átkerült a lekérdező rétegbe, hogy a két felület ne
  térhessen el.

- **A `resolveFileEvents` nem a feloldás miatt volt lassú, hanem az írás miatt.** A gyanú a 6 064
  útvonal újra-feloldása volt; a valóság az, hogy a régi kód 6 064 külön `UPDATE`-et adott ki a
  `file_events` táblára, aminek nem volt indexe a `resource` oszlopon — 6 064 teljes tábla-scan
  34 567 soron. Mérve a referenciagép indexén: **14 982 ms → 228 ms**. Az index adja a nagyját, a
  `path_keys` gyorsítótár a maradékot (804 ms → 128 ms a teljes fázisra). Az ismételt sync ezzel
  ~26 s-ról ~4,6 s-ra ment le, amiből ~3,5 s a hozzárendelés — a következő szűk keresztmetszet ott
  van, nem itt.
- **A megőrzés nem törölhet mindent, ami régi.** Egy promotált emlék állítása az, hogy meg tudja
  mutatni, mikor és milyen kérdésekre jött elő. Ha a prune kiürítené a `recall_events`-ét, az
  állítás hamissá válna, miközben az emlék ott marad. Ezért élő promóció bizonyítéka korra való
  tekintet nélkül marad; elengedni csak a visszavonás tudja.
- **A hiányzó forrás nem elég ok a törlésre.** Egy fel nem csatolt külső meghajtó pontosan úgy néz
  ki, mint egy véglegesen eltűnt forrás. A `missingDays` ezért alapból `0`: kikapcsolva.
- **A `sync_runs.sources_synced` sosem forrásokat számolt, hanem sessionöket.** A frissesség-jelentés
  hozta elő. Az oszlop marad (nem törlünk és nem nevezünk át), az új futások a `sessions_seen`-be
  írnak.

**Egy szándékos kiterjesztés a terven túl:** a Távlati irányoknál szereplő betűhajtás-bélyeg
bekerült. A `cam backup` nélküle olyan másolatot ad, ami másik platformon némán semmit nem talál, és
ez pont az a hiba, amit a mentés funkció megjelenése behoz.

---

## M5 — Bekötés ✅

**Cél volt:** ne a felhasználón múljon négy kliens négyféle konfigurációja. Hogyan:
[`install.md`](install.md). Tételes lista a [`CHANGELOG.md`](../CHANGELOG.md) „Telepítés" szakaszában.

Ez a mérföldkő nem volt a tervben, és a helye mégis egyértelmű: az M2 azt érte el, hogy a csomag
más gépére **telepíthető**, nem azt, hogy ott használatba is kerül. A kettő között négy kézzel
szerkesztendő konfigurációs fájl van, és pontosan ott áll meg egy egyébként kész eszköz.

A mérföldkő feltételei, mérve:

- **Egy parancs, és a szerver mind a négy kliensben ott van.** A `--dry-run` ugyanazt a tervet írja
  ki, amit az éles futás végrehajt — ugyanabból a függvényből, nem külön ágból. A második futás
  „unchanged"-et ír, és nem készít újabb mentést.
- **Idegen konfiguráció nem sérül.** Valódi Cursor-konfigurációval mérve: 10 szerver → 11, a
  meglévők és a bennük lévő tokenek változatlanul, mentés a művelet előtt. A Codex TOML-jában a
  csere szövegszintű, tehát a kommentek és a formázás megmaradnak. Sérült konfigurációt nem írunk
  felül: a parancs megnevezi, folytatja a többivel, és `1`-gyel lép ki.
- **A bekötött parancs tényleg elindul.** Ellenőrizve valódi stdio-klienssel, a konfigurációba írt
  parancssorral, mind a hét toolon (`scripts/mcp-smoke.ts`).
- **Az ütemezés nem csak regisztrálódik, hanem le is fut, és a jó indexet írja.** Globális
  telepítésből felvéve, kézzel indítva: `LastTaskResult: 0`, és a futás 205 új turnt írt a
  felhasználói adatmappa indexébe. A második `cam install` „nincs teendő"-t mond; egy másik
  példányból futtatva nem veszi át a feladatot, hanem megnevezi a jelenlegi gazdát és kilép.
  A `cam uninstall` nyom nélkül leszedi.
- **Az álom-modell csak akkor kerül a konfigurációba, ha válaszolt.** A telepítő küld egy rövid
  promptot, és a hibát megnevezve hagyja üresen a beállítást, ha nem jött válasz.

Öt dolog, ami menet közben derült ki:

- **A globálisan telepített CLI semmit nem csinált, és nullával lépett ki.** A belépéspont-vizsgálat
  nyersen hasonlította az `import.meta.url`-t a `process.argv[1]`-hez, a Node viszont az elsőt
  feloldott symlinkekkel adja vissza. Egy Node-verziókezelő pontosan ide tesz linket
  (`C:\nvm\current` → `…\nvm\v22.21.1`), tehát a két érték soha nem egyezett meg. A checkoutból
  minden működött, a telepített példány néma no-op volt — és mivel a kilépési kód nulla, ütemezett
  feladatként ez óránkénti sikeres futásnak látszott, üres eredménnyel. Ez a hiba pontosan a
  telepítéssel jött be használatba, és pontosan azon a felületen, amit a tesztkészlet nem
  hajthatott meg: minden teszt a forrásból importál, ahol nincs symlink az útvonalban.

- **Az `npx`-ből való telepítés nem javítható, csak megtagadható.** A terv belépéspontja az
  `npx github:...` volt, és mindkét lehetséges bejegyzés hazugság onnan: az `npx` az npm
  gyorsítótárába csomagol ki, amit az npm később kitakarít, és a saját `node_modules/.bin`-jét
  teszi a `PATH`-ra a futás idejére. Lemérve: `npm exec` alatt a `_npx/<hash>/node_modules/.bin`
  tényleg ott van a `PATH`-on, tehát egy „a `cam-mcp` elérhető, írjuk be így" döntés pont a
  legrosszabbat választaná. Ez a hibafajta nem a telepítéskor jelentkezik, hanem hetekkel később,
  némán. A telepítő ezért felismeri az ideiglenes csomagmappát, nem ír semmit, és `npm i -g`-t
  javasol. Ugyanez az érv szüntette meg a puszta `cam-mcp` bejegyzést a tartós telepítéseknél is:
  a klienst nem a telepítő shellje indítja.

- **A `PATH` sorrendje rossz döntőbíró.** Egy eszköz kétszer is fent lehet — npm-ből és natív
  kiadásként, más verzióban —, és a fejlesztőgépen épp az elöl álló npm-shim mögötti Codex volt
  hibás. Windowson ráadásul egy npm-es CLI három fájl (`tool`, `tool.cmd`, `tool.ps1`), és egyik sem
  a program: a Node 18.20 óta shell nélkül el sem indítja őket. A keresés ezért végignézi az egész
  `PATH`-t, átolvas az indítókon, és vagy natív futtathatónál, vagy `node <szkript>`-nél köt ki. Nem
  kozmetika: amit ide beírunk, azt később egy ütemezett feladat futtatja, aminek nincs shellje és
  nincs `PATH`-a.
- **Az álom vissza tudná etetni magát.** A Codex és a Claude Code alapból session-fájlt ír, amit a
  `cam` maga is indexel — enélkül a következő szinkron beolvasná az álom-promptokat, a következő
  álom összegezné őket, és az index lassan megtelne a saját tükörképével. Ezért `--ephemeral` és
  `--no-session-persistence` minden olyan sablonban, ahol a `cam`-nek van kollektora az eszközhöz.
  Ugyanez az ok írja elő az eszközhozzáférés kikapcsolását: ezek kódoló ágensek, és magukra hagyva
  fájlokat kezdenek olvasni egy olyan kérdéshez, amihez a szöveget épp a kezükbe adtuk.
- **Az `appSupportDir` a környezeti változót használta a kapott profil helyett.** Az `APPDATA` és az
  `XDG_CONFIG_HOME` a futó folyamat profilját írja le; más home-mal hívva némán ide irányítottak
  vissza. Egy fixture-be irányított telepítés így a valódi Claude Desktop-konfigba írt volna — a
  teszt hozta elő, ami egy üres ideiglenes home-ban is telepítettnek látta a Claude Desktopot.

---

## Az álom fázis — a terven kívül, szándékosan ✅

A terv azt mondta, generatív összefoglaló csak kifejezett opt-innal lehet. Ez az.

Az M3 megindokolta, miért nem modell dönti el, mi kerül a hosszú távú memóriába: a mért hibamód az,
hogy egy LLM-függő pipeline egyszer csak nem termel semmit (a Codex sajátja ezen a gépen 58 jobból
17-nél elhasalt, és július óta áll). Ez az érv a **döntésre** vonatkozik, nem a leírásra. Amit a
determinizmus nem tud megadni, az egy mondat arról, hogy egy előhívott részlet miről szól — a
`cam memory dream` ezt írja meg, és semmi mást nem csinál: nem promotál, nem von vissza, egyetlen
bizonyíték-táblát sem ír. Hogyan: [`memory.md`](memory.md#az-álom-fázis-opcionális).

Amitől ez nem mond ellent a fenti indoklásnak:

- **A mag nem függ tőle.** Ha soha nem futtatod, semmi nem hiányzik; ha elszáll, semmi nem áll meg.
  Minden hiba emlékenként van feljegyezve, a parancs nem nulla kóddal lép ki, és holnap
  újrapróbálható.
- **A modell konfiguráció, nem kód.** Bármilyen parancs jó, ami promptot olvas és szöveget ír, tehát
  modellt cserélni nem fordítás — és nincs beépített szolgáltató, akihez alapból csatlakozna.
- **Az adatvédelmi állítás nem lett gyengébb, csak pontosabb.** A parancs küldés előtt kiírja, hány
  karakter megy ki és hova, `--quiet` mellett is; a `--dry-run` a pontos promptot mutatja, és nem
  indít el semmit.
- **A generált szöveg mindig meg van jelölve.** A modell neve ott van az álommondat mellett a
  `cam memory list`, a `cam memory show` és a `cam_memory` kimenetében is. Származtatott szöveg, ami
  tévedhet, és bármikor eldobható: `cam memory dream forget`.

---

## M6 — Nyilvánosság ✅

**Kész, mert:** a repó nyilvános, mind a három platformon zöld a CI, és a `v0.5.0` release
tarballja mind a háromon feltelepült, mielőtt létrejött.

Ez a mérföldkő nem volt a tervben, mert a projekt egyetlen gépre készült. A nyilvánosság
mindössze két dolgot követel meg, de mindkettőt szigorúan: hogy semmi ne kerüljön ki a szerző
gépéről, és hogy amit kiadunk, arról ne csak reméljük, hogy működik.

**Mérhető feltétel:**

- Nincs a repóban valódi felhasználónév, gépspecifikus útvonal, projektnév vagy adatfájl. Nem
  szemre: a `check-privacy.mjs` minden CI-futásban ellenőrzi, és bukik, ha talál.
- A tag mögötti tarball mind a három platformon feltelepül, és a telepített példány **válaszol**
  (nem csak elindul).
- A csomagban nincs forrás, teszt, source map.
- A verzió a `package.json`-ban, a `SERVER_VERSION`-ben és a changelogban ugyanaz.

**Amit közben megtudtunk:**

- **A denylist önmagát írja ki.** Az első privacy-ellenőrzés a szerző nevére és a valódi
  projektnevekre grepelt. Ez egy nyilvános fájlban pont azokat a karakterláncokat teszi közzé,
  amiket ki akar zárni. A használható változat strukturális: minden home-könyvtár nevének
  **helyőrzőnek kell látszania**. Nem a rossz eseteket sorolja fel, hanem a jó eset alakját írja
  le — így nem évül el, és nem szivárogtat.
- **A working tree kitakarítása nem elég.** A régi commitok diffje ugyanazokat a nyomokat viszi,
  és egy `git grep $(git rev-list --all)` mindet előhozza. Nyolc commitnál a legolcsóbb és
  egyetlen maradéktalan megoldás az új, egyetlen commitból induló nyilvános történet.
- **A `cam --help` nem bizonyít semmit.** Az M5-ben megtalált néma no-op (az entry-point ellenőrzés
  feloldott útvonalat hasonlított feloldatlanhoz) a súgót is átengedte volna. A CI ezért azt kéri
  számon, hogy a `cam status` **kiír-e bármit** — egy nulla kóddal kilépő, néma parancsot csak így
  lehet elkapni.
- **Az `npm link` nem telepítés.** A globális teszt tarballból telepít, mert a `link` és az
  `install -g .` is visszalinkel a checkoutra; egy ilyen „telepítés" arról semmit nem mond, hogy a
  csomag megáll-e a maga lábán.
- **Az első futás három hibát talált, és mind a három olyan platformon volt, amit fejlesztés
  közben nem tudtam futtatni.** Egy Node 24-es natív összeomlás a `better-sqlite3`-ban (11 → 13,
  N-API), egy teszt, ami platformot nézett a beállítás helyett, és egy fixtúra, ami feloldatlan
  tempkönyvtárral dolgozott ott, ahol a `/var` symlink. Egyik sem derült volna ki abból, hogy
  „nálam megy" — ez a mátrix egész indoklása, egyetlen futásban.

---

## Távlati irányok

**Ezek nem kötelezettségek.** Akkor kerülnek sorra, ha a napi használat megkívánja.

- **Szemantikus keresés.** A `chunk_embeddings` erre vár. Rank-fúzió az FTS mellé; a kutatás szerint az
  FTS és vektor hibridje olcsó és gyors (~21 ms 50 ezer chunknál), a gráf-alapú memória viszont drága
  és lassú. Lokális modell vagy szolgáltatás — utóbbi ellentmond a „semmi nem hagyja el a gépet"
  elvnek, ezért csak kifejezett opt-innal.
- **Több gép közti szinkron.** A case-fold bélyeg az M4-gyel bekerült (`meta.path_case_fold`), tehát
  a másolt adatbázis már nem ad némán üres eredményt: a `cam doctor` és a `cam_status` megmondja, mi
  a baj. Ami hiányzik, az a tényleges összefésülés két gép indexe között — az nem másolás, hanem
  konfliktuskezelés.
- **További eszközök**: Gemini CLI, Windsurf, Zed. A kollektor-interfész ehhez készült. A Gemini CLI
  itt két külön dolog: az M5 óta *modellként* felismerjük (álom fázis), de *forrásként* nem — a
  beszélgetéseit nem indexeljük.
- **A melléktermékek bevonása a keresésbe.** Az `artifacts.inline_text` ma 264 sornyi másolt
  scratchpad- és Cowork-tartalmat őriz, amit **semmi nem olvas** — a `cam recall` nem talál bele.

---

## Amit nem csinálunk

- Nem chat-kliens: a hub nem indít és nem folytat beszélgetést.
- Sosem ír a forrás-tárolókba.
- A beszélgetések tartalma nem megy felhőbe.
- Nincs telemetria.

---

## Adatvédelem és megőrzés

Ez az eszköz a felhasználó **teljes beszélgetés-történetét** indexeli, ezért érdemes pontosan tudni,
mi kerül az adatbázisba.

**Ami benne van:** locatorok (fájl és offset, vagy SQLite-kulcs), a teljes szövegű index (contentless
FTS — invertált index, szöveg nélkül), metaadat (címek, időbélyegek, munkakönyvtárak),
projekt-bizonyíték (fájlútvonalak), a múlandó melléktermékek inline másolata, és **a saját keresési
kérdéseid szövege** (`memory_queries`) — az M3 óta, mert a promóció bizonyítékát meg kell tudni
mutatni. Ez utóbbi kikapcsolható: a `recall` `logQuery: false`-szal csak a kérdés hashét írja fel.

**Ami nincs benne:** a beszélgetések szövege. Az a forrásokban marad; a hub csak megtalálja.

**Ami elhagyja a gépet:** alapból semmi; a mag nem hálózik. Egyetlen kivétel van, és az kifejezett
opt-in: a `cam memory dream` a beállított modellnek elküldi a promotált részleteket. Nincs
alapértelmezett modell, a `consolidate` sosem hívja, és a parancs **küldés előtt** kiírja, hány
karakter megy ki és hova — `--quiet` mellett is. Amíg nem állítasz be modellt, ez a mondat úgy igaz,
ahogy le van írva. Részletek: [`memory.md`](memory.md#az-álom-fázis-opcionális).

**Törlés:** az egész index eldobható (`.data/hub.sqlite`), a forrásokat ez nem érinti. Szemcsésen:
`cam forget --project <kulcs>` vagy `cam forget <tool:sessionId>` egy projektet vagy sessiont felejt
el, `cam prune` pedig a régi keresési nyomot és a futásnaplót viszi. Mindkettő csak az indexből
töröl — a beszélgetések fájljai máséi, és egy következő `cam sync` újraindexeli őket, ha még
megvannak. Részletek: [`operations.md`](operations.md).

---

## Ötödik eszköz bekötése

1. Implementáld a `Collector` interfészt (`src/collectors/types.ts`). Minden út, adatbázis-nyitó és óra
   a `CollectorCtx`-en át érkezik — a kollektor sosem hívja közvetlenül az `os.homedir()`-t.
2. Vízjel: fájl alapú forrásnál `classifyFile`, verzió alapúnál `ext_version`. A cél, hogy a
   változatlan forrás nulla olvasásba kerüljön.
3. Locator, ne másolat: a turn a szöveg helyét tárolja, és a `Hydrator`-nak vissza kell tudnia olvasni.
4. Bizonyíték: ha a forrásnak van munkakönyvtára, az a `cwd`; ha nincs, útvonalak a tartalomból
   (`replaceEvidence`).
5. Fixtúra: a tárolót **futásidőben** építsd fel a valódi DDL-lel (lásd `test/helpers/`), ne
   commitolj bináris mintát — így a fixtúra nem sodródhat el az olvasó kódtól.
6. Dokumentáld a formátumot és a buktatóit a [`sources.md`](sources.md)-ben.

---

## Verziózás és migráció

- **SemVer.** A séma és a CLI felülete a szerződés.
- **Séma:** minden DDL feltételes létrehozás, tehát új tábla, index és trigger magától megjelenik.
  Oszlopot csak a `src/db/migrate.ts` tud hozzáadni — additívan és idempotensen. Oszlopot **nem
  törlünk** és nem nevezünk át; ha kell, újat veszünk fel.
- **Attribúció:** a `rule_version` jelzi, ha a kaszkád szabályai változtak. A `cam doctor` kiírja az
  eltérést, és a `cam reattribute` javítja — tároló-olvasás nélkül.
- **Teljes újraindexelés** akkor és csak akkor kell, ha egy locator jelentése változik meg. Ilyenkor a
  `cam sync --repair` a kijelölt út, és a CHANGELOG-ban külön ki kell mondani.
