/**
 * Čtu ve městě – newsletter (Apps Script navázaný na Google tabulku).
 *
 * List "Odběratelé" (hlavička v 1. řádku):
 *   A e-mail | B jméno | C stav | D token | E žádost odeslána | F potvrzeno | G odhlášeno | H poslední zaslané číslo
 *
 * Script Properties (Project Settings → Script properties):
 *   WEBAPP_URL   – adresa nasazené webové aplikace (končí na /exec)
 *   ADMIN_KEY    – dlouhý náhodný řetězec pro schvalovací stránku
 *   ADMIN_EMAILS – e-maily, kam chodí testy, oddělené čárkou
 *   ITEMS_URL    – raw URL souboru polozky.json z GitHubu
 */

const SHEET = 'Odběratelé';
const COL = { EMAIL: 1, JMENO: 2, STAV: 3, TOKEN: 4, ZADOST: 5, POTVRZENO: 6, ODHLASENO: 7, POSLANO: 8 };
const ST = { CEKA: 'čeká', ODEBIRA: 'odebírá', ODHLASEN: 'odhlášen' };
const ORG = {
  name: 'Čtu ve městě, z.s.',
  addr: 'Hlavní třída 107, 738 01 Frýdek-Místek',
  ico: '22293752',
  web: 'https://www.ctuvemeste.cz',
  fb: 'https://www.facebook.com/ctuvemeste/',
  ig: 'https://www.instagram.com/ctuvemeste_cz/',
  mail: 'ctuvemeste.cz@gmail.com'
};
const PENDING_DAYS = 30;       // po kolika dnech smazat adresy, které nepotvrdily
const YELLOW = '#FFD400';

/* ---------- pomocné ---------- */

function prop_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('Chybí Script Property: ' + k);
  return v;
}
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET);
  if (!sh) throw new Error('Chybí list "' + SHEET + '".');
  return sh;
}
function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function url_(u) { return /^https?:\/\//i.test(u || '') ? esc_(u) : ''; }
function validEmail_(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function admins_() { return prop_('ADMIN_EMAILS').split(',').map(s => s.trim()).filter(Boolean); }

/* ---------- menu ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Newsletter')
    .addItem('1) Připravit řádky (stav, tokeny)', 'prepareRows')
    .addItem('2) Poslat žádosti o souhlas', 'sendConsentRequests')
    .addItem('Zpracovat odpovědi „odhlásit“', 'processUnsubReplies')
    .addItem('Smazat nepotvrzené po 30 dnech', 'purgePending')
    .addItem('Nainstalovat automatické spouštěče', 'installTriggers')
    .addToUi();
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processUnsubReplies').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('purgePending').timeBased().everyDays(1).atHour(4).create();
  ScriptApp.newTrigger('remindApproval').timeBased().onMonthDay(21).atHour(8).create();
  SpreadsheetApp.getUi().alert('Spouštěče nainstalovány (odhlášení z e-mailů hodinově, mazání nepotvrzených denně, upomínka ke schválení 21. v měsíci).');
}

/** 21. v měsíci pošle adminům odkaz na schvalovací stránku (GitHub Action generuje návrh 20.). */
function remindApproval() {
  const link = prop_('WEBAPP_URL') + '?a=admin&key=' + encodeURIComponent(prop_('ADMIN_KEY'));
  admins_().forEach(a => MailApp.sendEmail({
    to: a,
    subject: 'Newsletter Čtu ve městě: návrh čeká na schválení',
    htmlBody: '<p>Návrh dalšího čísla je připravený. Zkontroluj náhled, ověř odkazy, pošli si test a pak odešli.</p><p><a href="' + link + '">Otevřít schvalovací stránku</a></p>',
    name: ORG.name
  }));
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

/* ---------- 1) žádost o souhlas (jednorázově) ---------- */

function consentHtml_(name, token) {
  const link = prop_('WEBAPP_URL') + '?a=confirm&t=' + encodeURIComponent(token);
  const hi = name ? 'Dobrý den, ' + esc_(name) + ',' : 'Dobrý den,';
  return `<div style="font:16px/1.6 Georgia,serif;color:#111;max-width:560px">
<p>${hi}</p>
<p>před časem jste nám při registraci na naši akci nechali e-mail. Děkujeme, že jste přišli číst.</p>
<p>Rádi bychom vám jednou měsíčně napsali, kde a kdy se čte příště (třeba Kafe&amp;kniha, první neděli v měsíci) a občas přidali zajímavost ze světa knih. Žádný spam.</p>
<p><a href="${link}" style="display:inline-block;background:#000;color:${YELLOW};padding:12px 22px;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold">Chci odebírat</a></p>
<p>Pokud nechcete, nic nedělejte. Nic vám neposlali a vaši adresu do ${PENDING_DAYS} dnů smažeme. Tuto zprávu posíláme jen jednou.</p>
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
    MailApp.sendEmail({
      to: email,
      subject: 'Chcete vědět, kdy se čte příště?',
      htmlBody: consentHtml_(name, token),
      name: ORG.name,
      replyTo: ORG.mail
    });
    sh.getRange(i + 1, COL.ZADOST).setValue(new Date());
    sent++;
  }
  SpreadsheetApp.getUi().alert('Odesláno: ' + sent + (skipped ? '\nPřekročen denní limit, zbývá: ' + skipped + ' (spusť znovu zítra).' : ''));
}

/* ---------- potvrzení / odhlášení ---------- */

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
    } else {
      sh.getRange(row, COL.STAV).setValue(ST.ODHLASEN);
      sh.getRange(row, COL.ODHLASENO).setValue(new Date());
    }
    return true;
  } finally {
    lock.releaseLock();
  }
}

function page_(title, body) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#000;color:#fff;font:18px/1.6 Georgia,serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:480px;padding:32px}h1{font-family:Arial,sans-serif;font-size:28px}h1 span{color:${YELLOW}}a{color:${YELLOW}}</style></head>
<body><main><h1>${esc_(title)}<span>.</span></h1>${body}<p><a href="${ORG.web}">ctuvemeste.cz</a></p></main></body></html>`;
  return HtmlService.createHtmlOutput(html).setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.a === 'confirm') {
    const r = setStatus_(p.t, 'confirm');
    if (r === true) return page_('Děkujeme', '<p>Máte to hotové. Ozveme se vám jednou měsíčně. Odhlásit se můžete kdykoli odkazem v každém e-mailu.</p>');
    if (r === 'odhlasen') return page_('Už jste odhlášeni', '<p>Tuto adresu jste dříve odhlásili. Pokud chcete odebírat znovu, napište nám na ' + ORG.mail + '.</p>');
    return page_('Odkaz nefunguje', '<p>Odkaz je neplatný nebo starý. Napište nám na ' + ORG.mail + '.</p>');
  }
  if (p.a === 'unsub') {
    const ok = setStatus_(p.t, 'unsub');
    return ok === true
      ? page_('Odhlášeno', '<p>Hotovo, už vám nic nepošleme. Díky, že jste s námi četli.</p>')
      : page_('Odkaz nefunguje', '<p>Odkaz je neplatný. Napište nám na ' + ORG.mail + ' a odhlásíme vás ručně.</p>');
  }
  if (p.a === 'admin') {
    if (!p.key || p.key !== prop_('ADMIN_KEY')) return page_('Nepřístupné', '<p>Chybný klíč.</p>');
    const t = HtmlService.createTemplateFromFile('Admin');
    t.key = p.key;
    return t.evaluate().setTitle('Newsletter – schválení').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return page_('Čtu ve městě', '<p>Opravdu čtenářský festival.</p>');
}

/* ---------- odhlášení odpovědí „odhlásit“ ---------- */

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
      const raw = m.getFrom();
      const from = ((raw.match(/<([^>]+)>/) || [null, raw])[1] || '').trim().toLowerCase();
      if (from === ORG.mail) return;
      const idx = emails.indexOf(from);
      if (idx >= 0) {
        const row = idx + 2;
        sh.getRange(row, COL.STAV).setValue(ST.ODHLASEN);
        sh.getRange(row, COL.ODHLASENO).setValue(new Date());
        matched = true;
      }
    });
    if (matched) t.addLabel(label);
  });
}

/* ---------- mazání nepotvrzených ---------- */

function purgePending() {
  const sh = sheet_();
  const data = sh.getDataRange().getValues();
  const limit = Date.now() - PENDING_DAYS * 86400000;
  for (let i = data.length - 1; i >= 1; i--) {
    const [, , stav, , zadost] = data[i];
    if (stav === ST.CEKA && zadost instanceof Date && zadost.getTime() < limit) sh.deleteRow(i + 1);
  }
}

/* ---------- newsletter ---------- */

const MESICE = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];

function firstSunday_(mesic) {         // "2027-01" -> "neděle 3. ledna 2027"
  const [y, m] = mesic.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
  return 'neděle ' + d.getDate() + '. ' + MESICE[m - 1] + ' ' + y;
}

function buildHtml_(d, unsubUrl) {
  const Y = YELLOW;
  const label = t => `<div style="font:bold 11px Arial,sans-serif;letter-spacing:3px;color:${Y};text-transform:uppercase;margin-bottom:6px">${esc_(t)}</div>`;
  const h = t => `<h2 style="font:bold 24px Arial,sans-serif;margin:0 0 10px;color:#fff">${esc_(t)}<span style="color:${Y}">.</span></h2>`;
  const link = (u, t) => url_(u) ? `<p style="margin:8px 0 0"><a href="${url_(u)}" style="color:${Y}">${esc_(t || 'Více zde')} →</a></p>` : '';
  const block = (lab, inner) => `<tr><td style="padding:28px 32px 0">${label(lab)}${inner}</td></tr>`;
  const p = t => `<p style="margin:0 0 8px;font:17px/1.6 Georgia,serif;color:#eee">${esc_(t)}</p>`;

  let rows = '';
  const k = d.kafe_a_kniha;
  if (k) {
    const datum = k.datum || firstSunday_(d.mesic);
    rows += block('Příští čtení', h('Kafe&kniha') +
      p(datum + (k.cas ? ', ' + k.cas : '')) +
      p((k.misto || '') + (k.adresa ? ', ' + k.adresa : '')) +
      (k.popis ? p(k.popis) : '') + link(k.odkaz, 'Podrobnosti'));
  }
  (d.festival || []).filter(i => i.zahrnout !== false).forEach((i, n) => {
    rows += block(n === 0 ? 'Z festivalu' : '&nbsp;', h(i.nadpis) + p(i.text) + link(i.odkaz));
  });
  const svet = (d.svet_knih || []).filter(i => i.zahrnout !== false);
  svet.forEach((i, n) => {
    rows += block(n === 0 ? 'Ze světa knih' : '&nbsp;', h(i.nadpis) + p(i.text) + link(i.odkaz, i.zdroj ? 'Zdroj: ' + i.zdroj : 'Více zde'));
  });
  if (d.vzkaz) rows += block('Vzkaz od týmu', p(d.vzkaz));

  return `<!doctype html><html><body style="margin:0;background:#000">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#000;color:#fff">
<tr><td style="padding:32px 32px 0;font:bold 44px Arial,sans-serif;color:#fff">čtu<span style="color:${Y}">.</span> <span style="font-size:16px;font-weight:normal">ve městě</span></td></tr>
${rows}
<tr><td style="padding:32px;font:14px/1.6 Arial,sans-serif;color:#aaa">
<a href="${ORG.web}" style="color:${Y}">ctuvemeste.cz</a> · <a href="${ORG.fb}" style="color:${Y}">Facebook</a> · <a href="${ORG.ig}" style="color:${Y}">Instagram</a><br><br>
${ORG.name}, ${ORG.addr}, IČ ${ORG.ico}<br>
Tento e-mail dostáváte, protože jste se přihlásili k odběru. <a href="${esc_(unsubUrl)}" style="color:#ccc">Odhlásit odběr</a> (nebo odpovězte slovem „odhlásit“).
</td></tr></table></td></tr></table></body></html>`;
}

function subject_(d) {
  const [y, m] = d.mesic.split('-').map(Number);
  const nom = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
  return 'Čtu ve městě: ' + nom[m - 1] + ' ' + y;
}

function unsubUrl_(token) { return prop_('WEBAPP_URL') + '?a=unsub&t=' + encodeURIComponent(token); }

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
  return { odebira: sub.length, zbyva: sub.filter(r => r[COL.POSLANO - 1] !== mesic).length, quota: MailApp.getRemainingDailyQuota() };
}

function adminPreview(key, d) {
  checkKey_(key);
  return buildHtml_(d, '#odhlasit-priklad');
}

function adminSend(key, d, mode) {
  checkKey_(key);
  const subj = subject_(d);
  if (mode === 'test') {
    admins_().forEach(a => MailApp.sendEmail({ to: a, subject: '[TEST] ' + subj, htmlBody: buildHtml_(d, '#test'), name: ORG.name, replyTo: ORG.mail }));
    return { poslano: admins_().length, zbyva: stats_(d.mesic).zbyva, test: true };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  const start = Date.now();
  let sent = 0;
  try {
    const sh = sheet_();
    const data = sh.getDataRange().getValues();
    let quota = MailApp.getRemainingDailyQuota();
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      if (r[COL.STAV - 1] !== ST.ODEBIRA || r[COL.POSLANO - 1] === d.mesic) continue;
      if (quota - sent < 5) break;                 // denní limit
      if (Date.now() - start > 4.5 * 60 * 1000) break;  // limit běhu skriptu; stačí kliknout znovu
      MailApp.sendEmail({ to: r[0], subject: subj, htmlBody: buildHtml_(d, unsubUrl_(r[COL.TOKEN - 1])), name: ORG.name, replyTo: ORG.mail });
      sh.getRange(i + 1, COL.POSLANO).setValue(d.mesic);
      sent++;
    }
  } finally {
    lock.releaseLock();
  }
  return { poslano: sent, zbyva: stats_(d.mesic).zbyva, test: false };
}
