# Korábbi beszélgetések előhívása

A `cam` index a felhasználó **másik AI-eszközeivel** folytatott beszélgetéseiről: Claude Code,
Claude Desktop / Cowork, Codex és Cursor. Csak olvas, egyik eszköz tárolóját sem módosítja.

Ebben a beszélgetésben nem látod, mit csinált a felhasználó tegnap egy másik eszközzel. Az index
látja. Ez a különbség a „nem tudom, kérdezzük meg" és a „megnézem" között.

## Mikor nyúlj hozzá

Kérdezés vagy feltételezés **előtt**:

- Ismeretlen projektben kezdesz dolgozni → `dossier`, mielőtt bármit állítanál róla.
- A felhasználó úgy hivatkozik valamire, mintha tudnád: „ahogy megbeszéltük", „a múltkori
  megoldás", „amit a Codexszel csináltunk" → `recall` a szavaira.
- Azt akarod kérdezni, „csináltuk-e már ezt" vagy „miért így van ez" → először nézd meg.
- Egy döntés indoklása kell, és a kódban nincs benne → `recall`, majd `get` a találatra.

Ne használd, ha a válasz a nyitott fájlokban vagy a repóban ott van. Az index a **múltról** tud,
nem a jelen munkaterületről.

## Munkamenet

1. **`projects`** — melyik projektkulcsokat ismeri az index. A kulcs mappanévből jön, nem
   feltétlenül az, aminek hívod.
2. **`dossier <projekt>`** — eszközönkénti számok, időtartomány, legnagyobb sessionök, legutóbbi
   témák. Egy hívás, és tudod, mi történt eddig.
3. **`recall "<kérdés>"`** — teljes szövegű keresés. Ékezetre érzéketlen (`arvizturo` megtalálja az
   `árvíztűrő`-t), az 5 betűnél hosszabb szavak prefixként illeszkednek, tehát a magyar toldalékolás
   nem akadály. Szűkíts `project`-tel, ha tudod, melyik projektről van szó.
4. **`get <hivatkozás>`** — a találat teljes szövege. A `recall` `tool:sessionId#seqN-M` alakú
   hivatkozást ad; ezt add vissza változtatás nélkül.
5. **`timeline <projekt>`** — időrend, ha az érdekel, mi mikor történt, nem az, hogy mi hangzott el.

A `memory` külön dolog: azt adja vissza, ami a **korábbi kereséseidben** többször, több napon,
többféle kérdésre előjött, a promóció bizonyítékával együtt. Nem összefoglaló, hanem nyom.

## Amit a válaszokból ki kell olvasnod

**Megbízhatóság.** Minden találat mellett ott a projekt-hozzárendelés erőssége: `strong` (a session
munkakönyvtárából vagy a beszélgetésben szereplő útvonalakból), `medium` (fájlszerkesztési
idő-korrelációból), `weak` (ugyanaz, kevés bizonyítékkal, alapból szűrve), `none`. A `medium` és a
`weak` tévedhet — ha egy ilyen találatra hivatkozol, mondd meg, hogy időbeli egybeesés alapján
tartozik a projekthez.

**Forrás-állapot.** Az index hivatkozásokat tárol, nem másolatokat, és a szöveget lekérdezéskor
olvassa vissza. Ha a forrás azóta megváltozott (`stale`) vagy eltűnt (`missing`), a válasz ezt
kiírja. Ne add tovább változatlanként.

**Az index kora.** Minden válasz utolsó sora megmondja, mikor szinkronizált utoljára az index. Ha
`ELAVULT`-ot ír, akkor az azóta folytatott beszélgetések **nincsenek benne**. Ilyenkor mondd meg a
felhasználónak, és javasold a `cam sync`-et — ne idézd a régi adatot frissként.

**Generált mondat.** Ha egy emlék mellett `[modellnév]` jelölésű mondat áll, azt egy modell írta a
részletről, nem a felhasználó mondta. Forrásként ne idézd.

## Idézés

Mindig add meg a hivatkozást, amit a keresés adott, és mondd meg, melyik eszközből és mikorról való:

> A Docker-portot 3000-ről 80-ra a júniusi Cursor-beszélgetésben állítottátok át
> (`cursor:9f2a…#seq12-18`, 2025-06-07).

Ha nincs találat, mondd ki, hogy nincs. Az index hiánya nem bizonyítja, hogy a dolog nem történt meg
— lehet, hogy egy nem indexelt eszközben van, vagy a session projekt nélkül maradt
(`projects --unattributed`).

## Amit ne csinálj

- **Ne írj bele.** Nincs író művelet, és a forrásokat sem szabad módosítani.
- **Ne keresd végig találomra.** Egy `dossier` többet mond három vaktában lőtt `recall`-nál.
- **Ne másold ki tömegével a régi beszélgetéseket a válaszodba.** Hivatkozz, és a lényeget írd le.
- **Ne feltételezd, hogy a felhasználó emlékszik rá.** Ha a múltból idézel, mondd meg, honnan.

{{SURFACE}}
