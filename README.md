# Newsletter Čtu ve městě

Měsíční newsletter pro návštěvníky festivalu. Dvě části:

1. **GitHub Action** (`generator/`) 20. v měsíci vygeneruje návrh obsahu do `polozky.json`.
2. **Apps Script** (`apps-script/`) nad Google tabulkou: souhlas s odběrem, odhlášení, schvalovací stránka a rozesílka.

Člověk jen otevře schvalovací stránku, zkontroluje náhled a odkazy a klikne na odeslání.

> Repozitář musí být **veřejný** (Apps Script si `polozky.json` stahuje z raw adresy) a **nikdy** do něj nepatří e-maily odběratelů, ADMIN_KEY ani API klíče.

---

## Zprovoznění krok za krokem

### A) Google tabulka a Apps Script (cca 30 minut)

1. V Google Workspace vytvoř novou tabulku **„Newsletter – odběratelé“**. Přejmenuj první list na přesně **`Odběratelé`**.
2. Do prvního řádku napiš hlavičku (sloupce A–H):
   `e-mail | jméno | stav | token | žádost odeslána | potvrzeno | odhlášeno | poslední zaslané číslo`
3. Vlož adresy do sloupce A (jméno ve sloupci B je nepovinné). Sloupce C–H nech prázdné, vyplní je skript.
4. V tabulce: **Rozšíření → Apps Script**.
   - Obsah souboru `Code.gs` vlož do výchozího souboru `Code.gs`.
   - Přidej **HTML soubor** (+ → HTML) pojmenovaný přesně `Admin` a vlož do něj obsah `Admin.html`.
   - V **Nastavení projektu** zapni „Zobrazit soubor manifestu appsscript.json“ a přepiš ho obsahem souboru `appsscript.json`.
5. V **Nastavení projektu → Vlastnosti skriptu** přidej:
   | Vlastnost | Hodnota |
   |---|---|
   | `ADMIN_EMAILS` | e-maily, kam mají chodit testy a upomínky (čárkou) |
   | `ADMIN_KEY` | dlouhý náhodný řetězec (aspoň 32 znaků) |
   | `ITEMS_URL` | `https://raw.githubusercontent.com/ctu-ve-meste/newsletter/main/polozky.json` |
   | `WEBAPP_URL` | doplníš v kroku 6 |
6. **Nasadit → Nové nasazení → Webová aplikace**: spouštět jako **já**, přístup **kdokoli**. Zkopíruj adresu končící `/exec` do `WEBAPP_URL`. (Pokud Workspace „kdokoli“ zakazuje, napiš mi, vyřešíme to.)
   Při první autorizaci Google upozorní na neověřenou aplikaci. Je to váš vlastní skript, pokračuj přes „Rozšířené → Přejít na…“.
7. Obnov tabulku. Objeví se menu **Newsletter**:
   1. *Připravit řádky* (nastaví stav „čeká“, tokeny, odfiltruje duplicity a neplatné adresy),
   2. **otestuj na tabulce s 2–3 vlastními adresami**, než pošleš žádost o souhlas všem,
   3. *Poslat žádosti o souhlas* (jednorázově),
   4. *Nainstalovat automatické spouštěče* (odhlášení odpovědí, mazání nepotvrzených po 30 dnech, upomínka 21. v měsíci).

### B) Souhlas (důležité)

- Newsletter chodí **jen ke stavu „odebírá“**, tedy ke každému, kdo klikl na „Chci odebírat“. Nepotvrzení dostanou jen tu jednu žádost a po 30 dnech se smažou.
- Žádost o souhlas pošli **jednou**, ne opakovaně.
- Při registraci na další akce přidejte do formuláře nepovinné zaškrtnutí „Chci dostávat newsletter“ a takové lidi rovnou ukládejte se stavem „odebírá“ a datem potvrzení.
- Nejsem právník. Pokud si nejste jistí, nechte si postup zkontrolovat.

### C) GitHub repo

1. Nahraj obsah této složky do `ctu-ve-meste/newsletter` (včetně skryté složky `.github`).
2. Repo **public**. V *Settings → Actions → General → Workflow permissions* zvol **Read and write permissions**.
3. (Volitelně) AI výběr a text: v *Settings → Secrets and variables → Actions* přidej secret `GEMINI_API_KEY` **nebo** `ANTHROPIC_API_KEY`. Název modelu můžeš přepsat v *Variables* (`GEMINI_MODEL`, `ANTHROPIC_MODEL`), protože se názvy modelů mění a výchozí hodnota může zastarat. Bez klíče běží výběr bez AI (jednoduché šablonové věty).
4. Ověř limity bezplatné úrovně vybrané služby. Do API posíláme jen veřejné údaje o autorech, žádné osobní údaje odběratelů.
5. Poprvé spusť ručně: *Actions → Generate newsletter draft → Run workflow* (volitelně zadej měsíc, např. `2027-01`). Po doběhnutí se v repu objeví `polozky.json` a `kandidati.json`. Varování se zobrazí v souhrnu běhu.

### D) Měsíční provoz

1. Kdykoli předem doplň kavárnu do `generator/data/kafe.json` pro daný měsíc (`"2027-02": { "cas": "...", "misto": "...", "adresa": "...", "odkaz": "...", "popis": "..." }`). Datum se počítá automaticky jako první neděle v měsíci.
2. Novinky z festivalu přidej do `generator/data/festival.json`:
   `{ "mesice": ["2027-02"], "nadpis": "...", "text": "...", "odkaz": "https://..." }`
3. 20. v měsíci Action vygeneruje `polozky.json`. 21. ti přijde e-mail s odkazem.
4. Na schvalovací stránce (`WEBAPP_URL?a=admin&key=ADMIN_KEY`, ulož si ji do záložek) zkontroluj text, **otevři odkazy**, odškrtni, co nechceš, a vyplň případný vzkaz. Pak *Náhled*, *Poslat test mně* a *Odeslat všem*.
5. Zprávy o úmrtí jsou vždy ve výchozím stavu **odškrtnuté**. Zaškrtni je až po ověření ve dvou zdrojích.

### E) Co upravit/ověřit

- `generator/config.json`: práh slávy autorů (`sitelinks_*`), počet položek, `feeds` (seznam RSS ve tvaru `{"nazev": "...", "url": "..."}`). RSS adresy si dohledej a ověř sám.
- `generator/data/kalendar.json`: pevné dny (prázdný `odkaz` se nezobrazí). Datumy a texty zkontroluj.
- Denní limit odesílání e-mailů z Apps Scriptu se liší podle účtu. Aktuální hodnotu ukazuje schvalovací stránka. Při větším počtu odběratelů skript naváže při dalším kliknutí na „Odeslat všem“.
- Wikidata jsou komunitní data. Proto je nutná lidská kontrola a proto je v newsletteru u každé položky odkaz na zdroj.
