# Memória-réteg

A hub nem csak megtalálja a múltat, hanem tanul is belőle. Modell nélkül.

Az alapgondolat: **egy emlék nem attól lesz hosszú távú, hogy fontosnak látszik, hanem attól, hogy
többször, több napon, többféle kérdésre előjött.** Ehhez nem kell összefoglaló és nem kell hálózat —
csak az, hogy a keresések nyoma meglegyen az első naptól.

## Mi a nyom

Minden `cam recall` (és minden `cam_recall` MCP-hívás) felírja, mit hozott elő:

| tábla | mi van benne |
|---|---|
| `recall_events` | melyik chunk, melyik kérdésre (hash), milyen pontszámmal, mikor |
| `memory_queries` | maga a kérdés szövege, a belőle kiparsolt szavakkal |

A kérdés **szövege** azért kell, mert a promóció bizonyítékát meg kell tudni mutatni: „ez a három
kérdés hozta elő, ezeken a napokon" — hash-t nem lehet elolvasni. Ha ezt nem akarod, a `recall`
`logQuery: false`-szal csak a hasht írja fel; a mechanizmus akkor is működik, csak a bizonyítékban
hash lesz a kérdés helyén.

## A három menet

A `cam memory consolidate` egyben futtatja mindhármat. Determinisztikus és offline.

**Light** — a nyers előhívási események chunkonként összehajtva: hányszor jött elő, hány különböző
kérdésre, hány külön napon, mekkora átlagos találati pontszámmal. A `memory_traces` tábla mindig
újraszámolható a `recall_events`-ből, nem halmozódik.

**REM** — mely szavak térnek vissza *különböző* kérdésekben. Ez a „visszatérő téma" determinisztikus
megfelelője: a szavak azok, amiket a keresés már úgyis kiparsolt, nincs összefoglalás és nincs
kitalálás. Legalább két különböző kérdés kell hozzá. (`memory_topics`, `cam memory topics`)

**Deep** — pontozás, kapuk, promóció, budget. Ami átmegy, az `memory_facts` sorként hosszú távú
emlék lesz.

## A pontszám

| összetevő | súly | mit mér |
|---|---|---|
| relevancia | 0,30 | mennyire illett rá, a találati pontszámok átlaga |
| gyakoriság | 0,24 | hányszor jött elő (telítődik 10 körül) |
| diverzitás | 0,15 | hány különböző kérdés érte el (telítődik 5 körül) |
| frissesség | 0,15 | mikor kellett utoljára — 14 napos felezési idő |
| konszolidáció | 0,10 | hány *külön napon* jött elő (telítődik 3-nál) |
| fogalmi | 0,06 | hányféle szó vezetett hozzá (telítődik 8-nál) |

A számlálók logaritmikusan telítődnek: a tizedik előhívás kevesebbet ér, mint a második — egyetlen
nagyon aktív részlet így nem tudja kiszorítani az összes többit.

**Kapuk** (a pontszám mellett, nem helyette): legalább 3 előhívás, legalább 3 **különböző** kérdés,
és legalább 0,8 pontszám. A kapu nem váltható ki magas pontszámmal: amit egyetlen kérdés hívott elő
kilencszer, az nem emlék.

A találati pontszám most a forrásban megtalálható különböző keresőkifejezések arányán alapul;
bekapcsolt embedding esetén a koszinuszhasonlóságot is figyelembe veszi. A BM25 azonos pontszámnál
rendez, nem relevancia-valószínűségként szolgál. Az integrációs tesztek kis korpuszon is a tényleges
keresési pontszámokból jutnak el a promócióig, kézi pontszámemelés nélkül. A korábbi pontszámok
megmaradnak; az új számítás az új keresésekre vonatkozik.

A keresésben való megjelenés továbbra sem bizonyítja a tartalom hasznosságát vagy igazságát.
A még soha elő nem hívott fontos döntéseket ez a mechanizmus nem emeli automatikusan emlékké.

Az opcionális embedding parancsa: `cam memory embed --dry-run`, majd `cam memory embed --limit 100`.
A `memory.embedding` beállítás külső embedding parancsot igényel; modellt nem tölt le automatikusan.
A beállítás után a CLI és az MCP keresés is használja a vektorokat. Az álomfázis a gyorsítótárazott
emlékek után folytatja a feldolgozást; a limit az új munkát korlátozza. A beállítás, az adatátadás
és a jelenlegi korlátok részletes leírása az [angol dokumentációban](memory.md#optional-embeddings) található.

## Felejtés

Két irányból:

- **A frissesség elhalványul.** Ugyanaz a nyom 14 naponta feleződő frissesség-taggal előbb-utóbb a 0,8
  alá csúszik, és a promóció visszavonódik. A *nyom* megmarad — egyetlen újabb előhívás visszahozza.
- **Budget.** Alapból 200 000 karakternyi promotált anyag fér el (`--budget`). Ha nem fér, a
  **legrégebbi promóciók** esnek ki előbb.

A promóció kora (`promoted_ms`) a nyomból származik — abból, hogy mikor hívtad elő először —, nem az
órából. Enélkül egy kiesett, majd újra promotált emlék a sor elejére ugrana, és minden futás más
eredményt adna. Így viszont **ugyanabból az adatbázisból kétszer futtatva ugyanaz jön ki.**

## Nem másolat

Egy promotált emlék **nem tárol szöveget**: chunk-hivatkozás, és a szöveg olvasáskor jön vissza a
forrásból, ugyanúgy, mint a keresési találaté. Ha a forrás azóta eltűnt, az emlék ezt kiírja. A
„hivatkozás, nem másolat" invariáns a memória-rétegen sem sérül; a karakter-budget a chunk mért
hosszával számol.

## Parancsok

```bash
cam memory consolidate [--budget N] [--min-score 0..1]   # a teljes menet
cam memory list [--project p] [--limit N] [--json]       # a promotált emlékek
cam memory show <id>                                     # egy emlék + bizonyíték
cam memory topics                                        # visszatérő témák
cam memory status                                        # mennyi nyom gyűlt eddig
cam memory dream [--dry-run] [--force] [--project p]     # összefoglaló modellel (opcionális)
cam memory dream forget                                  # minden álom eldobása
```

MCP-ből ugyanez a `cam_memory` toollal: `id` nélkül lista, `id`-vel egy emlék a bizonyítékkal,
`topics: true`-val a témák.

A `cam memory show` kimenete tartalmazza a pontszám mind a hat összetevőjét és soronként a
bizonyítékot: melyik kérdés, hányszor, mikortól meddig. Egy promóció sosem jelenik meg anélkül, hogy
meg lehetne nézni, mi indokolta.

## Miért nem modell

A generatív összefoglaló opcionális és újrapróbálható lenne — de nem ez a mag. Ennek oka mérhető: a
Codex saját, LLM-függő memória-pipeline-ja ezen a gépen 58 jobból 17-nél elhasalt kontextusablak-hibával,
és július óta nem termel semmit. Ami determinisztikus, az minden reggel lefut.

## Az álom fázis (opcionális)

Az egyetlen hely, ahol modell egyáltalán a közelébe kerül a szövegnek. Amit a determinizmus nem tud
megadni, az egy mondat arról, hogy egy előhívott részlet **miről szól**; a `cam memory dream` ezt írja
meg. Nem promotál, nem von vissza, és egyetlen bizonyíték-táblához sem nyúl — a promóciót továbbra is
a nyom dönti el, nem a vélemény.

Három szabály teszi vállalhatóvá:

1. **Alapból ki van kapcsolva, és a `consolidate` sosem hívja.** Csak a kifejezett `cam memory dream`
   küld ki bármit.
2. **A modell konfiguráció, nem kód.** Bármilyen parancs jó, ami promptot olvas és szöveget ír, tehát
   modellt cserélni nem fordítás:

```json
{ "memory": { "dream": { "provider": "command", "model": "gpt-5",
    "command": ["codex", "exec", "--model", "{model}", "-"] } } }
```

   A prompt a stdin-re megy, hacsak a parancsban nem szerepel `{prompt}` vagy `{promptFile}`.
3. **A kimenet származtatott szöveg.** A bemenet hashével gyorsítótárazva (ugyanazért kétszer nem
   fizetsz), a modell nevével megjelölve, a forrásoktól elkülönítve tárolva — és bármikor eldobható:
   `cam memory dream forget`.

Ami kimegy, azt a parancs **megmondja, mielőtt kimenne**: hány emlék, hány karakter, melyik modellnek.
Ez a sor `--quiet` mellett is megjelenik, mert nem haladásjelzés, hanem közlés. A `--dry-run` ugyanezt
kiírja, plusz az első promptot szó szerint, és nem indít el semmit.

Egy elszálló modell nem viszi magával a futást: minden hiba emlékenként van feljegyezve, a parancs
nem nulla kóddal lép ki, és holnap újrapróbálható. Az álommondat mindenhol a modell nevével együtt
jelenik meg — se a `cam memory list`, se a `cam_memory` nem adhat vissza generált szöveget úgy, hogy
az forrásnak látszik.
