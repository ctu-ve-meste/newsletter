/**
 * Čtu ve městě – newsletter (Apps Script navázaný na Google tabulku).
 *
 * List "Odběratelé" (hlavička v 1. řádku):
 *   A e-mail | B jméno | C stav | D token | E žádost odeslána | F potvrzeno | G odhlášeno | H poslední zaslané číslo | I zdroj
 * Další listy (vytvoří se sami): "Archiv" (odeslaná čísla), "Log" (protokol), "Záloha RRRR-MM-DD" (týdenní kopie odběratelů).
 *
 * Script Properties (Project Settings → Script properties):
 *   WEBAPP_URL   – adresa nasazené webové aplikace (končí na /exec)
 *   ADMIN_KEY    – dlouhý náhodný řetězec pro schvalovací stránku
 *   ADMIN_EMAILS – e-maily, kam chodí testy, oddělené čárkou
 *   ITEMS_URL    – raw URL souboru polozky.json z GitHubu
 */

const SHEET = 'Odběratelé';
const COL = { EMAIL: 1, JMENO: 2, STAV: 3, TOKEN: 4, ZADOST: 5, POTVRZENO: 6, ODHLASENO: 7, POSLANO: 8, ZDROJ: 9 };
const ST = { CEKA: 'čeká', ODEBIRA: 'odebírá', ODHLASEN: 'odhlášen', NEDORUCITELNY: 'nedoručitelný' };
const ORG = {
  name: 'Čtu ve městě, z.s.',
  addr: 'Hlavní třída 107, 738 01 Frýdek-Místek',
  ico: '22293752',
  web: 'https://www.ctuvemeste.cz',
  fb: 'https://www.facebook.com/ctuvemeste/',
  ig: 'https://www.instagram.com/ctuvemeste_cz/',
  mail: 'ctuvemeste.cz@gmail.com',
  privacy: ''          // adresa stránky se zásadami zpracování osobních údajů (zobrazí se u přihlašovacího formuláře)
};
const PENDING_DAYS = 30;        // po kolika dnech smazat adresy, které nepotvrdily
const SIGNUP_DAILY_MAX = 60;    // ochrana přihlašovacího formuláře proti zneužití
const BACKUPS_KEEP = 4;
const TZ = 'Europe/Prague';
const YELLOW = '#FFD400';
const WEEKDAYS = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];

/* ---------- pomocné ---------- */

function prop_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('Chybí Script Property: ' + k);
  return v;
}
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_() {
  const sh = ss_().getSheetByName(SHEET);
  if (!sh) throw new Error('Chybí list "' + SHEET + '".');
  return sh;
}
function getSheet_(name, headers) {
  let sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}
function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function url_(u) { return /^https?:\/\//i.test(u || '') ? esc_(u) : ''; }
function validEmail_(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120; }
/** Sloupec H: Google Sheets umí "2027-01" převést na datum. Sjednotíme na řetězec RRRR-MM. */
function issueKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone(), 'yyyy-MM');
  return String(v || '').trim();
}
function notify_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}
function admins_() { return prop_('ADMIN_EMAILS').split(',').map(s => s.trim()).filter(Boolean); }
function log_(akce, detail) {
  try { getSheet_('Log', ['datum', 'akce', 'detail']).appendRow([new Date(), akce, String(detail || '').slice(0, 500)]); }
  catch (e) { Logger.log('log_: ' + e); }
}
function sendMail_(to, subject, html, text) {
  MailApp.sendEmail({ to: to, subject: subject, body: text || '', htmlBody: html, name: ORG.name, replyTo: ORG.mail });
}
function stripTags_(h) { return String(h).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim(); }

/* ---------- menu a spouštěče ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Newsletter')
    .addItem('1) Připravit řádky (stav, tokeny)', 'prepareRows')
    .addItem('2) Poslat žádosti o souhlas', 'sendConsentRequests')
    .addItem('Zpracovat odpovědi „odhlásit“', 'processUnsubReplies')
    .addItem('Zpracovat vrácené e-maily (nedoručitelné)', 'processBounces')
    .addItem('Smazat nepotvrzené po 30 dnech', 'purgePending')
    .addItem('Zálohovat odběratele teď', 'backupSubscribers')
    .addItem('Nainstalovat automatické spouštěče', 'installTriggers')
    .addToUi();
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processUnsubReplies').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('processBounces').timeBased().everyHours(6).create();
  ScriptApp.newTrigger('purgePending').timeBased().everyDays(1).atHour(4).create();
  ScriptApp.newTrigger('backupSubscribers').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  ScriptApp.newTrigger('remindApproval').timeBased().onMonthDay(21).atHour(8).create();
  notify_('Spouštěče nainstalovány: odhlášení z e-mailů hodinově, vrácené e-maily každých 6 hodin, mazání nepotvrzených denně, záloha v pondělí, upomínka ke schválení 21. v měsíci.');
}

/** 21. v měsíci pošle adminům odkaz na schvalovací stránku (GitHub Action generuje návrh 20.). */
function remindApproval() {
  const link = prop_('WEBAPP_URL') + '?a=admin&key=' + encodeURIComponent(prop_('ADMIN_KEY'));
  admins_().forEach(a => sendMail_(a, 'Newsletter Čtu ve městě: návrh čeká na schválení',
    '<p>Návrh dalšího čísla je připravený. Doplň kavárnu pro Kafe&amp;kniha (nebo sekci vypni), zkontroluj náhled, ověř odkazy, pošli si test a pak odešli.</p><p><a href="' + link + '">Otevřít schvalovací stránku</a></p>',
    'Návrh dalšího čísla je připravený: ' + link));
}

/* ---------- příprava tabulky ---------- */

function prepareRows() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return;
  const rng = sh.getRange(2, 1, last - 1, 8);
  const v = rng.getValues();
  const seen = {};
  v.forEach(r => {
    r[0] = String(r[0]).trim().toLowerCase();
    if (!r[0]) return;
    if (seen[r[0]]) { r[2] = 'duplicita'; return; }
    seen[r[0]] = true;
    if (!validEmail_(r[0])) { r[2] = 'neplatný e-mail'; return; }
    if (!r[2]) r[2] = ST.CEKA;
    if (!r[3]) r[3] = Utilities.getUuid();
  });
  rng.setValues(v);
}

/* ---------- žádost o souhlas / potvrzení odběru ---------- */

function consentHtml_(name, token, mode) {
  const link = prop_('WEBAPP_URL') + '?a=confirm&t=' + encodeURIComponent(token);
  const hi = name ? 'Dobrý den, ' + esc_(name) + ',' : 'Dobrý den,';
  const intro = mode === 'signup'
    ? '<p>někdo (snad vy) zadal tuto adresu ve formuláři na ctuvemeste.cz pro odběr newsletteru Čtu ve městě. Jednou měsíčně vám napíšeme, kde a kdy se čte příště (třeba Kafe&amp;kniha, první neděli v měsíci), a občas přidáme zajímavost ze světa knih.</p>'
    : '<p>před časem jste nám při registraci na naši akci nechali e-mail. Děkujeme, že jste přišli číst.</p>'
      + '<p>Rádi bychom vám jednou měsíčně napsali, kde a kdy se čte příště (třeba Kafe&amp;kniha, první neděli v měsíci) a občas přidali zajímavost ze světa knih. Žádný spam.</p>';
  const outro = mode === 'signup'
    ? '<p>Pokud jste to nebyli vy, nic nedělejte. Nic vám nepřijde.</p>'
    : `<p>Pokud nechcete, nic nedělejte. Nic vám nepošleme a vaši adresu do ${PENDING_DAYS} dnů smažeme. Tuto zprávu posíláme jen jednou.</p>`;
  return `<div style="font:16px/1.6 Georgia,serif;color:#111;max-width:560px">
<p>${hi}</p>
${intro}
<p><a href="${link}" style="display:inline-block;background:#000;color:${YELLOW};padding:12px 22px;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold">${mode === 'signup' ? 'Potvrdit odběr' : 'Chci odebírat'}</a></p>
<p style="font-size:14px"><a href="${prop_('WEBAPP_URL')}?a=sample">Podívat se na vymyšlenou ukázku newsletteru</a></p>
${outro}
<p style="color:#666;font-size:13px">${ORG.name}, ${ORG.addr}, IČ ${ORG.ico}<br><a href="${ORG.web}">${ORG.web.replace('https://', '')}</a> · ${ORG.mail}</p>
</div>`;
}

function sendConsentRequests() {
  prepareRows();
  const sh = sheet_();
  const data = sh.getDataRange().getValues();
  let quota = MailApp.getRemainingDailyQuota();
  let sent = 0, skipped = 0;
  for (let i = 1; i < data.length; i++) {
    const [email, name, stav, token, zadost] = data[i];
    if (stav !== ST.CEKA || zadost) continue;
    if (quota - sent < 5) { skipped++; continue; }
    const html = consentHtml_(name, token, 'import');
    sendMail_(email, 'Chcete vědět, kdy se čte příště?', html, stripTags_(html));
    sh.getRange(i + 1, COL.ZADOST).setValue(new Date());
    if (!data[i][COL.ZDROJ - 1]) sh.getRange(i + 1, COL.ZDROJ).setValue('registrace na akci');
    sent++;
  }
  log_('žádosti o souhlas', 'odesláno ' + sent + (skipped ? ', zbývá ' + skipped : ''));
  notify_('Odesláno: ' + sent + (skipped ? '\nPřekročen denní limit, zbývá: ' + skipped + ' (spusť znovu zítra).' : ''));
}

function setStatus_(token, action) {
  if (!token) return false;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < 2) return false;
    const tokens = sh.getRange(2, COL.TOKEN, last - 1, 1).getValues().flat();
    const idx = tokens.indexOf(token);
    if (idx < 0) return false;
    const row = idx + 2;
    if (action === 'confirm') {
      const cur = sh.getRange(row, COL.STAV).getValue();
      if (cur === ST.ODHLASEN) return 'odhlasen';   // odhlášený se znovu nepřihlásí kliknutím na starý odkaz
      sh.getRange(row, COL.STAV).setValue(ST.ODEBIRA);
      sh.getRange(row, COL.POTVRZENO).setValue(new Date());
      log_('potvrzení odběru', 'řádek ' + row);
    } else {
      sh.getRange(row, COL.STAV).setValue(ST.ODHLASEN);
      sh.getRange(row, COL.ODHLASENO).setValue(new Date());
      log_('odhlášení odkazem', 'řádek ' + row);
    }
    return true;
  } finally {
    lock.releaseLock();
  }
}

/* ---------- přihlášení přes web / QR kód (s potvrzením e-mailem) ---------- */

function signupForm_(msg) {
  const consent = 'Souhlasím se zasíláním newsletteru Čtu ve městě (zhruba jednou měsíčně) na uvedenou adresu.';
  return (msg ? `<p style="color:${YELLOW}">${esc_(msg)}</p>` : '') +
    `<p>Jednou měsíčně vám napíšeme, kde a kdy se čte příště.</p>
<form method="post" action="${esc_(prop_('WEBAPP_URL'))}" target="_top">
<input type="hidden" name="a" value="signup"><input type="hidden" name="ts" value="${Date.now()}">
<div style="position:absolute;left:-9999px" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
<label>E-mail<br><input type="email" name="email" required maxlength="120" autocomplete="email"></label>
<label>Jméno (nepovinné)<br><input type="text" name="name" maxlength="60" autocomplete="given-name"></label>
<label class="chk"><input type="checkbox" name="consent" value="1" required> ${esc_(consent)}</label>
<button type="submit">Přihlásit se</button>
</form>
<p style="font-size:13px;color:#aaa">Správcem údajů je ${esc_(ORG.name)}, ${esc_(ORG.addr)}. Adresu použijeme jen k zasílání newsletteru. Po odeslání vám přijde e-mail, ve kterém odběr potvrdíte. Odhlásit se můžete kdykoli odkazem v každém e-mailu.${ORG.privacy ? ' <a href="' + esc_(ORG.privacy) + '">Zásady zpracování osobních údajů</a>.' : ''}</p>`;
}

function signupBudget_() {
  const pr = PropertiesService.getScriptProperties();
  const key = 'SIGNUPS_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  const n = Number(pr.getProperty(key) || 0);
  if (n >= SIGNUP_DAILY_MAX) return false;
  pr.setProperty(key, String(n + 1));
  return true;
}

function handleSignup_(p) {
  const GENERIC = page_('Skoro hotovo', '<p>Pokud je adresa v pořádku, poslali jsme vám potvrzovací e-mail. Kliknutím na odkaz v něm odběr dokončíte. Zkontrolujte i složku Spam.</p>');
  if (p.website) return GENERIC;                                            // honeypot
  if (!p.consent) return page_('Přihlášení', signupForm_('Bez souhlasu vás přihlásit nemůžeme.'));
  if (Date.now() - Number(p.ts || 0) < 3000) return GENERIC;                // příliš rychlé odeslání = robot
  const email = String(p.email || '').trim().toLowerCase();
  const name = String(p.name || '').trim().slice(0, 60);
  if (!validEmail_(email)) return page_('Přihlášení', signupForm_('Zkontrolujte prosím e-mailovou adresu.'));
  if (MailApp.getRemainingDailyQuota() < 20 || !signupBudget_()) return page_('Zkuste to později', '<p>Dnes už jsme přihlášek přijali hodně. Zkuste to prosím zítra.</p>');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const data = sh.getDataRange().getValues();
    let row = -1;
    for (let i = 1; i < data.length; i++) if (String(data[i][0]).trim().toLowerCase() === email) { row = i + 1; break; }
    const now = new Date();
    let token;
    if (row < 0) {
      token = Utilities.getUuid();
      sh.appendRow([email, name, ST.CEKA, token, now, '', '', '', 'web-formulář (souhlas zaškrtnut)']);
    } else {
      const r = data[row - 1];
      const stav = r[COL.STAV - 1];
      if (stav === ST.ODEBIRA) return GENERIC;                              // už odebírá, nic neposíláme
      const zad = r[COL.ZADOST - 1];
      if (stav === ST.CEKA && zad instanceof Date && now - zad < 86400000) return GENERIC;   // nespamovat opakovaně
      token = Utilities.getUuid();
      sh.getRange(row, COL.STAV).setValue(ST.CEKA);
      sh.getRange(row, COL.TOKEN).setValue(token);
      sh.getRange(row, COL.ZADOST).setValue(now);
      sh.getRange(row, COL.ZDROJ).setValue('web-formulář (souhlas zaškrtnut)');
      if (name) sh.getRange(row, COL.JMENO).setValue(name);
    }
    const html = consentHtml_(name, token, 'signup');
    sendMail_(email, 'Potvrďte odběr newsletteru Čtu ve městě', html, stripTags_(html));
    log_('přihlášení přes web', 'čeká na potvrzení');
  } finally {
    lock.releaseLock();
  }
  return GENERIC;
}

/* ---------- stránky webové aplikace ---------- */

function page_(title, body) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#000;color:#fff;font:18px/1.6 Georgia,serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:480px;width:100%;padding:32px;box-sizing:border-box}h1{font-family:Arial,sans-serif;font-size:28px}h1 span{color:${YELLOW}}a{color:${YELLOW}}
label{display:block;margin:12px 0;font:15px Arial,sans-serif;color:#ccc}label.chk{display:flex;gap:10px;align-items:flex-start}
input[type=email],input[type=text]{width:100%;box-sizing:border-box;padding:10px;font:17px Georgia,serif;background:#111;color:#fff;border:1px solid #555}
button{background:${YELLOW};color:#000;border:0;padding:12px 22px;font:bold 16px Arial,sans-serif;cursor:pointer;margin-top:8px}
ul{padding-left:20px}li{margin:6px 0}</style></head>
<body><main><h1>${esc_(title)}<span>.</span></h1>${body}<p><a href="${ORG.web}">ctuvemeste.cz</a></p></main></body></html>`;
  return HtmlService.createHtmlOutput(html).setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function htmlPage_(html, title) {
  return HtmlService.createHtmlOutput(html).setTitle(title).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.a === 'confirm') {
    const r = setStatus_(p.t, 'confirm');
    if (r === true) return page_('Děkujeme', '<p>Máte to hotové. Ozveme se vám jednou měsíčně. Odhlásit se můžete kdykoli odkazem v každém e-mailu.</p>');
    if (r === 'odhlasen') return page_('Už jste odhlášeni', '<p>Tuto adresu jste dříve odhlásili. Pokud chcete odebírat znovu, přihlaste se na <a href="' + esc_(prop_('WEBAPP_URL')) + '?a=signup">tomto formuláři</a>.</p>');
    return page_('Odkaz nefunguje', '<p>Odkaz je neplatný nebo starý. Napište nám na ' + ORG.mail + '.</p>');
  }
  if (p.a === 'unsub') {
    const ok = setStatus_(p.t, 'unsub');
    return ok === true
      ? page_('Odhlášeno', '<p>Hotovo, už vám nic nepošleme. Díky, že jste s námi četli.</p>')
      : page_('Odkaz nefunguje', '<p>Odkaz je neplatný. Napište nám na ' + ORG.mail + ' a odhlásíme vás ručně.</p>');
  }
  if (p.a === 'signup') return page_('Newsletter', signupForm_());
  if (p.a === 'sample') return htmlPage_(buildHtml_(sampleData_(), '#', SAMPLE_BANNER, {}), 'Ukázka newsletteru');
  if (p.a === 'view') {
    const it = getIssueById_(p.i);
    if (!it) return page_('Nenalezeno', '<p>Toto číslo jsme nenašli.</p>');
    return htmlPage_(buildHtml_(it.d, '', null, { archive: true, icsUrl: icsUrl_(it) }), subject_(it.d));
  }
  if (p.a === 'ics') {
    const it = getIssueById_(p.i);
    const ics = it && icsText_(it.d, p.i);
    if (!ics) return page_('Nenalezeno', '<p>K tomuto číslu nemáme datum a čas čtení.</p>');
    return ContentService.createTextOutput(ics).setMimeType(ContentService.MimeType.ICAL);
  }
  if (p.a === 'archiv') {
    const items = listIssues_();
    const body = items.length
      ? '<ul>' + items.map(x => `<li><a href="${esc_(prop_('WEBAPP_URL'))}?a=view&i=${esc_(x.id)}">${esc_(x.predmet)}</a></li>`).join('') + '</ul>'
      : '<p>Zatím jsme žádné číslo neposlali.</p>';
    return page_('Archiv newsletteru', body);
  }
  if (p.a === 'admin') {
    if (!p.key || p.key !== prop_('ADMIN_KEY')) return page_('Nepřístupné', '<p>Chybný klíč.</p>');
    const t = HtmlService.createTemplateFromFile('Admin');
    t.key = p.key;
    return t.evaluate().setTitle('Newsletter – schválení').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return page_('Čtu ve městě', '<p>Opravdu čtenářský festival.</p>');
}

function doPost(e) {
  const p = (e && e.parameter) || {};
  if (p.a === 'signup') return handleSignup_(p);
  return page_('Čtu ve městě', '<p>Opravdu čtenářský festival.</p>');
}

/* ---------- odhlášení odpovědí „odhlásit“ ---------- */

/** Vrátí jen to, co napsal odesílatel (bez citované původní zprávy), max. 400 znaků. */
function ownText_(body) {
  const lines = String(body || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l) || /^(Dne|On)\s.+(napsal|wrote)/i.test(l) || /^-{2,}\s*(Original|Přeposlaná)/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').slice(0, 400);
}

function processUnsubReplies() {
  const label = GmailApp.getUserLabelByName('ctu-zpracovano') || GmailApp.createLabel('ctu-zpracovano');
  const threads = GmailApp.search('in:inbox newer_than:14d -label:ctu-zpracovano (odhlásit OR odhlasit OR odhlášení)');
  if (!threads.length) return;
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return;
  const emails = sh.getRange(2, COL.EMAIL, last - 1, 1).getValues().flat().map(s => String(s).trim().toLowerCase());
  threads.forEach(t => {
    let matched = false;
    t.getMessages().forEach(m => {
      if (!/odhl[aá](sit|šen)/i.test(ownText_(m.getPlainBody()))) return;
      const raw = m.getFrom();
      const from = ((raw.match(/<([^>]+)>/) || [null, raw])[1] || '').trim().toLowerCase();
      if (from === ORG.mail) return;
      const idx = emails.indexOf(from);
      if (idx >= 0) {
        const row = idx + 2;
        sh.getRange(row, COL.STAV).setValue(ST.ODHLASEN);
        sh.getRange(row, COL.ODHLASENO).setValue(new Date());
        log_('odhlášení odpovědí', 'řádek ' + row);
        matched = true;
      }
    });
    if (matched) t.addLabel(label);
  });
}

/* ---------- vrácené e-maily (nedoručitelné adresy) ---------- */

function processBounces() {
  const label = GmailApp.getUserLabelByName('ctu-bounce') || GmailApp.createLabel('ctu-bounce');
  const threads = GmailApp.search('in:inbox newer_than:14d -label:ctu-bounce (from:mailer-daemon OR from:postmaster)');
  if (!threads.length) return;
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return;
  const rows = sh.getRange(2, 1, last - 1, COL.STAV).getValues();
  const emails = rows.map(r => String(r[0]).trim().toLowerCase());
  const PERM = /(\b5\.\d{1,3}\.\d{1,3}\b|\b55[0-4]\b|does not exist|doesn't exist|wasn't found|couldn't be found|no such user|unknown user|user unknown|neexistuje)/i;
  const TEMP = /(\b4\.\d{1,3}\.\d{1,3}\b|mailbox full|over quota|quota exceeded|temporar|try again later)/i;
  threads.forEach(t => {
    let marked = false;
    t.getMessages().forEach(m => {
      const body = m.getPlainBody() || '';
      if (!PERM.test(body) || TEMP.test(body)) return;      // jen trvalé chyby
      const hdr = String(m.getRawContent() || '').match(/X-Failed-Recipients:\s*([^\r\n]+)/i);
      const failed = hdr
        ? hdr[1].split(',').map(s => s.trim().toLowerCase())
        : (body.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(s => s.toLowerCase());
      failed.forEach(e => {
        const idx = emails.indexOf(e);
        if (idx < 0) return;
        const stav = rows[idx][COL.STAV - 1];
        if (stav !== ST.ODEBIRA && stav !== ST.CEKA) return;
        sh.getRange(idx + 2, COL.STAV).setValue(ST.NEDORUCITELNY);
        rows[idx][COL.STAV - 1] = ST.NEDORUCITELNY;
        log_('nedoručitelná adresa', 'řádek ' + (idx + 2));
        marked = true;
      });
    });
    if (marked) t.addLabel(label);
  });
}

/* ---------- úklid a záloha ---------- */

function purgePending() {
  const sh = sheet_();
  const data = sh.getDataRange().getValues();
  const limit = Date.now() - PENDING_DAYS * 86400000;
  let removed = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    const [, , stav, , zadost] = data[i];
    if (stav === ST.CEKA && zadost instanceof Date && zadost.getTime() < limit) { sh.deleteRow(i + 1); removed++; }
  }
  if (removed) log_('smazáno nepotvrzených', removed);
  // úklid denních čítačů přihlášek
  const pr = PropertiesService.getScriptProperties();
  const today = 'SIGNUPS_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  Object.keys(pr.getProperties()).forEach(k => { if (k.indexOf('SIGNUPS_') === 0 && k !== today) pr.deleteProperty(k); });
}

function backupSubscribers() {
  const ss = ss_();
  const name = 'Záloha ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const old = ss.getSheetByName(name);
  if (old) ss.deleteSheet(old);
  const copy = sheet_().copyTo(ss).setName(name);
  copy.hideSheet();
  const backups = ss.getSheets().map(s => s.getName()).filter(n => n.indexOf('Záloha ') === 0).sort().reverse();
  backups.slice(BACKUPS_KEEP).forEach(n => ss.deleteSheet(ss.getSheetByName(n)));
  log_('záloha odběratelů', name);
}

/* ---------- archiv čísel ---------- */

function archSheet_() { return getSheet_('Archiv', ['id', 'měsíc', 'předmět', 'stav', 'uloženo', 'odesláno', 'json']); }

function saveIssue_(d, stav) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = archSheet_();
    const data = sh.getDataRange().getValues();
    let row = -1;
    for (let i = 1; i < data.length; i++) if (issueKey_(data[i][1]) === d.mesic) { row = i + 1; break; }
    const now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
    const json = JSON.stringify(d);
    if (row < 0) {
      const id = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
      const r = sh.getLastRow() + 1;
      sh.getRange(r, 1, 1, 7).setNumberFormat('@').setValues([[id, d.mesic, subject_(d), stav, now, stav === 'odesláno' ? now : '', json]]);
      return id;
    }
    const cur = data[row - 1];
    const id = String(cur[0]);
    const newStav = (cur[3] === 'odesláno' || stav === 'odesláno') ? 'odesláno' : stav;
    sh.getRange(row, 3).setValue(subject_(d));
    sh.getRange(row, 4).setValue(newStav);
    sh.getRange(row, 5).setValue(now);
    if (stav === 'odesláno' && !cur[5]) sh.getRange(row, 6).setValue(now);
    sh.getRange(row, 7).setValue(json);
    return id;
  } finally {
    lock.releaseLock();
  }
}

function getIssueById_(id) {
  if (!id || !/^[0-9a-f]{12}$/.test(id)) return null;
  const data = archSheet_().getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === id) {
      try { return { id: id, stav: data[i][3], d: JSON.parse(data[i][6]) }; } catch (e) { return null; }
    }
  }
  return null;
}

function listIssues_() {
  const data = archSheet_().getDataRange().getValues().slice(1);
  return data.filter(r => r[3] === 'odesláno')
    .map(r => ({ id: String(r[0]), mesic: issueKey_(r[1]), predmet: String(r[2]) }))
    .sort((a, b) => b.mesic.localeCompare(a.mesic));
}

/* ---------- Kafe&kniha: datum, čas, kalendář ---------- */

const MESICE = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];
const pad2_ = n => (n < 10 ? '0' : '') + n;

function firstSundayDate_(mesic) {
  const m = /^(\d{4})-(\d{2})$/.exec(mesic || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, 1);
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
  return d;
}
function dateText_(d) { return WEEKDAYS[d.getDay()] + ' ' + d.getDate() + '. ' + MESICE[d.getMonth()] + ' ' + d.getFullYear(); }

function parseTimes_(cas) {
  const s = String(cas || '');
  let m = s.match(/(\d{1,2})[:.](\d{2})\s*[–—-]\s*(\d{1,2})[:.](\d{2})/);
  let t = null;
  if (m) t = [+m[1], +m[2], +m[3], +m[4]];
  else {
    m = s.match(/(\d{1,2})[:.](\d{2})/);
    if (m) t = [+m[1], +m[2], Math.min(+m[1] + 2, 23), +m[2]];
  }
  return t && t[0] < 24 && t[2] < 24 && t[1] < 60 && t[3] < 60 ? t : null;
}

/** Kafe&kniha: { k, date, text, times } nebo null, pokud je sekce vypnutá. */
function kafeInfo_(d) {
  const k = d.kafe_a_kniha;
  if (!k || k.zahrnout === false) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k.datum_iso || '');
  let date = null;
  if (m) date = new Date(+m[1], +m[2] - 1, +m[3]);
  else if (!k.datum) date = firstSundayDate_(d.mesic);
  const text = (k.datum && !m) ? k.datum : (date ? dateText_(date) : '');
  return { k: k, date: date, text: text, times: parseTimes_(k.cas) };
}

function stamp_(date, h, mi) { return date.getFullYear() + pad2_(date.getMonth() + 1) + pad2_(date.getDate()) + 'T' + pad2_(h) + pad2_(mi) + '00'; }

function gcalUrl_(d) {
  const i = kafeInfo_(d);
  if (!i || !i.date || !i.times) return '';
  const k = i.k, t = i.times;
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text=' + encodeURIComponent('Kafe&kniha' + (k.misto ? ' – ' + k.misto : ''))
    + '&dates=' + stamp_(i.date, t[0], t[1]) + '/' + stamp_(i.date, t[2], t[3])
    + '&ctz=' + encodeURIComponent(TZ)
    + '&location=' + encodeURIComponent([k.misto, k.adresa].filter(Boolean).join(', '))
    + '&details=' + encodeURIComponent('Čtu ve městě: čtení v kavárně. Vezměte si vlastní knihu. ' + (k.odkaz || ORG.web));
}

function icsText_(d, id) {
  const i = kafeInfo_(d);
  if (!i || !i.date || !i.times) return null;
  const k = i.k, t = i.times;
  const e = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ctu ve meste//Newsletter//CS', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    'UID:' + (id || 'x') + '-' + stamp_(i.date, 0, 0) + '@ctuvemeste.cz',
    'DTSTAMP:' + Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'"),
    'DTSTART:' + stamp_(i.date, t[0], t[1]),
    'DTEND:' + stamp_(i.date, t[2], t[3]),
    'SUMMARY:' + e('Kafe&kniha' + (k.misto ? ' – ' + k.misto : '')),
    'LOCATION:' + e([k.misto, k.adresa].filter(Boolean).join(', ')),
    'DESCRIPTION:' + e('Čtu ve městě: čtení v kavárně. Vezměte si vlastní knihu. ' + (k.odkaz || ORG.web)),
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

function icsUrl_(it) { return icsText_(it.d, it.id) ? prop_('WEBAPP_URL') + '?a=ics&i=' + it.id : ''; }
function ctxFor_(d, id) {
  const base = prop_('WEBAPP_URL');
  return { viewUrl: base + '?a=view&i=' + id, icsUrl: icsText_(d, id) ? base + '?a=ics&i=' + id : '' };
}

/* ---------- newsletter ---------- */

function countdownText_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  const target = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const n = Math.round((target - today) / 86400000);
  if (n < 0) return '';
  if (n === 0) return 'Dnes je to tady.';
  if (n === 1) return 'Zbývá 1 den.';
  return (n <= 4 ? 'Zbývají ' + n + ' dny.' : 'Zbývá ' + n + ' dní.');
}

function buildHtml_(d, unsubUrl, banner, ctx) {
  ctx = ctx || {};
  const Y = YELLOW;
  const label = t => !t ? '' : `<div style="font:bold 11px Arial,sans-serif;letter-spacing:3px;color:${Y};text-transform:uppercase;margin-bottom:6px">${esc_(t)}</div>`;
  const h = t => `<h2 style="font:bold 24px Arial,sans-serif;margin:0 0 10px;color:#fff">${esc_(t)}<span style="color:${Y}">.</span></h2>`;
  const link = (u, t) => url_(u) ? `<p style="margin:8px 0 0"><a href="${url_(u)}" style="color:${Y}">${esc_(t || 'Více zde')} →</a></p>` : '';
  const block = (lab, inner) => `<tr><td style="padding:28px 32px 0">${label(lab)}${inner}</td></tr>`;
  const p = t => `<p style="margin:0 0 8px;font:17px/1.6 Georgia,serif;color:#eee">${esc_(t)}</p>`;

  let rows = '';
  const ki = kafeInfo_(d);
  if (ki) {
    const k = ki.k;
    const gcal = gcalUrl_(d);
    const cal = gcal
      ? `<p style="margin:10px 0 0;font:14px Arial,sans-serif;color:#aaa">Přidat do kalendáře: <a href="${esc_(gcal)}" style="color:${Y}">Google</a>${ctx.icsUrl ? ` · <a href="${esc_(ctx.icsUrl)}" style="color:${Y}">Apple / Outlook (.ics)</a>` : ''}</p>`
      : '';
    rows += block('Příští čtení', h('Kafe&kniha') +
      p(ki.text + (k.cas ? ', ' + k.cas : '')) +
      p((k.misto || '') + (k.adresa ? ', ' + k.adresa : '')) +
      (k.popis ? p(k.popis) : '') + link(k.odkaz, 'Podrobnosti') + cal);
  }

  const filled = i => i.zahrnout !== false && (i.nadpis || i.text);
  const dates = i => i.zivotni_data
    ? `<p style="margin:-4px 0 10px;font:13px Arial,sans-serif;color:#999">(${esc_(i.zivotni_data)})</p>` : '';
  const caption = i => i.foto_popisek
    ? `<div style="font:10px/1.3 Arial,sans-serif;color:#888;padding-top:4px">${esc_(i.foto_popisek)}${url_(i.foto_odkaz) ? ` · <a href="${url_(i.foto_odkaz)}" style="color:#888">zdroj</a>` : ''}</div>` : '';
  const wiki = i => i.wiki_text
    ? `<p style="margin:0 0 8px;font:15px/1.6 Georgia,serif;color:#ccc">${esc_(i.wiki_text)} <span style="font:12px Arial,sans-serif;color:#888">(${url_(i.wiki_odkaz) ? `<a href="${url_(i.wiki_odkaz)}" style="color:#888">Wikipedie</a>` : 'Wikipedie'}, CC BY-SA 4.0)</span></p>`
    : '';
  const itemBody = i => {
    const text = p(i.text) + wiki(i) + link(i.odkaz, i.zdroj ? 'Zdroj: ' + i.zdroj : 'Více zde');
    return url_(i.foto)
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
        `<td width="150" valign="top" style="width:150px;padding-right:16px"><img src="${url_(i.foto)}" width="150" alt="${esc_(i.nadpis)}" style="display:block;width:150px;max-width:100%;height:auto;border:0">${caption(i)}</td>` +
        `<td valign="top">${text}</td></tr></table>`
      : text;
  };
  (d.festival || []).filter(filled).forEach((i, n) => {
    rows += block(n === 0 ? 'Z festivalu' : '', h(i.nadpis) + itemBody(i));
  });

  const r = d.rocnik;
  if (r && r.zahrnout === true && (r.nadpis || r.text || r.datum_iso)) {
    const cd = countdownText_(r.datum_iso);
    rows += block('Další ročník', h(r.nadpis || 'Další ročník') + (cd ? p(cd) : '') + (r.text ? p(r.text) : '') + link(r.odkaz));
  }

  (d.svet_knih || []).filter(filled).forEach((i, n) => {
    rows += block(n === 0 ? 'Ze světa knih' : '', h(i.nadpis) + dates(i) + itemBody(i));
  });
  if (d.vzkaz) rows += block('Vzkaz od týmu', p(d.vzkaz));

  const topLine = ctx.viewUrl
    ? `<tr><td style="padding:12px 32px 0;font:12px Arial,sans-serif;color:#888">Nezobrazuje se správně? <a href="${esc_(ctx.viewUrl)}" style="color:#aaa">Zobrazit v prohlížeči</a></td></tr>` : '';
  const foot = unsubUrl
    ? `Tento e-mail dostáváte, protože jste se přihlásili k odběru. <a href="${esc_(unsubUrl)}" style="color:#ccc">Odhlásit odběr</a> (nebo odpovězte slovem „odhlásit“).`
    : `Newsletter Čtu ve městě. Odběr zrušíte odkazem v e-mailu, který vám přišel. <a href="${esc_(prop_('WEBAPP_URL'))}?a=signup" style="color:#ccc">Přihlásit se k odběru</a>.`;

  return `<!doctype html><html><body style="margin:0;background:#000">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#000;color:#fff">
${banner ? `<tr><td style="background:${Y};color:#000;font:bold 14px/1.4 Arial,sans-serif;padding:12px 32px">${esc_(banner)}</td></tr>` : ''}
${topLine}
<tr><td style="padding:32px 32px 0;font:bold 44px Arial,sans-serif;color:#fff">čtu<span style="color:${Y}">.</span> <span style="font-size:16px;font-weight:normal">ve městě</span></td></tr>
${rows}
<tr><td style="padding:32px;font:14px/1.6 Arial,sans-serif;color:#aaa">
<a href="${ORG.web}" style="color:${Y}">ctuvemeste.cz</a> · <a href="${ORG.fb}" style="color:${Y}">Facebook</a> · <a href="${ORG.ig}" style="color:${Y}">Instagram</a><br><br>
${ORG.name}, ${ORG.addr}, IČ ${ORG.ico}<br>
${foot}
</td></tr></table></td></tr></table></body></html>`;
}

/** Prostá textová verze e-mailu (pro schránky, které ji preferují). */
function buildText_(d, unsubUrl, ctx) {
  ctx = ctx || {};
  const L = [];
  L.push('čtu. ve městě', '');
  if (ctx.viewUrl) L.push('Zobrazit v prohlížeči: ' + ctx.viewUrl, '');
  const ki = kafeInfo_(d);
  if (ki) {
    const k = ki.k;
    L.push('KAFE&KNIHA', ki.text + (k.cas ? ', ' + k.cas : ''), [k.misto, k.adresa].filter(Boolean).join(', '));
    if (k.popis) L.push(k.popis);
    if (k.odkaz) L.push(k.odkaz);
    if (gcalUrl_(d)) L.push('Do kalendáře: ' + gcalUrl_(d));
    L.push('');
  }
  const it = i => { L.push(i.nadpis + (i.zivotni_data ? ' (' + i.zivotni_data + ')' : ''), i.text || ''); if (i.wiki_text) L.push(i.wiki_text); if (i.odkaz) L.push(i.odkaz); L.push(''); };
  const filled = i => i.zahrnout !== false && (i.nadpis || i.text);
  const fest = (d.festival || []).filter(filled);
  if (fest.length) { L.push('Z FESTIVALU', ''); fest.forEach(it); }
  const r = d.rocnik;
  if (r && r.zahrnout === true && (r.nadpis || r.text || r.datum_iso)) {
    L.push('DALŠÍ ROČNÍK', r.nadpis || '', countdownText_(r.datum_iso), r.text || '', r.odkaz || '', '');
  }
  const sv = (d.svet_knih || []).filter(filled);
  if (sv.length) { L.push('ZE SVĚTA KNIH', ''); sv.forEach(it); }
  if (d.vzkaz) L.push('VZKAZ OD TÝMU', d.vzkaz, '');
  L.push('--', ORG.name + ', ' + ORG.addr + ', IČ ' + ORG.ico, ORG.web);
  L.push(unsubUrl ? 'Odhlásit odběr: ' + unsubUrl + ' (nebo odpovězte slovem „odhlásit“).' : 'Odběr zrušíte odkazem v e-mailu, který vám přišel.');
  return L.filter(x => x != null).join('\n');
}

function subject_(d) {
  const [y, m] = d.mesic.split('-').map(Number);
  const nom = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
  return 'Čtu ve městě: ' + nom[m - 1] + ' ' + y;
}

function unsubUrl_(token) { return prop_('WEBAPP_URL') + '?a=unsub&t=' + encodeURIComponent(token); }

/* ---------- ukázka newsletteru (vymyšlená) ---------- */

const SAMPLE_BANNER = 'UKÁZKA: vymyšlené číslo. Kavárna, termíny i položky nejsou skutečné, jen ukazují podobu newsletteru.';

function sampleData_() {
  return {
    mesic: '2027-01',
    kafe_a_kniha: {
      datum: 'neděle (vždy první v měsíci)', cas: '14:00–16:00',
      misto: 'Ukázková kavárna', adresa: 'Vymyšlená 1, Frýdek-Místek',
      popis: 'Tady bude pozvánka na čtení v kavárně. Údaje jsou vymyšlené.', odkaz: ORG.web
    },
    festival: [{ nadpis: 'Ukázková novinka z festivalu', text: 'Tady se objeví krátké zprávy z festivalu a jeho příprav.', odkaz: ORG.web }],
    svet_knih: [{ nadpis: 'Ukázkové výročí', text: 'Tady se objeví výročí, ocenění nebo zajímavost ze světa knih, vždy s odkazem na zdroj.', zdroj: 'ukázka', odkaz: ORG.web }],
    vzkaz: ''
  };
}

/* ---------- API pro schvalovací stránku ---------- */

function checkKey_(key) {
  if (!key || key !== prop_('ADMIN_KEY')) throw new Error('Neplatný klíč.');
}

function adminLoad(key) {
  checkKey_(key);
  const res = UrlFetchApp.fetch(prop_('ITEMS_URL') + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Nepodařilo se načíst polozky.json (HTTP ' + res.getResponseCode() + ').');
  const data = JSON.parse(res.getContentText());
  return { data: data, stats: stats_(data.mesic) };
}

function stats_(mesic) {
  const v = sheet_().getDataRange().getValues().slice(1);
  const sub = v.filter(r => r[COL.STAV - 1] === ST.ODEBIRA);
  return {
    odebira: sub.length,
    zbyva: sub.filter(r => issueKey_(r[COL.POSLANO - 1]) !== mesic).length,
    ceka: v.filter(r => r[COL.STAV - 1] === ST.CEKA).length,
    quota: MailApp.getRemainingDailyQuota()
  };
}

function adminPreview(key, d) {
  checkKey_(key);
  return buildHtml_(d, '#odhlasit-priklad', null, { viewUrl: '#', icsUrl: icsText_(d, 'x') ? '#' : '' });
}

function adminSend(key, d, mode) {
  checkKey_(key);
  const subj = subject_(d);
  if (mode === 'test') {
    const id = saveIssue_(d, 'test');
    const ctx = ctxFor_(d, id);
    admins_().forEach(a => sendMail_(a, '[TEST] ' + subj, buildHtml_(d, '#test', null, ctx), buildText_(d, '#test', ctx)));
    log_('test newsletteru', subj);
    return { poslano: admins_().length, zbyva: stats_(d.mesic).zbyva, test: true };
  }
  try { processUnsubReplies(); } catch (e) { Logger.log('processUnsubReplies před odesláním: ' + e); }
  try { processBounces(); } catch (e) { Logger.log('processBounces před odesláním: ' + e); }
  const id = saveIssue_(d, 'odesláno');
  const ctx = ctxFor_(d, id);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  const start = Date.now();
  let sent = 0, failed = 0;
  try {
    const sh = sheet_();
    const data = sh.getDataRange().getValues();
    let quota = MailApp.getRemainingDailyQuota();
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      if (r[COL.STAV - 1] !== ST.ODEBIRA || issueKey_(r[COL.POSLANO - 1]) === d.mesic) continue;
      if (quota - sent < 5) break;                       // denní limit
      if (Date.now() - start > 4.5 * 60 * 1000) break;   // limit běhu skriptu; stačí kliknout znovu
      const un = unsubUrl_(r[COL.TOKEN - 1]);
      try {
        sendMail_(r[0], subj, buildHtml_(d, un, null, ctx), buildText_(d, un, ctx));
        sh.getRange(i + 1, COL.POSLANO).setNumberFormat('@').setValue(d.mesic);
        sent++;
      } catch (e) {
        failed++;
        log_('chyba odeslání', 'řádek ' + (i + 1) + ': ' + e);
      }
    }
  } finally {
    lock.releaseLock();
  }
  log_('odeslání newsletteru', subj + ': odesláno ' + sent + (failed ? ', chyb ' + failed : ''));
  return { poslano: sent, zbyva: stats_(d.mesic).zbyva, test: false };
}
