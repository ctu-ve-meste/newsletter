# Zadání pro scheduled task: AI texty newsletteru

Spouští se každý měsíc 20. po doběhnutí GitHub Action „Generate newsletter draft“ (ta běží v 6:00 UTC, task pusť o hodinu později).
Úkol: přepsat texty ve `polozky.json` do `polozky_claude.json`. Nic jiného nedělej.

## Postup

1. `git pull` na větvi `main`. Přečti `polozky.json` a `kandidati.json`.
2. Zkontroluj, že `mesic` v `polozky.json` je příští měsíc (ten, pro který se číslo připravuje). Pokud ne, nic nepiš a skonči s poznámkou proč.
3. Pro každou položku v `svet_knih`, která má `zahrnout: true` a `typ` jiný než `umrti`, napiš nový `nadpis` a `text` (pravidla níže).
4. Ulož celý obsah `polozky.json` jako `polozky_claude.json` se změnami jen v těchto polích každé upravené položky:
   - `nadpis`, `text` (nové),
   - `wiki_text` nastav na `""` (nový text ho nahrazuje),
   - `podle_wiki` nastav na `true`, jen pokud jsi použil informace z `wiki_uvod` nebo `wiki_dilo`.
   Přidej do kořene `"ai": {"vygenerovano": "RRRR-MM-DD"}`.
   Všechno ostatní (`odkaz`, `zdroj`, `typ`, `zahrnout`, `foto*`, `wiki_odkaz`, `zivotni_data`, `kafe_a_kniha`, `festival`, `vzkaz`, `wiki_uvod`, `wiki_dilo`) zkopíruj beze změny.
5. Ověř, že je výstup platný JSON: `python3 -c "import json;json.load(open('polozky_claude.json'))"`.
6. `git add polozky_claude.json`, commit „AI texty newsletteru RRRR-MM“, `git pull --rebase`, `git push` do `main`.
7. Na konci napiš krátké shrnutí: které položky jsi přepsal a u kterých jsi nechal původní text a proč.

## Pravidla psaní

- Jsi redaktor měsíčního newsletteru čtenářského festivalu Čtu ve městě. Tón: vlídný, hravý, sousedský, česky, bez velkých slov o kultuře, bez politiky a kontroverzí.
- `nadpis`: do 8 slov, nese informaci (ne jen jméno).
- `text`: 2 až 4 věty, vlastními slovy. Čtyři věty jen tehdy, když je v podkladu něco opravdu zajímavého, co by se do tří nevešlo. Kratší je lepší než vycpané.
- Používej **výhradně fakta**, která stojí v položce (`text`, `zivotni_data`), v `wiki_uvod`, v `wiki_dilo` a v odpovídajícím kandidátovi v `kandidati.json`. Nic nedoplňuj z paměti, nic nedomýšlej.
- Uváděj konkrétní knihy, ale jen názvy a roky z `wiki_dilo`. Obsah knih nevyprávěj, pokud to v podkladu výslovně není. České vydání zmiň jen tehdy, když to podklad říká (řádky začínající „česky“).
- Nevymýšlej citáty. Nehodnoť („geniální“, „nejvýznamnější“), pokud to takto není v podkladu.
- Do textu nepatří kontroverze, politické angažmá ani soukromé okolnosti, i kdyby byly v `wiki_uvod`.
- Číslo se rozesílá kolem 21. v měsíci. Události po 21. piš v budoucím čase („uplyne“, „si připomeneme“), události před tímto datem v minulém.
- Pokud pro položku chybí podklad (prázdný `wiki_uvod`), nech původní `nadpis` a `text` beze změny.
- Položky typu `umrti` a položky s `zahrnout: false` nech beze změny.
- Neměň počet položek, jejich pořadí ani žádný odkaz. Apps Script si z AI souboru vezme stejně jen texty a párování dělá podle `odkaz`.
