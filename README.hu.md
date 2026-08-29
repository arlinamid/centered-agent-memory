# centered-agent-memory (`cam`)

Közös kontextus négy AI kódoló ágens között: **Claude Code**, **Claude Desktop / Cowork**, **Codex** és
**Cursor**. Egyik sem látja a másik beszélgetéseit — a `cam` beolvassa mindegyik meglévő, lemezen lévő
tárolóját, projekthez rendeli a sessionöket, és egyetlen adatbázis-lekérdezéssel megválaszolja, hogy *mi
történt az X projekten*.

CLI-ként és MCP-szerverként is használható.

English: [`README.md`](README.md).

## Alapelvek

**Nem duplikálunk.** Az index a beszélgetés *helyét* tárolja (fájl + bájt-offset, vagy SQLite-kulcs), nem a
szövegét. A találatok szövegét lekérdezéskor olvassuk vissza a forrásból. Kivétel a múlandó anyag — az
OS temp alatti scratchpad és a Cowork kimenetek —, amit a rendszer bármikor törölhet: ezek másolata a
melléktermék-táblába (`artifacts`) kerül. A beszélgetés turnjei mindig hivatkozások, kivétel nélkül.

**Nem tippelünk.** Ha egy session projektje nem állapítható meg biztosan, `unattributed` marad. Minden
hozzárendelés mellett ott van, milyen jel alapján született és milyen megbízhatósággal.

**Nem írunk a forrásokba.** Minden forrás read-only módon nyílik; a `cam` sosem módosítja egyik ágens
tárolóját sem.

**Semmi nem hagyja el a gépet.** A mag nem hálózik, telemetria nincs. Egyetlen opcionális parancs hív
modellt — a `cam memory dream` —, az is csak akkor, ha beállítasz neki egyet, és küldés előtt kiírja,
mi menne ki.

**Gyors ott, ahol számít.** A változatlan források egyetlen `stat` hívással kiesnek: mind a hét
kollektor ellenőrző köre ~330 ms a referenciagépen (1 643 session, 32 054 turn). Egy ismételt `cam
sync` végig ~4,6 s, aminek a nagyobbik fele a hozzárendelés újraszámolása (lásd a
[CHANGELOG](CHANGELOG.md) méréseit). A lekérdezések ettől függetlenül gyorsak: a `cam recall` 55 ms,
a `cam dossier` 8 ms.

**Megmondja, milyen régi.** Minden MCP-válasz utolsó sora az index kora, hogy egy ágens ne idézhessen
hathetes választ frissként. A felügyelet nélküli üzem — ütemezés, frissesség, megőrzés, mentés —
külön leírásban: [`docs/operations.md`](docs/operations.md).

## Telepítés

Node 22 vagy újabb kell. A csomag nincs fent az npm registryn, ezért checkoutból telepíts:

```bash
git clone https://github.com/arlinamid/centered-agent-memory.git
cd centered-agent-memory
npm install                                   # a prepare script lefordítja
npm pack                                      # önálló másolat
npm install -g ./centered-agent-memory-*.tgz  # a `cam` és a `cam-mcp` felkerül a PATH-ra
cam install                                   # bekötés az ágens-eszközökbe
```

A tarball nem formaság: az `npm link` és az `npm install -g .` is a checkoutra **linkel**, nem
másol — a checkout elmozdítása vagy törlése így az imént bekötött klienseket vinné magával.
Tarballból telepítve a checkout eldobható.

A `cam install` beköti a szervert minden megtalált ágens-eszközbe (Claude Code, Claude Desktop,
Codex, Cursor), melléteszi a használati utasítást, ad az álom fázisnak modellt a gépen már meglévő
ágens-CLI-k közül, és beállítja az óránkénti frissítést. Előbb nézd meg, mit csinálna: `--dry-run`.
Részletek és kikapcsolók: [`docs/install.md`](docs/install.md).

**`npx`-ből nem telepíthető, szándékosan.** Az `npx` az npm gyorsítótárába csomagol ki, amit az npm
később kitakarít — az onnan beírt bekötés némán elromlana. A telepítő ezt felismeri, nem ír semmit,
és `npm i -g`-t javasol. Egyszeri lekérdezésre az `npx` jó (az index a felhasználói adatmappában
van, tehát megmarad), bekötésre nem.

Az index a felhasználói adatmappába kerül — Windowson
`%LOCALAPPDATA%\centered-agent-memory\hub.sqlite`, máshol
`$XDG_DATA_HOME/centered-agent-memory/hub.sqlite` (vagy `~/.local/share/...`) —, tehát a globális
telepítés és az ismételt `npx` hívások ugyanazt az indexet látják. Az a checkout, amelyikben már van
`.data/hub.sqlite`, azt használja tovább. Hogy éppen mi az érvényes útvonal, a `cam doctor` kiírja.

Felülírás: `--db <útvonal>` kapcsoló, `CAM_DB` környezeti változó, vagy konfigurációs fájl
(`%APPDATA%\centered-agent-memory\config.json`, illetve
`$XDG_CONFIG_HOME/centered-agent-memory/config.json`; a helyét a `CAM_CONFIG` mozgatja):

```json
{
  "dbPath": "D:/index/hub.sqlite",
  "roots": { "codexStateDb": "D:/codex/state_5.sqlite" }
}
```

A `roots` alatt mind a tíz tárolóhely felülírható. További környezeti változók: `CAM_HOME` a
profilkönyvtárat írja felül (a források innen oldódnak fel), a `CAM_CASE_FOLD=1|0` pedig azt, hogy az
útvonalak kisbetűsen tárolódnak-e — alapból Windowson és macOS-en igen, Linuxon nem.

## Használat

```bash
cam sync                       # források beolvasása (inkrementális)
cam sync --repair              # teljes újraolvasás
cam projects [--unattributed]  # projektek, vagy a be nem sorolt sessionök
cam timeline <projekt>         # idővonal minden eszközből
cam dossier <projekt>          # a projekt teljes képe
cam recall "<kérdés>"          # keresés a beszélgetésekben
cam get <tool:id[#seqN-M]>     # egy hivatkozás mögötti teljes szöveg
cam alias <mappa> <projekt>    # két mappa összevonása egy projektté
cam attribute <tool:id> <proj> # kézi hozzárendelés
cam reattribute                # újraszámolás tároló-olvasás nélkül
cam rebuild                    # szövegindex újraépítése a forrásokból
cam memory <alparancs>         # hosszú távú memória (lásd lent)
cam status                     # mikor szinkronizált utoljára az index
cam doctor                     # állapotjelentés
cam prune [--vacuum]           # megőrzés: régi nyom, futásnapló, eltűnt forrás
cam forget --project <p>       # egy projekt vagy session elfelejtése
cam backup [<fájl>]            # ellenőrzött másolat az indexről
cam install [--dry-run]        # bekötés az ágens-eszközökbe; cam uninstall visszavonja
```

Közös kapcsolók: `--json`, `--since` / `--until`, `--tool <eszköz>`, `--subagents`, `--include-weak`,
`--limit N`, `--db <útvonal>`, `--quiet`, `--verbose`. A `cam sync` szűkíthető egy forrásra:
`--tool claude_code`.

Kilépési kód: `0` rendben, `1` hiba (a `cam sync` így jelzi az olvashatatlan forrást egy ütemezett
futásnak is), `2` hibás használat. Két egyidejű `cam sync` közül a második kilép, nem ront bele az
elsőbe.

A `--quiet` azt jelenti, hogy a parancs hiba esetén beszél, egyébként hallgat — ez kell egy ütemezett
futáshoz. A parancs *válaszát* sosem nyeli el: a `cam recall --json --quiet` kiírja a JSON-t.

Ha az adatbázis megsérül, a `cam doctor` megmondja, mi baja. A `cam rebuild` a **szövegindexet** építi
újra a forrásokból — erre a `cam sync --repair` nem képes, mert az csak azt olvassa újra, amit még nem
indexelt, a contentless FTS-index pedig nem építhető újra magából az adatbázisból.

MCP-szerverként: `cam-mcp` — lásd [`docs/mcp.md`](docs/mcp.md). A bekötést a `cam install` intézi,
lásd [`docs/install.md`](docs/install.md).

Fejlesztés közben build nélkül: `npm run dev -- sync`.

## Felügyelet nélkül

```bash
cam sync --quiet                # óránként
cam memory consolidate --quiet  # naponta
cam prune --quiet               # naponta
```

Ezt a hármat a `cam install` beállítja magától; ez a szakasz azt írja le, mit.

Ütemezési minta Task Schedulerre, launchd-re, systemd timerre és cronra, a megőrzési beállítások, a
mentés és a visszaállítás, és hogy mit tegyél, ha a `cam doctor` panaszkodik:
[`docs/operations.md`](docs/operations.md).

A megőrzés a régi keresési nyomot, a fölös futásnaplót és — csak ha kéred — az eltűnt forrású
sessionöket viszi. Egy szabály felülír mindent: **élő promóció bizonyítéka nem törölhető**, mert egy
promotált emléknek meg kell tudnia mutatni, milyen kérdésekre jött elő.

A `cam forget` az **indexből** töröl, nem a történelemből: a beszélgetések fájljai máséi, azokhoz nem
nyúlunk, tehát egy következő `cam sync` újraindexeli őket, ha még megvannak.

## Memória

A hub abból is tanul, amit keresel — modell nélkül. Egy emlék nem attól lesz hosszú távú, hogy
fontosnak látszik, hanem attól, hogy **többször, több napon, többféle kérdésre** előjött. Minden
keresés nyomot hagy; a konszolidáció összehajtja a nyomot, kiszedi a visszatérő szavakat, és
promotálja, ami átmegy a kapukon (legalább 3 előhívás, legalább 3 különböző kérdés, 0,8 pontszám).

```bash
cam memory consolidate         # a nyomból promóció
cam memory list                # a promotált emlékek
cam memory show <id>           # egy emlék a bizonyítékával
cam memory topics              # visszatérő témák
cam memory status              # mennyi nyom gyűlt eddig
cam memory dream [--dry-run]   # opcionális: egy mondat emlékenként, modelltől
```

Determinisztikus és offline: ugyanabból az adatbázisból kétszer futtatva ugyanaz jön ki. A promotált
emlék sem tárol szöveget — chunk-hivatkozás, olvasáskor rehidratálva. Részletek:
[`docs/memory.md`](docs/memory.md).

Egy lépés opcionálisan mégis modellt használ: a `cam memory dream` egy beállított paranccsal írat egy
mondatot minden promotált részletről. Alapból ki van kapcsolva, a `consolidate` sosem hívja, kiírja
mi menne ki *mielőtt* kimegy, és a generált mondatot mindig a modell nevével együtt mutatja. A
`--dry-run` megmutatja a pontos promptot, és nem küld sehova semmit.

## Mit olvas be

| Eszköz | Forrás | Projekt-kulcs |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` + `<id>/subagents/*.jsonl` | rekordbeli `cwd` |
| Codex | `~/.codex/state_5.sqlite` + a rollout fájlok | `threads.cwd` / `session_meta.cwd` |
| Cursor | `<appdata>/Cursor/User/globalStorage/state.vscdb` | fájlútvonalak a beszélgetésből |
| Cowork | `<appdata>/Claude/local-agent-mode-sessions/**` | `userSelectedFolders` |
| Claude Desktop | `<appdata>/Claude/claude-code-sessions/**` | index + cím |
| Cursor előzmények | `<appdata>/Cursor/User/History/*/entries.json` | idő-korreláció bemenete |

Részletek, formátumok és buktatók: [`docs/sources.md`](docs/sources.md).
Felépítés és séma: [`docs/architecture.md`](docs/architecture.md).

## Fejlesztés

```bash
npm test          # vitest, valódi tárolót egyetlen teszt sem olvas
npx tsc --noEmit  # típusellenőrzés
```

A tesztek fixtúrákat építenek futásidőben (Cursor `state.vscdb`, Codex `state_5.sqlite`) a valódi DDL-lel,
így a fixtúra nem tud elsodródni az olvasó kódtól.

## Állapot és terv

Ami elkészült: [`CHANGELOG.md`](CHANGELOG.md).
Mit kell még tartalmaznia a projektnek, milyen sorrendben, és mit nem csinálunk:
[`docs/roadmap.md`](docs/roadmap.md).

A tesztek Windowson, macOS-en és Linuxon ugyanazt állítják: az útvonal-hajtás a `CAM_CASE_FOLD`
kapcsolóval van rögzítve a `vitest.config.ts`-ben, a CI mindhárom platformon lefut
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

MIT licenc — lásd [`LICENSE`](LICENSE).
