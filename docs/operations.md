# Üzemeltetés

Hogyan fut ez felügyelet nélkül: ütemezés, frissesség, megőrzés, mentés.

Az eszköz akkor ér valamit, ha reggelre magától naprakész. Ez a szakasz azt írja le, hogyan éri el ezt
mind a négy platformon, honnan tudod meg, ha elromlott, és mit kell csinálni azzal, hogy az adatbázis
egyébként örökké nőne.

## A napi futás

Három parancs, ebben a sorrendben. Mindegyik idempotens, és mindegyik önmagában is futtatható.

```bash
cam sync --quiet                # források beolvasása (inkrementális)
cam memory consolidate --quiet  # az előhívási nyomból promóció
cam prune --quiet               # megőrzési szabály
```

A `--quiet` azt jelenti, hogy **hiba esetén beszél, egyébként hallgat** — ez teszi olvashatóvá egy
ütemezett feladat naplóját. Amit a `--quiet` sosem nyel el: a parancs válaszát (a `cam recall --json`
kimenetét például nem) és a hibaüzeneteket.

Kilépési kód a szerződés:

| kód | mit jelent | mit csinálj |
|---|---|---|
| `0` | rendben | semmit |
| `1` | hiba — egy forrás nem volt olvasható, vagy az adatbázis sérült | nézd meg a `stderr`-t, majd `cam doctor` |
| `2` | hibás használat (elgépelt kapcsoló) | javítsd a parancssort |

Egy összeomlott vagy megölt futás nem wedge-eli be a hubot: a zár egy óra után elévül, és két egyidejű
`cam sync` közül a második kilép `0`-val, mert a másik épp elvégzi a munkát.

Mennyi ideig tart: a referenciagépen egy változatlan korpusz ismételt szinkronja ~4,6 s, ebből ~3,5 s a
hozzárendelés. Az első futás egy új gépen ennél sokkal hosszabb.

## Ütemezés

A `cam install` mindezt felveszi magától, a platformnak megfelelő módon — óránkénti szinkron,
éjszakai karbantartás —, és a `cam uninstall` leszedi; lásd [`install.md`](install.md#ütemezés). Az
alábbi receptek azt írják le, mit csinál, és hogyan állítsd be kézzel, ha másképp akarod.

### Windows — Task Scheduler

Óránként, bejelentkezett felhasználóként. Ablak nélkül futtatjuk, mert egy óránként felvillanó
konzolablak fél nap alatt elviselhetetlen:

```powershell
# A cam a PATH-on egy .cmd shim, amit a node nem tud szkriptként futtatni; a
# feladatnak a mögötte lévő JS-t kell megadni. Az útvonalat a cam doctor kiírja.
$cam  = "$env:APPDATA\npm\node_modules\centered-agent-memory\dist\cli.js"
$node = (Get-Command node).Source
$action  = New-ScheduledTaskAction -Execute $node `
           -Argument "`"$cam`" sync --quiet"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
           -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
            -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
            -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "cam-sync" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Centered Agent Memory: beszélgetés-index frissítése"
```

`-StartWhenAvailable` a lényeg: enélkül egy alvó gép kihagyott futása egyszerűen elvész.
`-MultipleInstances IgnoreNew` ugyanazt teszi, amit a hub zárja, csak egy réteggel feljebb.

Ellenőrzés és napló:

```powershell
Get-ScheduledTaskInfo -TaskName "cam-sync"   # LastRunTime, LastTaskResult (0 = rendben)
Start-ScheduledTask   -TaskName "cam-sync"   # futtasd most
```

Napi karbantartás külön feladatként, hajnalra:

```powershell
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$cam`" prune --quiet"
Register-ScheduledTask -TaskName "cam-prune" -Action $action `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 4am) -Settings $settings
```

### macOS — launchd

`~/Library/LaunchAgents/io.github.arlinamid.cam.sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>                <string>io.github.arlinamid.cam.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/cam</string>
    <string>sync</string>
    <string>--quiet</string>
  </array>
  <key>StartInterval</key>        <integer>3600</integer>
  <key>RunAtLoad</key>            <true/>
  <key>StandardErrorPath</key>    <string>/tmp/cam-sync.err</string>
  <key>ProcessType</key>          <string>Background</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.arlinamid.cam.sync.plist
launchctl kickstart -p gui/$(id -u)/io.github.arlinamid.cam.sync   # futtasd most
```

A `cam` teljes útvonalát írd bele: a launchd környezetében nincs shell-profil, tehát nincs `PATH` sem.
`which cam` megmondja, hova települt.

### Linux — systemd timer

`~/.config/systemd/user/cam-sync.service`:

```ini
[Unit]
Description=Centered Agent Memory: beszélgetés-index frissítése

[Service]
Type=oneshot
ExecStart=%h/.local/bin/cam sync --quiet
```

`~/.config/systemd/user/cam-sync.timer`:

```ini
[Unit]
Description=cam sync óránként

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now cam-sync.timer
systemctl --user list-timers cam-sync.timer
journalctl --user -u cam-sync.service -n 50
```

A `Persistent=true` a `-StartWhenAvailable` megfelelője: a kikapcsolt gép alatt kimaradt futás a
következő indításkor bepótlódik.

Ha a gép nem marad bejelentkezve, `loginctl enable-linger $USER` kell hozzá, különben a user-timerek
kilépéskor leállnak.

### Bárhol — cron

```cron
# m  h  dom mon dow  parancs
  17 *  *   *   *    /home/me/.local/bin/cam sync --quiet
  40 4  *   *   *    /home/me/.local/bin/cam memory consolidate --quiet && /home/me/.local/bin/cam prune --quiet
  10 5  *   *   0    /home/me/.local/bin/cam backup --quiet
```

A cronnak minimális `PATH`-a van, ezért teljes útvonalat írj. A `--quiet` miatt csak akkor kapsz
levelet, ha tényleg történt valami — ez a különbség aközött, hogy elolvasod-e a cron-levelet vagy sem.

## Frissesség

A hosszú távú kockázat nem az, hogy az index elromlik, hanem hogy csendben megáll, és az ágens hetekkel
későbbi kérdésekre régi adatból válaszol abban a hitben, hogy friss.

Ezért **minden MCP-válasz utolsó sorában** ott az index kora:

```
— index: 2026-08-29 17:37 UTC (1 perce) · 1643 session · 32054 turn
```

Ha az index a küszöbnél régebbi, a sor `ELAVULT, futtasd: cam sync`-et ír, és a szerver instrukciója
megmondja az ágensnek, hogy ilyenkor szóljon a felhasználónak, ne pedig idézze a régi adatot frissként.
Ugyanez a küszöb hajtja a `cam_status` toolt és a `cam status` parancsot.

```bash
cam status          # mikor futott utoljára, mit tartalmaz
cam status --json   # ugyanaz gépnek: ageMs, stale, errors, unfinished
```

A küszöb alapból 24 óra, a konfigurációs fájlban átállítható:

```json
{ "staleAfterHours": 6 }
```

Egy monitorozó szkriptnek ennyi elég:

```bash
cam status --json | node -e 'process.stdin.on("data",d=>process.exit(JSON.parse(d).stale?1:0))'
```

A kor a `sync_runs` tábla legutóbbi **befejezett** futásából jön, nem a legutóbbi sorból: egy elszállt
futás nem teheti frissnek az indexet. A félbeszakadt futásokat a `cam status` és a `cam doctor` külön
kiírja.

## Megőrzés

Három dolog nőne korlátlanul: az előhívási nyom (`recall_events`, keresésenként több sor), a futásnapló
(`sync_runs`, örökre), és azok a sessionök, amiknek a forrása időközben eltűnt — utóbbiak örökké
„forrás hiányzik" találatként jönnének elő.

```bash
cam prune --dry-run     # mit törölne, egy sor sem törlődik
cam prune               # a megőrzési szabály alkalmazása
cam prune --vacuum      # és a fájlból is add vissza a helyet
```

Alapértelmezés, a konfigurációs fájlban felülírható:

```json
{
  "retention": {
    "recallDays": 365,
    "keepRuns": 500,
    "missingDays": 0
  }
}
```

| beállítás | mit szabályoz |
|---|---|
| `recallDays` | ennél régebbi előhívási esemény törlődik |
| `keepRuns` | ennyi legutóbbi szinkron-futás marad meg a naplóból |
| `missingDays` | ennyi napja hiányzó forrású sessionök törlése; `0` kikapcsolja |

Parancssorból is: `--recall-days`, `--keep-runs`, `--missing-days`.

**Egy szabály felülír mindent: élő promóció bizonyítéka nem törölhető.** Egy promotált emlék állítása
az, hogy meg tudja mutatni, mikor és milyen kérdésekre jött elő; ha a megőrzés kiürítené ezt, az állítás
hamissá válna. Ezért egy `memory_facts`-ban szereplő chunk nyoma korra való tekintet nélkül marad, és
csak a visszavonás (a konszolidáció dolga, nem a prune-é) engedi el.

A `missingDays` azért `0` alapból, mert a forrás hiányozhat azért is, mert egy külső meghajtó nincs
felcsatolva — egy elhamarkodott törlés olyan indexet dobna el, ami magától visszajött volna.

A hely visszaadása külön kapcsoló (`--vacuum`), mert az egész fájlt újraírja, és egy éjszakánkénti
prune-nak nem kell ezt minden alkalommal megfizetnie.

### Egy projekt vagy session elfelejtése

```bash
cam forget --project <kulcs>
cam forget <tool:sessionId>       # ahogy a cam recall hivatkozik rá
cam forget --project <kulcs> --dry-run
```

Ez az **indexből** töröl, nem a történelemből: a beszélgetés fájljai máséi, azokhoz nem nyúlunk, tehát
egy következő `cam sync` újraindexeli őket, ha még megvannak. Ha véglegesen el akarod tüntetni,
a forrást magát kell törölnöd (vagy a `roots` alól kivenned), és utána `cam forget`-elned.

Egy projekt elfelejtése viszi a sessionjeit, a turnjeit, a chunkjait, a szövegindex-sorait és a belőlük
promotált emlékeket is.

## Mentés és költöztetés

```bash
cam backup                    # dátumozott fájl az index mellé, backups/ alá
cam backup /media/nas/hub.sqlite
cam backup --json             # { file, bytes, problems, caseFold }
```

Nem `cp`: WAL módban a legfrissebb írások egy `-wal` oldalfájlban vannak, és egy naiv másolat épp azokat
hagyja el — hibaüzenet nélkül. A `cam backup` az SQLite online backup API-ját használja, utána megnyitja
a másolatot, `quick_check`-eli, és összecsukja a WAL-t, hogy a mentés **egyetlen önálló fájl** legyen.
Ha az ellenőrzés hibát talál, a parancs `1`-gyel lép ki, és nem nevezi mentésnek.

Visszaállítás: másold a helyére (`cam doctor` kiírja, hova), vagy nyisd meg ott, ahol van:
`cam recall "kérdés" --db /media/nas/hub.sqlite`.

**Másik gépre költöztetve figyelj a betűhajtásra.** Windowson és macOS-en az útvonalak kisbetűsítve
tárolódnak, Linuxon betűhelyesen; egy átvitt index emiatt némán semmit nem találna. Az index ezért
megjelöli magát, a `cam doctor` és a `cam_status` pedig összeveti a futó rendszerrel, és megmondja, mit
kell beállítani:

```bash
CAM_CASE_FOLD=1 cam reattribute --db /media/nas/hub.sqlite
```

## Ha valami elromlott

```bash
cam doctor        # integritás, séma, frissesség, hozzárendelés-sodródás, méret
```

| amit kiír | mit tegyél |
|---|---|
| `sérült adatbázis` | ha csak a szövegindex: `cam rebuild`; ha az adatok is: mentsd el a fájlt, töröld, `cam sync` |
| `üres szövegindex` | `cam rebuild` — a forrásokból építi újra |
| `N hozzárendelés régi szabályverzióval` | `cam reattribute` — tároló-olvasás nélkül |
| `az index … készült` (betűhajtás) | `CAM_CASE_FOLD=…`, lásd fent |
| `N félbeszakadt futás` | `cam prune` takarítja a naplót |
| `sync zár él` | egy órán belül elévül; ha nem, a folyamat tényleg fut |

A források egyik esetben sem sérülnek: minden idegen tároló read-only nyílik, és a legrosszabb, ami
történhet, hogy az indexet elölről kell építeni.
