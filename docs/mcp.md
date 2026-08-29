# MCP szerver

A `cam` MCP-szerverként is fut, így mind a négy ágens **ugyanazt** a kontextust kérdezheti le, amit a
CLI mutat — a renderelés közös, a két felület nem sodródhat szét.

Szigorúan **csak olvas**: nincs író tool, és egyik eszköz tárolóját sem módosítja.

## Indítás

A bekötést nem kézzel kell megírni: `cam install` felveszi a szervert minden megtalált kliensbe,
abszolút útvonallal, a meglévő bejegyzések bántása nélkül — lásd [`install.md`](install.md). Ami
alább van, az az, amit az a parancs csinál.

```bash
cam-mcp                       # stdio, JSON-RPC a stdout-on
```

A `cam-mcp` a csomag második belépéspontja (globális telepítés után van a PATH-on).
Checkoutból, telepítés nélkül: `node dist/mcp/server.js`. Fejlesztés közben:
`node --import tsx src/mcp/server.ts`.

Az index helye a `--db <útvonal>` kapcsolóval vagy a `CAM_DB` környezeti változóval állítható; enélkül
ugyanazt az adatbázist nyitja meg, amit a CLI (`cam doctor` kiírja, melyiket).

A `stdout` a JSON-RPC csatorna, ezért minden emberi olvasásra szánt kimenet a `stderr`-re megy.

## Toolok

| tool | mire való |
|---|---|
| `cam_dossier` | egy projekt teljes képe: eszközönkénti számok, időtartomány, legnagyobb sessionök, legutóbbi témák, melléktermékek, forrás-állapot |
| `cam_timeline` | a projekt sessionjei időrendben, minden eszközből, a hozzárendelés módjával |
| `cam_recall` | teljes szövegű keresés, idézhető hivatkozással |
| `cam_get` | egy hivatkozás kibontása teljes szöveggé (CLI-ból: `cam get`) |
| `cam_projects` | az indexelt projektek listája |
| `cam_memory` | a hosszú távú memória: amit több kérdés, több nap alatt többször előhívtál — a promóció bizonyítékával |
| `cam_status` | mikor szinkronizált utoljára az index, mit tartalmaz, megbízható-e |

Hét tool, szándékosan ennyi. Minden további tool mind a négy kliensben, minden kérésnél kontextust
fogyaszt.

A `cam_memory` `id` nélkül a promotált emlékeket listázza (projektre szűrhető), `id`-vel egy emlék
teljes szövegét adja a bizonyítékkal (mikor, milyen kérdésekre jött elő), `topics: true`-val pedig a
visszatérő témákat. Ha üres a válasz, még nem gyűlt elég előhívási nyom — lásd
[`memory.md`](memory.md).

Mindegyik `readOnlyHint: true` annotációval megy, és a hibát tool-hibaként adja vissza, nem
összeomlással.

## Az index kora minden válaszon

Minden tool válaszának utolsó sora megmondja, mikor szinkronizált utoljára az index:

```
— index: 2026-08-29 17:37 UTC (1 perce) · 1643 session · 32054 turn
```

Ha a küszöbnél (alapból 24 óra, `staleAfterHours` a konfigban) régebbi, a sor `ELAVULT, futtasd: cam
sync`-et ír; ha az utolsó szinkron hibázott, azt is. A szerver instrukciója megmondja az ágensnek,
hogy ilyenkor szóljon a felhasználónak, ne pedig idézze a régi adatot frissként.

Ez nem az egyes handlerekben van, hanem a tool-regisztrációt burkoló függvényben: nincs mód olyan
toolt regisztrálni, amiről lemarad — beleértve a hibaválaszokat is, ahol a hiánya a legkevésbé tűnne
fel. Az `npm run smoke` valódi stdio-klienssel ellenőrzi mind a hét toolon, a valódi indexen.

A hosszabb történet — ütemezés, megőrzés, mentés — az [`operations.md`](operations.md)-ben van.

## Bekötés

Mind a négy kliens ugyanazt a parancsot hívja, gépspecifikus útvonal nélkül.

**Claude Code** — `.mcp.json` a projektben, vagy `claude mcp add`:

```json
{
  "mcpServers": {
    "cam": { "command": "cam-mcp" }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json`, ugyanez a blokk.

**Cursor** — `.cursor/mcp.json`, ugyanez a blokk.

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.cam]
command = "cam-mcp"
```

Ha nincs telepítve (csak checkout van), a parancs `node`, az argumentum pedig a
`dist/mcp/server.js` — de akkor az útvonal a te gépedre mutat, és a fenti blokkok nem hordozhatók.

Másik index megnyitása: `{ "command": "cam-mcp", "args": ["--db", "<útvonal>"] }`.

## Ami a válaszokban benne van

Minden találat mellett ott a projekt-hozzárendelés megbízhatósága:

- **strong** — a session munkakönyvtárából vagy a beszélgetésben szereplő fájlútvonalakból
- **medium** — fájlszerkesztési idő-korrelációból, elég bizonyítékkal
- **weak** — ugyanaz, kevés bizonyítékkal; alapból ki van szűrve, `includeWeak` kapcsolóval kérhető
- **none** — nincs hozzárendelés

Ha egy forrás azóta megváltozott (`stale`) vagy eltűnt (`missing`), a válasz ezt kiírja, ahelyett hogy
csendben kihagyná a találatot.

## Miért nem `Content-Length` keretezés

A telecodex `memory-core` LSP-stílusú `Content-Length` keretezést használ a Codex kedvéért. Az MCP
szabvány viszont soralapú JSON-t ír elő, és a `parseMcpFrame` kötelezően fejlécet vár, visszaesés
nélkül — alapértelmezetté téve négyből három klienst törne el. A `cam` az SDK
`StdioServerTransport`-ját használja.
