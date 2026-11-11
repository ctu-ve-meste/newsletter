#!/usr/bin/env python3
"""Vygeneruje polozky.json (návrh newsletteru Čtu ve městě).

Zdroje: pevné soubory v generator/data, Wikidata (výročí a úmrtí spisovatelů),
Nobelova cena (api.nobelprize.org), volitelně RSS. AI (Gemini nebo Claude) je jen redaktor:
dostane seznam kandidátů, vybere a napíše 1-2 věty. Odkazy a zdroje berou vždy z kandidáta,
nikdy z modelu. Bez API klíče běží deterministický výběr.
Pouze standardní knihovna Pythonu.
"""
import datetime as dt
import html as htmllib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEN = ROOT / "generator"
UA = "ctuvemeste-newsletter/1.0 (ctuvemeste.cz@gmail.com)"
MESICE = ["ledna", "února", "března", "dubna", "května", "června", "července",
          "srpna", "září", "října", "listopadu", "prosince"]
WARN = []


def warn(msg):
    print("VAROVÁNÍ:", msg, file=sys.stderr)
    WARN.append(msg)


def load(path, default):
    p = GEN / path
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def http(url, data=None, headers=None, timeout=60):
    h = {"User-Agent": UA}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def target_month():
    env = os.environ.get("MESIC", "").strip()
    if env:
        y, m = map(int, env.split("-"))
        return y, m
    t = dt.date.today()
    return (t.year + 1, 1) if t.month == 12 else (t.year, t.month + 1)


def fmt_date(d, prec):
    if not d:
        return ""
    return f"{d.day}. {MESICE[d.month - 1]} {d.year}" if prec >= 11 else str(d.year)


def life_dates(birth, bp, death, dp):
    b, d = fmt_date(birth, bp), fmt_date(death, dp)
    if b and d:
        return f"{b} – {d}"
    if b:
        return f"nar. {b}"
    return f"úmrtí {d}" if d else ""


def cz_date(d):
    return f"{d.day}. {MESICE[d.month - 1]}"


def parse_date(s):
    try:
        return dt.date.fromisoformat(s[:10])
    except Exception:
        return None  # záporné roky apod.


# ---------- Wikidata ----------

OCC = "wd:Q36180 wd:Q49757 wd:Q6625963 wd:Q214917 wd:Q4853732"  # spisovatel, básník, romanopisec, dramatik, autor dětských knih

SELECT = """
SELECT ?p ?pLabel ?pDescription ?birth ?bp ?death ?dp ?sl ?cs ?en WHERE {{
  VALUES ?occ {{ {occ} }}
  ?p wdt:P106 ?occ .
  {extra}
  ?p wikibase:sitelinks ?sl .
  FILTER(?sl >= {sl})
  OPTIONAL {{ ?p p:P569/psv:P569 [ wikibase:timeValue ?birth ; wikibase:timePrecision ?bp ] }}
  OPTIONAL {{ ?p p:P570/psv:P570 [ wikibase:timeValue ?death ; wikibase:timePrecision ?dp ] }}
  FILTER( {filt} )
  OPTIONAL {{ ?cs schema:about ?p ; schema:isPartOf <https://cs.wikipedia.org/> }}
  OPTIONAL {{ ?en schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "cs,en". }}
}}
"""


def sparql(q):
    url = "https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(q)
    return json.loads(http(url, headers={"Accept": "application/sparql-results+json"}))["results"]["bindings"]


def row_to_person(r, cz):
    g = lambda k: r.get(k, {}).get("value")
    qid = g("p").rsplit("/", 1)[-1]
    birth = parse_date(g("birth")) if g("birth") else None
    death = parse_date(g("death")) if g("death") else None
    bp, dp = int(float(g("bp") or 0)), int(float(g("dp") or 0))
    return {
        "qid": qid,
        "jmeno": g("pLabel"),
        "popis": g("pDescription") or "",
        "birth": birth, "death": death,
        "zd": life_dates(birth, bp, death, dp),
        "sl": int(g("sl") or 0),
        "cz": cz,
        "odkaz": g("cs") or g("en") or f"https://www.wikidata.org/wiki/{qid}",
    }


def wikidata_anniversaries(year, month, cfg):
    filt = f"(BOUND(?birth) && ?bp = 11 && MONTH(?birth) = {month}) || (BOUND(?death) && ?dp = 11 && MONTH(?death) = {month})"
    people = {}
    for cz, extra, sl in (
        (False, "", cfg["sitelinks_svet"]),
        (True, "?p wdt:P27 ?c . VALUES ?c { wd:Q213 wd:Q33946 wd:Q214 }", cfg["sitelinks_cesko_slovensko"]),
    ):
        try:
            for r in sparql(SELECT.format(occ=OCC, extra=extra, sl=sl, filt=filt)):
                p = row_to_person(r, cz)
                if p["jmeno"] and not re.match(r"^Q\d+$", p["jmeno"]):
                    people[p["qid"]] = p
        except Exception as e:
            warn(f"Wikidata (výročí, cz={cz}) selhalo: {e}")
    out = []
    for p in people.values():
        for kind, d in (("narození", p["birth"]), ("úmrtí", p["death"])):
            if not d or d.month != month:
                continue
            diff = year - d.year
            if diff >= cfg["min_vyroci_let"] and diff % cfg["krok_vyroci_let"] == 0:
                out.append({
                    "id": f"{p['qid']}-{kind}",
                    "typ": "vyroci",
                    "jmeno": p["jmeno"], "popis": p["popis"],
                    "udalost": f"{diff} let od {'narození' if kind == 'narození' else 'úmrtí'}",
                    "datum": cz_date(d),
                    "score": p["sl"] + (30 if p["cz"] else 0),
                    "zivotni_data": p["zd"],
                    "zdroj": "Wikidata / Wikipedie", "odkaz": p["odkaz"],
                })
    return out


def wikidata_recent_deaths(cfg):
    today = dt.date.today()
    since = (today - dt.timedelta(days=35)).isoformat()
    filt = f'BOUND(?death) && ?dp = 11 && ?death >= "{since}T00:00:00Z"^^xsd:dateTime'
    people = {}
    for cz, extra, sl in (
        (False, "", cfg["sitelinks_svet"]),
        (True, "?p wdt:P27 ?c . VALUES ?c { wd:Q213 wd:Q33946 wd:Q214 }", cfg["sitelinks_cesko_slovensko"]),
    ):
        try:
            for r in sparql(SELECT.format(occ=OCC, extra=extra, sl=sl, filt=filt)):
                p = row_to_person(r, cz)
                if p["jmeno"] and not re.match(r"^Q\d+$", p["jmeno"]):
                    people[p["qid"]] = p
        except Exception as e:
            warn(f"Wikidata (nedávná úmrtí, cz={cz}) selhalo: {e}")
    return [{
        "id": f"{p['qid']}-umrti-nedavno", "typ": "umrti",
        "jmeno": p["jmeno"], "popis": p["popis"],
        "udalost": "nedávno zemřel/a", "datum": cz_date(p["death"]) if p["death"] else "",
        "score": p["sl"] + (30 if p["cz"] else 0),
        "zivotni_data": p["zd"],
        "zdroj": "Wikidata / Wikipedie", "odkaz": p["odkaz"],
    } for p in people.values() if p["death"]]


# ---------- Nobelova cena ----------

NOBEL_Q = """
SELECT ?p ?pDescription ?birth ?bp ?death ?dp ?cs ?en WHERE {{
  ?p wdt:P166 wd:Q37922 ; rdfs:label "{name}"@en .
  OPTIONAL {{ ?p p:P569/psv:P569 [ wikibase:timeValue ?birth ; wikibase:timePrecision ?bp ] }}
  OPTIONAL {{ ?p p:P570/psv:P570 [ wikibase:timeValue ?death ; wikibase:timePrecision ?dp ] }}
  OPTIONAL {{ ?cs schema:about ?p ; schema:isPartOf <https://cs.wikipedia.org/> }}
  OPTIONAL {{ ?en schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "cs,en". }}
}} LIMIT 1
"""


def find_person_by_name(name):
    """Dohledá nositele Nobelovy ceny za literaturu: Wikidata, pak přímo Wikipedie."""
    try:
        rows = sparql(NOBEL_Q.format(name=name.replace("\\", "\\\\").replace('"', '\\"')))
        if rows:
            r = dict(rows[0])
            r["p"] = r.get("p", {"value": "x/Q0"})
            g = lambda k: r.get(k, {}).get("value")
            birth = parse_date(g("birth")) if g("birth") else None
            death = parse_date(g("death")) if g("death") else None
            return {"popis": g("pDescription") or "",
                    "zd": life_dates(birth, int(float(g("bp") or 0)), death, int(float(g("dp") or 0))),
                    "wiki": g("cs") or g("en") or ""}
    except Exception as e:
        warn(f"Wikidata (nositel Nobelovy ceny {name}) selhalo: {e}")
    for lang in ("cs", "en"):                       # záloha: stránka na Wikipedii podle jména
        try:
            title = urllib.parse.quote(name.replace(" ", "_"))
            sm = json.loads(http(f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}"))
            if re.search(r"spisovat|básn|poet|writer|novelist|dramat", sm.get("extract", ""), re.I):
                return {"popis": "", "zd": "", "wiki": f"https://{lang}.wikipedia.org/wiki/{title}"}
        except Exception:
            continue
    return None


def nobel(year, month):
    if month not in (10, 12):
        return []
    try:
        data = json.loads(http(f"https://api.nobelprize.org/2.1/nobelPrize/lit/{year}"))
        prizes = data if isinstance(data, list) else data.get("nobelPrizes", data)
        names = []
        for pr in prizes:
            for l in pr.get("laureates", []):
                kn = l.get("knownName") or l.get("fullName") or {}
                names.append(kn.get("en") or kn.get("se") or "")
        out = []
        for i, name in enumerate([n for n in names if n]):
            info = find_person_by_name(name) or {"popis": "", "zd": "", "wiki": ""}
            if not info["wiki"]:
                warn(f"Nobelova cena: k laureátovi {name} se nepodařilo najít stránku na Wikipedii.")
            out.append({
                "id": f"nobel-{year}-{i}", "typ": "ocenění",
                "jmeno": name, "popis": info["popis"], "udalost": f"Nobelova cena za literaturu {year}",
                "datum": "", "score": 1000, "zivotni_data": info["zd"], "wiki_url": info["wiki"],
                "zdroj": "nobelprize.org", "odkaz": f"https://www.nobelprize.org/prizes/literature/{year}/summary/",
            })
        return out
    except Exception as e:
        warn(f"Nobelova cena: nic nenalezeno nebo chyba ({e}).")
        return []


# ---------- RSS ----------

def rss(feeds):
    out = []
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)
    for f in feeds:
        try:
            root = ET.fromstring(http(f["url"]))
            for it in root.iter("item"):
                title = (it.findtext("title") or "").strip()
                link = (it.findtext("link") or "").strip()
                pub = it.findtext("pubDate") or ""
                try:
                    from email.utils import parsedate_to_datetime
                    d = parsedate_to_datetime(pub)
                    if d.tzinfo is None:
                        d = d.replace(tzinfo=dt.timezone.utc)
                    if d < since:
                        continue
                except Exception:
                    pass
                if title and link:
                    out.append({"id": f"rss-{abs(hash(link)) % 10**8}", "typ": "novinka", "jmeno": "", "popis": "",
                                "udalost": title, "datum": "", "score": 5,
                                "zdroj": f.get("nazev", ""), "odkaz": link})
        except Exception as e:
            warn(f"RSS {f.get('nazev', f.get('url'))} selhalo: {e}")
    return out


# ---------- pevný kalendář a festival ----------

def calendar_items(month):
    out = []
    for i in load("data/kalendar.json", []):
        if int(i["den"].split("-")[0]) == month:
            out.append({"typ": "den", "nadpis": i["nadpis"], "text": i["text"],
                        "zdroj": "", "odkaz": i.get("odkaz", ""), "zahrnout": True})
    return out


def festival_items(ym):
    return [{"nadpis": i["nadpis"], "text": i["text"], "zdroj": "", "odkaz": i.get("odkaz", ""), "zahrnout": True}
            for i in load("data/festival.json", []) if ym in i.get("mesice", [])]


# ---------- Wikipedie: krátký výtah a fotka (jen volné licence) ----------

FREE_LIC = re.compile(r"^(CC0|Public domain|PD\b|CC BY(-SA)? \d)", re.I)


def trim_extract(t, limit=350):
    t = re.sub(r"\s*\([^()]*\d{4}[^()]*\)", "", t, count=1)      # závorka s daty narození a úmrtí
    t = re.sub(r"\s+", " ", t).strip()
    if len(t) <= limit:
        return t
    cut = -1
    for m in re.finditer(r"[^\d\s]\. ", t[:limit]):                 # konec věty, ne "4. prosince"
        cut = m.end() - 1
    if cut > 120:
        return t[:cut].strip()
    return t[:limit].rsplit(" ", 1)[0] + "…"


def commons_photo(thumb_url):
    m = re.search(r"/wikipedia/commons/(?:thumb/)?[0-9a-f]/[0-9a-f]{2}/([^/]+)", thumb_url or "")
    if not m:
        return None
    fname = urllib.parse.unquote(m.group(1))
    api = ("https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=extmetadata&titles=File:"
           + urllib.parse.quote(fname))
    data = json.loads(http(api))
    page = next(iter(data["query"]["pages"].values()))
    em = page["imageinfo"][0]["extmetadata"]
    lic = em.get("LicenseShortName", {}).get("value", "")
    if not FREE_LIC.match(lic) or re.search(r"NC|ND", lic):
        return None
    artist = htmllib.unescape(re.sub(r"<[^>]+>", "", em.get("Artist", {}).get("value", ""))).strip()
    artist = (artist[:80] + "…") if len(artist) > 80 else artist
    return {"foto": thumb_url,
            "foto_popisek": f"Foto: {artist or 'autor neuveden'}, {lic} (Wikimedia Commons)",
            "foto_odkaz": "https://commons.wikimedia.org/wiki/File:" + urllib.parse.quote(fname)}


def wiki_enrich(item):
    url = item.get("wiki_url") or item.get("odkaz", "")
    m = re.match(r"https://(cs|en)\.wikipedia\.org/wiki/(.+)$", url)
    if not m:
        return
    lang, title = m.groups()
    try:
        sm = json.loads(http(f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}"))
    except Exception as e:
        warn(f"Wikipedie (výtah) selhala pro {item['nadpis']}: {e}")
        return
    if lang == "cs" and sm.get("extract"):
        item["wiki_text"] = trim_extract(sm["extract"])
        item["wiki_odkaz"] = url
    try:
        ph = commons_photo((sm.get("thumbnail") or {}).get("source"))
        if ph:
            item.update(ph)
    except Exception as e:
        warn(f"Wikimedia Commons (licence fotky) selhala pro {item['nadpis']}: {e}")


# ---------- výběr: bez AI ----------

def plain_text(c):
    popis = re.sub(r"\s*\([^)]*\)\s*$", "", c["popis"] or "").strip()   # bez závorky s roky
    head = f"{c['jmeno']}, {popis}" if popis else c["jmeno"]
    tail = c["udalost"] + (f" ({c['datum']})" if c["datum"] else "")
    return f"{head}: {tail}."


def pick_plain(cands, n):
    out = []
    for c in sorted(cands, key=lambda c: -c["score"]):
        if c["typ"] in ("vyroci", "ocenění") and len([o for o in out if o["zahrnout"]]) < n:
            out.append({"typ": c["typ"], "nadpis": c["jmeno"], "text": plain_text(c),
                        "zivotni_data": c.get("zivotni_data", ""), "wiki_url": c.get("wiki_url", ""),
                        "zdroj": c["zdroj"], "odkaz": c["odkaz"], "zahrnout": True})
    return out


# ---------- výběr: s AI ----------

PROMPT = """Jsi redaktor měsíčního newsletteru čtenářského festivalu Čtu ve městě. Tón: vlídný, hravý, sousedský, česky, bez velkých slov o kultuře, bez politiky a kontroverzí.
Z níže uvedených kandidátů vyber nejvýše {n} nejzajímavějších pro čtenáře (kandidáty typu "umrti" můžeš vybrat navíc, nepočítají se do limitu). U každého napiš nadpis (do 8 slov) a text (1-2 věty, vlastními slovy).
PRAVIDLA: používej výhradně fakta uvedená v kandidátovi, nic nedomýšlej ani nedoplňuj z paměti. Nevymýšlej citáty. U úmrtí neutrální, důstojný tón.
Vrať jen JSON: {{"vybrane":[{{"id":"...","nadpis":"...","text":"..."}}]}}

KANDIDÁTI:
{cands}
"""


def call_ai(prompt):
    gk, ak = os.environ.get("GEMINI_API_KEY"), os.environ.get("ANTHROPIC_API_KEY")
    if gk:
        model = os.environ.get("GEMINI_MODEL") or "gemini-2.5-flash"
        body = json.dumps({"contents": [{"parts": [{"text": prompt}]}],
                           "generationConfig": {"responseMimeType": "application/json", "temperature": 0.3}}).encode()
        res = json.loads(http(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gk}",
                              data=body, headers={"Content-Type": "application/json"}))
        return res["candidates"][0]["content"]["parts"][0]["text"]
    if ak:
        model = os.environ.get("ANTHROPIC_MODEL") or "claude-haiku-5-5"
        body = json.dumps({"model": model, "max_tokens": 1500, "messages": [{"role": "user", "content": prompt}]}).encode()
        res = json.loads(http("https://api.anthropic.com/v1/messages", data=body,
                              headers={"Content-Type": "application/json", "x-api-key": ak,
                                       "anthropic-version": "2023-06-01"}))
        return "".join(b.get("text", "") for b in res["content"])
    return None


def pick_ai(cands, n):
    if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")):
        return None
    slim = [{k: c[k] for k in ("id", "typ", "jmeno", "popis", "udalost", "datum")} for c in cands]
    try:
        raw = call_ai(PROMPT.format(n=n, cands=json.dumps(slim, ensure_ascii=False, indent=1)))
        raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.M).strip()
        sel = json.loads(raw)["vybrane"]
    except Exception as e:
        warn(f"AI výběr selhal, použit výběr bez AI: {e}")
        return None
    byid = {c["id"]: c for c in cands}
    out = []
    for s in sel:
        c = byid.get(s.get("id"))
        if not c or not s.get("nadpis") or not s.get("text"):
            continue
        out.append({"typ": c["typ"], "nadpis": s["nadpis"].strip(), "text": s["text"].strip(),
                    "zivotni_data": c.get("zivotni_data", ""), "wiki_url": c.get("wiki_url", ""),
                    "zdroj": c["zdroj"], "odkaz": c["odkaz"],            # zdroj a odkaz vždy z kandidáta
                    "zahrnout": c["typ"] != "umrti"})                     # úmrtí vždy ručně odškrtnout
    return out or None


# ---------- main ----------

def main():
    cfg = load("config.json", {})
    year, month = target_month()
    ym = f"{year}-{month:02d}"
    print("Měsíc:", ym)

    cands = wikidata_anniversaries(year, month, cfg) + wikidata_recent_deaths(cfg) + nobel(year, month) + rss(cfg.get("feeds", []))
    (ROOT / "kandidati.json").write_text(json.dumps(cands, ensure_ascii=False, indent=2), encoding="utf-8")

    svet = calendar_items(month)
    chosen = pick_ai(cands, cfg.get("max_polozek", 3))
    if chosen is None:
        chosen = pick_plain(cands, cfg.get("max_polozek", 3))
        # úmrtí v režimu bez AI nezařazujeme automaticky
    for it in chosen:
        wiki_enrich(it)
    svet += chosen

    kafe = load("data/kafe.json", {}).get(ym)
    kafe = kafe or {"cas": "", "misto": "", "adresa": "", "odkaz": "", "popis": ""}  # kavárnu se vyplňuje na schvalovací stránce
    kafe = dict(kafe, datum="")  # prázdné datum = první neděle v měsíci, spočítá Apps Script

    out = {"mesic": ym, "kafe_a_kniha": kafe, "festival": festival_items(ym), "svet_knih": svet, "vzkaz": ""}
    (ROOT / "polozky.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Hotovo: {len(svet)} položek ze světa knih, {len(out['festival'])} z festivalu.")

    summ = os.environ.get("GITHUB_STEP_SUMMARY")
    if summ:
        with open(summ, "a", encoding="utf-8") as f:
            f.write(f"## Návrh newsletteru {ym}\n\n- položek ze světa knih: {len(svet)}\n- novinek z festivalu: {len(out['festival'])}\n")
            if WARN:
                f.write("\n### Varování\n" + "\n".join(f"- {w}" for w in WARN) + "\n")


if __name__ == "__main__":
    main()
