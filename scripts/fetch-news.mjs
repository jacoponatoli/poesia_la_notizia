// POESIA LA NOTIZIA — scarica ogni giorno i titoli dei giornali e li salva in news.json
// Lo lancia GitHub Actions alle 6, 12 e 18 (vedi .github/workflows/news.yml).
//
// L'elenco delle testate NON è qui: è dentro index.html (cerca "const IT_FEEDS"),
// così pagina e script usano sempre la stessa lista. Per aggiungere un giornale basta
// aggiungere una riga lì: ["Nome", "indirizzo del feed RSS", "dominio.it"].
import { readFile, writeFile, mkdir } from "node:fs/promises";

const html = await readFile("index.html", "utf8");
const block = html.slice(html.indexOf("const LOCAL"), html.indexOf("function tfetch("));
const { LOCAL, IT_FEEDS, GN_TOPICS, gnUrl, NATIONAL, FOREIGN_FEEDS } =
  new Function(block + "; return { LOCAL, IT_FEEDS, GN_TOPICS, gnUrl, NATIONAL, FOREIGN_FEEDS };")();

const MAX_AGE_H = 48, PER_FEED = 40, PER_COUNTRY = 15, TR_PER_COUNTRY = 4, TR_W = 0.25, MIN_TOTAL = 30;

/* ---------- lettura dei feed ---------- */
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", agrave: "à", aacute: "á", egrave: "è", eacute: "é",
  igrave: "ì", iacute: "í", ograve: "ò", oacute: "ó", ugrave: "ù", uacute: "ú", Agrave: "À", Egrave: "È", Eacute: "É",
  laquo: "«", raquo: "»", lsquo: "'", rsquo: "'", ldquo: "“", rdquo: "”", hellip: "…", ndash: "–", mdash: "—" };
const ent = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED[n] ?? m);
const clean = s => ent(ent(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")))
  .replace(/<[^>]+>/g, "").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
function parse(xml){
  return (xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) || []).map(b => {
    const t = b.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const d = b.match(/<(pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/\1>/);
    return { title: t ? clean(t[1]) : "", date: d ? new Date(clean(d[2])) : null };
  });
}
const log = [];
async function titles(url, label){
  const c = new AbortController(), timer = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PoesiaLaNotizia/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const now = Date.now();
    const out = parse(await r.text())
      .filter(i => i.title.split(" ").length >= 3)
      .filter(i => !i.date || isNaN(i.date) || now - i.date.getTime() < MAX_AGE_H * 3600e3)
      .map(i => i.title);
    log.push(`${out.length ? "ok  " : "vuoto"} ${String(out.length).padStart(3)}  ${label}`);
    return out;
  } catch (e) {
    log.push(`FAIL       ${label}  (${e.message || e})`);
    return [];
  } finally { clearTimeout(timer); }
}
const splitGN = t => { const i = t.lastIndexOf(" - "); return i > 10 ? [t.slice(0, i).trim(), t.slice(i + 3).trim()] : [t, "Google News"]; };
const gnSearch = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=it&gl=IT&ceid=IT:it`;
const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/* ---------- testate italiane ---------- */
async function outlet([src, url, domain, w = 1]){
  let t = (await titles(url, src)).slice(0, PER_FEED);
  if (t.length < 3){
    const q = domain ? `site:${domain} when:2d` : `"${src}" when:2d`;
    t = t.concat((await titles(gnSearch(q), `${src} (riserva Google News)`)).map(splitGN)
      .filter(([, s]) => domain || norm(s).includes(norm(src))).map(([x]) => x).slice(0, PER_FEED));
  }
  return t.map(text => ({ src, text, w }));
}
const isExtra = f => !f[2] && IT_FEEDS.some(g => g[0] === f[0] && g[2]);
const italian = (await Promise.all([
  ...IT_FEEDS.filter(f => !isExtra(f)).map(outlet),
  ...IT_FEEDS.filter(isExtra).map(async ([src, url, , w = 1]) => (await titles(url, src + " (sezione)")).slice(0, PER_FEED).map(text => ({ src, text, w }))),
  ...GN_TOPICS.map(async tp => (await titles(gnUrl("IT:it", tp), "Google News Italia " + (tp || "prima pagina"))).map(x => {
    const [text, src] = splitGN(x); return { src, text, w: NATIONAL.has(src) ? 1 : LOCAL };
  }))
])).flat();

/* ---------- stampa estera ---------- */
const foreign = (await Promise.all(FOREIGN_FEEDS.map(async ([country, lang, name, url, ceid]) => {
  let items = (await titles(url, `${name} (${country})`)).slice(0, PER_COUNTRY).map(text => ({ src: name, country, lang, text }));
  if (items.length < 3 && ceid){
    items = (await titles(gnUrl(ceid), `Google News ${country}`)).slice(0, PER_COUNTRY)
      .map(x => { const [text, src] = splitGN(x); return { src, country, lang: ceid.split(":")[1].slice(0, 2), text }; });
  }
  return items;
}))).flat();

/* ---------- traduzioni in italiano ---------- */
// DeepL se nelle impostazioni del progetto c'è il segreto DEEPL_KEY, altrimenti MyMemory (gratuito, senza account).
// I titoli già tradotti nelle esecuzioni precedenti non vengono ritradotti.
let previous = {};
try { previous = JSON.parse(await readFile("news.json", "utf8")); } catch (e) {}
const cache = new Map((previous.items || []).filter(i => i.tr && i.orig).map(i => [i.orig, i.text]));
const MM_LANG = { zh: "zh-CN" };
async function deepl(texts){
  const key = process.env.DEEPL_KEY;
  const host = key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const body = new URLSearchParams(); texts.forEach(t => body.append("text", t)); body.append("target_lang", "IT");
  const r = await fetch(host + "/v2/translate", { method: "POST", headers: { Authorization: "DeepL-Auth-Key " + key }, body });
  if (!r.ok) throw new Error("DeepL HTTP " + r.status);
  return (await r.json()).translations.map(t => clean(t.text));
}
async function mymemory(text, lang){
  const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${MM_LANG[lang] || lang}|it`);
  const j = await r.json(), t = j?.responseData?.translatedText;
  if (!t || j.responseStatus != 200 || /MYMEMORY|QUERY LENGTH|INVALID/i.test(t)) throw new Error("MyMemory");
  return clean(t);
}
const pick = [], perC = {};
for (const it of foreign){ if (it.lang === "it") continue; perC[it.country] = (perC[it.country] || 0) + 1; if (perC[it.country] <= TR_PER_COUNTRY) pick.push(it); }
const todo = pick.filter(it => !cache.has(it.text));
let viaDeepl = 0, viaMM = 0;
if (process.env.DEEPL_KEY && todo.length){
  try { const out = await deepl(todo.map(t => t.text)); todo.forEach((it, i) => { if (out[i] && out[i] !== it.text){ cache.set(it.text, out[i]); viaDeepl++; } }); }
  catch (e) { log.push("FAIL       traduzioni DeepL  (" + e.message + ")"); }
}
for (const it of todo.filter(t => !cache.has(t.text))){
  try { cache.set(it.text, await mymemory(it.text, it.lang)); viaMM++; } catch (e) {}
}
const translated = pick.filter(it => cache.has(it.text)).map(it => ({ src: `${it.src}, ${it.country}`, text: cache.get(it.text), orig: it.text, w: TR_W, tr: true }))
  .filter(it => it.text.split(" ").length >= 3);
log.push(`traduzioni: ${translated.length} (nuove: DeepL ${viaDeepl}, MyMemory ${viaMM})`);

/* ---------- salvataggio ---------- */
const dedupe = arr => { const s = new Set(); return arr.filter(i => { const k = i.text.toLowerCase(); if (s.has(k)) return false; s.add(k); return true; }); };
const items = dedupe(italian), fx = dedupe(foreign);
console.log(log.sort().join("\n"));
console.log(`\n${items.length} titoli italiani da ${new Set(items.map(i => i.src)).size} testate, ${fx.length} esteri da ${new Set(fx.map(i => i.country)).size} paesi, ${translated.length} tradotti`);
if (items.length < MIN_TOTAL){
  console.log("Troppo pochi titoli: resta online il news.json precedente.");
} else {
  const now = new Date();
  const data = JSON.stringify({ updated: now.toISOString(), items: [...items, ...translated], foreign: fx }, null, 1);
  await writeFile("news.json", data);
  await mkdir("archivio", { recursive: true });
  const day = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });   // AAAA-MM-GG, ora italiana
  await writeFile(`archivio/${day}.json`, data);
  console.log(`news.json aggiornato e archiviato in archivio/${day}.json`);
}
