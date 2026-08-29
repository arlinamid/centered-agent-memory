# Telepítés

Egy parancs, ami az összes megtalált ágens-eszközbe beköti a szervert, mellé teszi a használati
utasítást, ad az álom fázisnak modellt, és beállítja, hogy magától frissüljön.

```bash
cam install
```

Ha a `cam` még nincs a PATH-on: `node dist/cli.js install`. Amint a repó ki van tolva egy távoli
helyre, checkout nélkül is megy: `npx github:arlinamid/centered-agent-memory install`.

**Nézd meg előbb, mit csinálna.** Ez a parancs mások konfigurációs fájljaiba ír és feladatot vesz
fel az ütemezőbe, ezért mindennek van próbája:

```bash
cam install --dry-run
```

A próba ugyanazt a tervet írja ki, amit az éles futás végrehajtana — nem közelítést. Egyetlen fájl
sem módosul, egyetlen modellt sem hívunk meg.

## Mi történik

Négy egymástól független rész, mindegyik külön kikapcsolható és külön jelentve:

| rész | mit csinál | kikapcsolás |
|---|---|---|
| MCP | felveszi a szervert minden megtalált kliens konfigurációjába | `--no-mcp` |
| skill | odateszi a használati utasítást, ahol az eszköz olvassa | `--no-skills` |
| álom | modellt választ a fázishoz egy már telepített ágens-CLI-ból | `--no-dream` |
| ütemezés | óránkénti szinkron, éjszakai karbantartás | `--no-schedule` |

Mindegyik idempotens: a második futás azt írja, hogy nem volt teendő.

**Ami nincs telepítve, azt nem telepítjük.** Egy klienst a saját könyvtára jelent be
(`~/.codex`, `~/.cursor`, `~/.claude`); ha nincs meg, a parancs kihagyja. Egy nem létező eszköz
konfigurációs fájljának megírása így nézne ki: egy `~/.codex`, amit soha egyetlen Codex nem írt.

## Hol lesz az adat

A telepítő **nem mozgat és nem hoz létre indexet** — csak beköti azt, amit a `cam` amúgy is
használna. Hogy melyik az, azt a telepítő az első sorai közt kiírja (`index: ...`), és a
`cam doctor` bármikor megismétli.

| | Windows | macOS / Linux |
|---|---|---|
| index | `%LOCALAPPDATA%\centered-agent-memory\hub.sqlite` | `$XDG_DATA_HOME/centered-agent-memory/hub.sqlite`, alapból `~/.local/share/...` |
| beállítások | `%APPDATA%\centered-agent-memory\config.json` | `$XDG_CONFIG_HOME/centered-agent-memory/config.json`, alapból `~/.config/...` |
| mentések | az index mellett, `backups/` | ugyanaz |

Felhasználói adatmappa, nem a telepítési mappa: egy globális telepítés különben a `node_modules`-ba
írna, egy `npx` futás pedig két hívás között eldobná az indexet.

**Egy kivétel van, és szándékos:** ha a checkoutban már van `.data/hub.sqlite`, a `cam` azt használja
tovább, a felhasználói adatmappa helyett. Enélkül egy `git pull` úgy nézne ki, mintha eltűnt volna az
egész előzmény, mert közben elmozdult az alapértelmezés. Ez fejlesztés közben kényelmes, üzemre
viszont nem az: a checkout törlése vagy áthelyezése az indexet is viszi. Ha ezt nem akarod, mozgasd
át egyszer, és mondd meg, hol van:

```bash
cam backup "%LOCALAPPDATA%\centered-agent-memory\hub.sqlite"   # ellenőrzött másolat
```

Utána töröld a checkout `.data/` mappáját, és a következő futás már a felhasználói adatmappát
találja. Tetszőleges helyre a `config.json` `dbPath` mezőjével, egy futásra a `--db`, illetve a
`CAM_DB` környezeti változóval lehet mutatni.

Az útvonal-döntés sorrendje, az elsőtől: `--db` → `CAM_DB` → `config.json` `dbPath` → a checkout
`.data/hub.sqlite`-ja, ha van → felhasználói adatmappa.

## MCP-bekötés

| kliens | fájl | formátum |
|---|---|---|
| Claude Code | `~/.claude.json` | JSON |
| Claude Desktop / Cowork | `claude_desktop_config.json` az app-adatkönyvtárban | JSON |
| Codex | `~/.codex/config.toml` | TOML |
| Cursor | `~/.cursor/mcp.json` | JSON |

A szerver `cam` néven kerül be, és mindig **abszolút útvonallal** — akkor is, ha a `cam-mcp` éppen
ott van a `PATH`-on. A klienst nem a te shelled indítja: egy dockból indított asztali alkalmazásnak
nincs bejelentkezési `PATH`-a, tehát amit a telepítő shellje megtalál, az semmit nem mond arról,
hogy a kliens mit talál meg. Ha a csomag elmozdul, futtasd újra a `cam install`-t.

**Ideiglenes csomagmappából a telepítő nem ír semmit.** Egy `npx github:...` futás az npm
gyorsítótárába csomagol ki (`_npx/<hash>`), és a saját `node_modules/.bin`-jét teszi a `PATH`-ra a
futás idejére. Onnan mindkét lehetséges bejegyzés hazudik: az abszolút útvonal a gyorsítótár
kitakarításáig él, a puszta `cam-mcp` pedig a folyamat kilépéséig. A parancs ezért felismeri ezt az
esetet, nem ír semmit, és megmondja, mi kell helyette:

```bash
npm i -g centered-agent-memory && cam install
```

A meglévő tartalomhoz nem nyúlunk. A JSON-fájlok a saját behúzásukkal íródnak vissza, a TOML-nál
szövegszinten cseréljük a saját táblánkat, hogy a kommentek és a formázás megmaradjanak. Az első
változtatás előtt biztonsági másolat készül a fájl mellé (`*.cam-backup-<időbélyeg>`).

**Ha egy konfigurációs fájl sérült, nem írjuk felül.** A parancs kiírja, melyik fájl és mi a baj,
a többi klienssel folytatja, és `1`-gyel lép ki. Egy elrontott JSON-t nem lehet biztonságosan
összefésülni, és a kitalálás rosszabb, mint a hibaüzenet.

### Projekt szintű bekötés

```bash
cam install --project
```

Ilyenkor a repóba ír: `.mcp.json` (Claude Code) és `.cursor/mcp.json` (Cursor). Csak ez a kettő,
mert csak ez a kettő olvas repónkénti konfigurációt — a Codex globálisan konfigurálja a szervereit,
a Claude Desktopnak pedig nincs fogalma repóról.

Egyetlen kliensre: `--client claude_code|claude_desktop|codex|cursor`.

## Skill

Az MCP-bekötés attól még nem használja az ágens az indexet: attól használja, hogy tudja, mikor
érdemes. A skill ezt írja le — mikor nyúljon hozzá, milyen sorrendben, hogyan olvassa a
megbízhatósági jelzéseket, és mit ne csináljon.

Egy törzsből készül, kliensenként rendereltve `~/.claude/skills/agent-memory/SKILL.md`,
`~/.codex/skills/…`, `~/.cursor/skills/…` alá. Ami eszközönként eltér, az egyetlen szakasz a végén:
van-e terminál is, vagy csak az MCP-toolok. A Claude Desktop nem kap skillt — nincs hova; oda a
szerver saját instrukciója jut el, minden válasszal.

## Álom-modell

Az [álom fázis](memory.md#az-álom-fázis) az egyetlen rész, amihez modell kell. A telepítő nem
API-kulcsot kér, hanem megnézi, milyen ágens-CLI van már a gépen, és felkínálja őket:

```
álom-modell — melyik eszköz írja az összefoglalókat?
  1) Codex CLI          C:\...\codex.exe
  2) Claude Code        C:\...\claude.exe
  3) Gemini CLI         node C:\...\bundle\gemini.js
  0) egyik se (az álom fázis modell nélkül marad)
```

Utána a modellt is te választod. A listát onnan vesszük, ahonnan hiteles: a Codex a saját
`models_cache.json`-jéből, az Antigravity az `agy models`-ből, a Cursor a `--list-models`-ből, a
Claude a dokumentált aliasaiból (`sonnet`, `opus`, `haiku`, `fable`). A Gemini CLI-nak nincs ilyen
parancsa; ott beírhatod a nevet, vagy üresen hagyhatod, és marad az eszköz alapértelmezettje — ez
utóbbi ritkán rossz választás, és sosem avul el.

Nem interaktív futásnál (szkript, cső) végigpróbálja a talált eszközöket, amíg az egyik nem válaszol.
Konkrétan: `--dream codex --model gpt-5.6-sol`.

**A választás csak akkor kerül a konfigurációba, ha válaszolt.** A telepítő küld egy rövid promptot,
és megvárja a választ. Egy rossz kapcsolóval megírt sablon pontosan úgy néz ki, mint egy működő,
egészen az első éjszakai futásig — ez a harminc másodperc azt a hibát váltja ki egy naplósorra, amit
senki nem olvas el.

Amit a sablonok tartalmaznak, és miért:

- **Nincs eszközhozzáférés** (`-s read-only`, `--tools ""`, `--mode ask`, `--approval-mode plan`).
  Ezek kódoló ágensek: magukra hagyva nekiállnak fájlokat olvasni egy olyan kérdés megválaszolásához,
  amihez a szöveget épp a kezükbe adtuk.
- **Nincs session-mentés** (`--ephemeral`, `--no-session-persistence`) azoknál az eszközöknél,
  amiket a `cam` maga is indexel. Enélkül a következő szinkron beolvasná az álom-promptokat, a
  következő álom összegezné őket, és az index lassan megtelne a saját tükörképével.
- **A prompt a stdin-en megy**, mert egy kivonat több ezer karakter, és annak minden platformon
  rossz helye az argumentumlista.
- **A válasz fájlba**, ahol az eszköz tudja (`codex exec -o`), mert a stdout-on ott a banner és a
  tokenszámláló is.

A modell neve minden elkészült összefoglaló mellé bekerül, tehát egy álom mindig meg tudja mondani,
ki írta.

### A program, nem az indító

A telepítő nem az `előbb-jön-a-PATH-on` alapján választ. Végignézi az egész `PATH`-t és az eszközök
saját telepítési helyeit, átolvas az indítókon — a Windows `.cmd`-shim utolsó sora megmondja, mit
futtatna —, és mindig a valódi programnál köt ki: vagy egy natív futtatható, vagy `node <script>`.

Ennek két oka van. Egy eszköz kétszer is fent lehet, npm-ből és natív kiadásként, más verzióban; a
`PATH` sorrendje rossz döntőbíró (ezen a fejlesztőgépen épp a shim mögötti npm-verzió volt hibás).
A másik: amit ide beírunk, azt később egy ütemezett feladat futtatja, aminek nincs shellje és nincs
`PATH`-a — ott egy abszolút program az egyetlen alak, ami elindul.

## Ütemezés

Az eszköz akkor ér valamit, ha reggelre magától naprakész. A telepítő ezt is felveszi:

| | óránként | naponta 4-kor |
|---|---|---|
| Windows | `cam-sync` feladat | `cam-maintenance` (konszolidáció, majd megőrzés) |
| macOS | `io.github.arlinamid.cam.sync` | `.consolidate` 4:00, `.prune` 4:10 |
| Linux | `cam-sync.timer` | `cam-maintenance.timer` |

Mindhárom platformon be van kapcsolva a kimaradt futás pótlása (`-StartWhenAvailable`,
`Persistent=true`, `RunAtLoad`): egy alvó gép kihagyott szinkronja különben egyszerűen elveszne.

A részletek, a kézi változat és az ellenőrző parancsok: [`operations.md`](operations.md#ütemezés).

Linuxon egy user-timer leáll, amikor kilépsz, hacsak nincs bekapcsolva a lingering — a telepítő
kiírja, ha ez a helyzet: `loginctl enable-linger $USER`.

### Egy csomag, egy ütemezés

A feladatok neve rögzített, tehát két szinkron-feladat nem jöhet létre. Ami létrejöhetne, az
rosszabb: a második telepítés **átvenné** a meglévőt egy másik példány javára, és az előző úgy
nézne ki, mintha telepítve volna, miközben semmi nem fut a nevében. A telepítő ezért megnézi,
kihez tartozik a már regisztrált feladat:

- **ugyanez a példány** — nincs teendő, a második futás nem ír semmit;
- **másik példány** — nem ír, megnevezi a most regisztrált parancsot és a sajátját, és `1`-gyel lép
  ki. Átvétel `--force`-szal, vagy előbb `cam uninstall` a másik példányból.

Ez az a hely, ahol egy fejlesztői checkout és egy globális telepítés összeérne: mindkettő tud
`cam install`-t futtatni, és a különbség csak abban látszik, hogy melyik `cli.js`-t futtatja
óránként a gép.

**A háttérfeladat abszolút útvonalat kap, feloldott symlinkekkel.** Egy Node-verziókezelő mozgó
linket tesz mindkét felébe (`C:\nvm\current\node.exe` és a mellette lévő globális `node_modules`),
és egy óránként futó feladatnak nem attól kell függenie, hogy épp melyik verzió van kiválasztva egy
terminálban. Verzióváltás után futtasd újra a `cam install`-t.

## Ellenőrzés

```bash
cam status          # van-e index, mikor frissült
cam doctor          # integritás, séma, hozzárendelés, méret
```

A kliensekben: indítsd újra az eszközt, és kérdezz rá valamire, amit egy másikkal csináltál. Ha a
szerver bekerült, a válasz utolsó sorában ott lesz az index kora.

Az ütemezés ellenőrzése platformonként:

```powershell
Get-ScheduledTaskInfo -TaskName "cam-sync"          # Windows
```

```bash
launchctl print gui/$(id -u)/io.github.arlinamid.cam.sync   # macOS
systemctl --user list-timers cam-sync.timer            # Linux
```

## Eltávolítás

```bash
cam uninstall --dry-run
cam uninstall
```

Kiveszi a szerver-bejegyzést a konfigurációkból (a többi bejegyzést nem bántja), törli a skilleket,
és leszedi az ütemezett feladatokat.

**Az indexhez nem nyúl.** Azt a `cam forget` üríti szelektíven, vagy magának a fájlnak a törlése —
`cam doctor` megmondja, hol van. Ez szándékos: az eltávolítás a bekötést vonja vissza, nem az
összegyűjtött tudást.
