// A review tool for scanned rows the machine readers couldn't settle: rows
// they disagree on, rows only the second reader found, and rows neither could
// read. Local only: it listens on 127.0.0.1, it isn't part of the site, and
// nothing deploys it. Decisions are saved as you go to
// .holdings-review/decisions.json (gitignored); the next build applies them,
// and they reach the site only inside the sealed data/holdings.json.enc.
//
//   pnpm review-scans            # opens http://127.0.0.1:4390
//   pnpm holdings:publish        # afterwards: rebuild, seal, commit, push (deploys)
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { CACHE } from "../common.js";
import { VALUES } from "./annual.js";
import { AMOUNTS, type ScanPage } from "./ptr.js";
import { DECISIONS, QUEUE, type Decision, type ReviewItem } from "./resolve.js";

const PORT = Number(process.env.REVIEW_PORT ?? 4390);
const PAGES = `${CACHE}/scan/review-pages`;
const LONG_SIDE = 2600;

if (!fs.existsSync(QUEUE)) {
  console.error(`No review queue yet: run \`tsx src/scripts/disclosures/house-build.ts\` first (it writes ${QUEUE}).`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(DECISIONS), { recursive: true });
fs.mkdirSync(PAGES, { recursive: true });

const decisions = (): Record<string, Decision> => (fs.existsSync(DECISIONS) ? JSON.parse(fs.readFileSync(DECISIONS, "utf8")) : {});
function saveDecision(key: string, d: Decision | null) {
  const all = decisions();
  if (d) all[key] = d;
  else delete all[key];
  // Write then rename, so a crash never leaves half a file.
  fs.writeFileSync(`${DECISIONS}.tmp`, JSON.stringify(all, null, 1));
  fs.renameSync(`${DECISIONS}.tmp`, DECISIONS);
  fs.appendFileSync(path.join(path.dirname(DECISIONS), "log.jsonl"), JSON.stringify({ key, decision: d, at: new Date().toISOString() }) + "\n");
}

const scans = new Map<string, ScanPage[]>();
function scanPage(docId: string, page: number) {
  if (!scans.has(docId)) {
    const file = `${CACHE}/scan/${docId}.jsonl`;
    scans.set(docId, fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ScanPage) : []);
  }
  return scans.get(docId)!.find((p) => p.page === page);
}

/** Words that say nothing about which row a name is on. */
const GENERIC = new Set(["COMMON", "STOCK", "INC", "CMN", "CORP", "CORPORATION", "CLASS", "THE", "COMPANY", "HOLDINGS", "GROUP", "LTD", "PLC", "SHS", "COM"]);

/**
 * Where on the page a row only the second reader found sits: the line with
 * its trade date, if exactly one does, else the words that best match its name.
 */
function locate(item: ReviewItem) {
  if (item.y0 !== undefined || !item.b) return item;
  const words = scanPage(item.docId, item.page)?.words ?? [];
  const [y, m, d] = (item.b.date ?? "").split("-");
  const dated = y ? words.filter((w) => new RegExp(`^0?${Number(m)}[/.-]0?${Number(d)}[/.-](20)?${y.slice(2)}\\b`).test(w.t)) : [];
  const want = (item.b.asset ?? "").toUpperCase().split(/\W+/).filter((t) => t.length > 2 && !GENERIC.has(t));
  const named = words
    .map((w) => ({ w, score: want.filter((t) => w.t.toUpperCase().includes(t)).length / Math.max(1, want.length) }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  // Several rows can share a date: then the name decides among them.
  const pick =
    dated.length === 1 ? dated[0] : dated.find((dw) => named.some((n) => Math.abs((n.w.y0 + n.w.y1) / 2 - (dw.y0 + dw.y1) / 2) < 0.012)) ?? named[0]?.w;
  return pick ? { ...item, y0: pick.y0 - 0.008, y1: pick.y1 + 0.008, located: true } : item;
}

function pagePng(docId: string, page: number) {
  const file = `${PAGES}/${docId}-${page}.png`;
  if (!fs.existsSync(file)) {
    const rotation = scanPage(docId, page)?.rotation ?? 0;
    execFileSync(`${CACHE}/scan/render`, [`${CACHE}/house/pdf/${docId}.pdf`, String(page), String(rotation), String(LONG_SIDE), file]);
  }
  return fs.readFileSync(file);
}

const money = (n: number) => (n >= 1e6 ? `$${n / 1e6}M` : `$${n.toLocaleString("en-US")}`);
const labels = (table: [number, number | null][]) =>
  table.map(([a, b], i) => `${String.fromCharCode(65 + i)}  ${b === null ? `over ${money(a - 1)}` : a === b ? money(a) : `${money(a)}–${money(b)}`}`);
// The last column on both forms is the spouse/child "over $1,000,000" box.
const AMOUNT_LABELS = labels(AMOUNTS).map((l, i) => (i === 10 ? "K  spouse/child asset over $1M" : l));
const VALUE_LABELS = labels(VALUES).map((l, i) => (i === 0 ? "A  none" : i === 12 ? "M  spouse/child asset over $1M" : l));

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const send = (code: number, type: string, body: string | Buffer) => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  try {
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", PAGE);
    if (url.pathname === "/api/queue") {
      const items = (JSON.parse(fs.readFileSync(QUEUE, "utf8")) as ReviewItem[]).map(locate);
      return send(200, "application/json", JSON.stringify({ items, decisions: decisions(), amounts: AMOUNT_LABELS, values: VALUE_LABELS }));
    }
    if (url.pathname === "/api/decision" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { key, decision } = JSON.parse(body) as { key: string; decision: Decision | null };
        const known = (JSON.parse(fs.readFileSync(QUEUE, "utf8")) as ReviewItem[]).some((i) => i.key === key);
        if (!known) return send(400, "text/plain", "not a row in the review queue");
        saveDecision(key, decision ? { ...decision, at: new Date().toISOString() } : null);
        send(200, "application/json", "{}");
      });
      return;
    }
    const page = url.pathname.match(/^\/page\/(\d+)\/(\d+)\.png$/);
    if (page) return send(200, "image/png", pagePng(page[1]!, Number(page[2])));
    send(404, "text/plain", "not found");
  } catch (e) {
    send(500, "text/plain", String(e));
  }
});

// Loopback only: this is never served to anyone else.
server.listen(PORT, "127.0.0.1", () => {
  const at = `http://127.0.0.1:${PORT}/`;
  console.log(`Scan review: ${at}  (Ctrl-C to stop; decisions save as you go to ${DECISIONS})`);
  if (!process.env.NO_OPEN) spawn("open", [at], { stdio: "ignore", detached: true }).unref();
});

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Scan review</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #ddd; --a: #1f5fbf; --b: #9a4dbf; --diff: #fff1c2; --ok: #1d7a3a; --bad: #b3261e; --band: rgba(255, 196, 0, .28); }
  @media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #ececec; --muted: #9a9a9a; --line: #333; --a: #7fb0ff; --b: #d29bf0; --diff: #4a3f12; --ok: #6fd08d; --bad: #ff8a80; --band: rgba(255, 196, 0, .22); } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.4 -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  header { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 10px 16px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 2; }
  header h1 { font-size: 16px; margin: 0; }
  header .counts { color: var(--muted); font-variant-numeric: tabular-nums; }
  select, input, button { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; }
  main { padding: 12px 16px 40px; max-width: 1400px; margin: 0 auto; }
  .meta { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 8px; }
  .meta .who { font-weight: 600; }
  .meta .kind { padding: 1px 6px; border-radius: 3px; border: 1px solid var(--line); font-size: 13px; }
  .meta .why { color: var(--muted); font-size: 13px; }
  .status { margin-left: auto; font-size: 13px; }
  .status.done { color: var(--ok); } .status.unreadable { color: var(--bad); }
  .crop { position: relative; overflow: hidden; border: 1px solid var(--line); background: #fff; height: 240px; }
  .crop img { position: absolute; left: 0; width: 100%; }
  .crop .band { position: absolute; left: 0; right: 0; background: var(--band); pointer-events: none; }
  .crop .note { position: absolute; right: 6px; top: 4px; font-size: 12px; background: var(--bg); padding: 1px 5px; border-radius: 3px; }
  table { border-collapse: collapse; margin-top: 12px; width: 100%; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-weight: 600; font-size: 13px; color: var(--muted); }
  th.a { color: var(--a); } th.b { color: var(--b); }
  td.field { color: var(--muted); width: 110px; }
  td.diff { background: var(--diff); }
  td.empty { color: var(--muted); }
  td input[type=text] { width: 100%; }
  .keys { margin-top: 14px; color: var(--muted); font-size: 13px; }
  kbd { font: 12px ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; }
  .full { position: fixed; inset: 0; background: rgba(0,0,0,.75); overflow: auto; z-index: 5; display: none; }
  .full.open { display: block; }
  .full .wrap { position: relative; width: min(1600px, 96vw); margin: 2vh auto; background: #fff; }
  .full img { width: 100%; display: block; }
  .full .band { position: absolute; left: 0; right: 0; background: var(--band); outline: 2px solid #e0a800; }
  .toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--fg); color: var(--bg); padding: 6px 12px; border-radius: 4px; opacity: 0; transition: opacity .2s; }
  .toast.show { opacity: 1; }
  .empty-state { padding: 40px; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Scan review</h1>
  <label>Member <select id="member"></select></label>
  <label>Kind <select id="kind">
    <option value="">All</option>
    <option value="disputed">Readers disagree</option>
    <option value="second-only">Only the second reader found</option>
    <option value="unread">Neither could read</option>
  </select></label>
  <label>Form <select id="form"><option value="">Both</option><option value="ptr">Trade reports</option><option value="annual">Annual (Schedule A)</option></select></label>
  <label><input type="checkbox" id="showDone"> Show decided</label>
  <span class="counts" id="counts"></span>
</header>
<main id="main"></main>
<div class="full" id="full"><div class="wrap"><img id="fullImg" alt=""><div class="band" id="fullBand"></div></div></div>
<div class="toast" id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
let items = [], decisions = {}, amounts = [], values = [], view = [], at = 0, editing = false;
const undo = [];
const KIND = { disputed: "Readers disagree", "second-only": "Only the second reader found", unread: "Neither could read" };
const OWNER = { self: "Member", spouse: "Spouse (SP)", joint: "Joint (JT)", child: "Child (DC)" };
const TXL = { purchase: "Purchase", sale: "Sale", exchange: "Exchange" };

function toast(t) { const el = $("toast"); el.textContent = t; el.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 1400); }
function fieldsFor(item) {
  return item.form === "ptr"
    ? [["asset", "Asset"], ["owner", "Owner"], ["tx", "Type"], ["partial", "Partial"], ["date", "Trade date"], ["notified", "Notified"], ["column", "Amount"]]
    : [["asset", "Asset"], ["owner", "Owner"], ["column", "Value"]];
}
function show(item, f, k) {
  const v = f?.[k];
  if (v === undefined || v === null || v === "") return "";
  if (k === "owner") return OWNER[v] ?? v;
  if (k === "tx") return TXL[v] ?? v;
  if (k === "partial") return v ? "Yes" : "No";
  if (k === "column") return (item.form === "ptr" ? amounts : values)[v.charCodeAt(0) - 65] ?? v;
  return v;
}
function complete(item, f) {
  if (!f || !f.asset || !f.column || !f.owner) return false;
  return item.form === "annual" || (f.date && f.tx);
}

async function load() {
  const r = await (await fetch("/api/queue")).json();
  items = r.items; decisions = r.decisions; amounts = r.amounts; values = r.values;
  // Filters from the address (?member=K000389&kind=disputed) win over the last session's.
  const saved = { ...JSON.parse(localStorage.getItem("scan-review") || "{}"), ...Object.fromEntries(new URLSearchParams(location.search)) };
  const members = [...new Map(items.map((i) => [i.bioguide, i.member])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  $("member").innerHTML = '<option value="">All</option>' + members.map(([id, name]) => {
    const n = items.filter((i) => i.bioguide === id).length;
    return '<option value="' + id + '">' + name + " (" + n + ")</option>";
  }).join("");
  for (const id of ["member", "kind", "form"]) { $(id).value = saved[id] ?? ""; $(id).onchange = () => { persist(); filter(true); }; }
  $("showDone").checked = !!saved.showDone; $("showDone").onchange = () => { persist(); filter(true); };
  filter(true, saved.key);
}
function persist() {
  localStorage.setItem("scan-review", JSON.stringify({ member: $("member").value, kind: $("kind").value, form: $("form").value, showDone: $("showDone").checked, key: view[at]?.key }));
}
function filter(resume, key) {
  const m = $("member").value, k = $("kind").value, f = $("form").value, done = $("showDone").checked;
  view = items.filter((i) => (!m || i.bioguide === m) && (!k || i.kind === k) && (!f || i.form === f) && (done || !decisions[i.key]));
  at = key ? Math.max(0, view.findIndex((i) => i.key === key)) : 0;
  if (resume && !key) { const first = view.findIndex((i) => !decisions[i.key]); at = first < 0 ? 0 : first; }
  render();
}
function counts() {
  const scope = items.filter((i) => (!$("member").value || i.bioguide === $("member").value) && (!$("form").value || i.form === $("form").value));
  const by = (kind) => { const s = scope.filter((i) => i.kind === kind); return s.filter((i) => decisions[i.key]).length + "/" + s.length; };
  const done = scope.filter((i) => decisions[i.key]).length;
  $("counts").textContent = "Decided " + done + " of " + scope.length + " · disagree " + by("disputed") + " · second only " + by("second-only") + " · unread " + by("unread") + (view.length ? " · row " + (at + 1) + " of " + view.length : "");
}

function render() {
  counts();
  const item = view[at];
  if (!item) { $("main").innerHTML = '<div class="empty-state">Nothing left here. Change the filters, or tick “Show decided”.</div>'; return; }
  const d = decisions[item.key];
  const answer = d?.fields ?? (complete(item, item.b) ? item.b : null) ?? { ...(item.a ?? {}), ...Object.fromEntries(Object.entries(item.b ?? {}).filter(([, v]) => v !== undefined)) };
  const rows = fieldsFor(item).map(([k, label]) => {
    const a = show(item, item.a, k), b = show(item, item.b, k);
    const diff = item.a && item.b && a && b && a !== b;
    return "<tr><td class=field>" + label + "</td><td class='" + (diff ? "diff" : "") + (a ? "" : " empty") + "'>" + (esc(a) || "—") + "</td><td class='" + (diff ? "diff" : "") + (b ? "" : " empty") + "'>" + (esc(b) || "—") + "</td><td>" + input(item, k, answer) + "</td></tr>";
  }).join("");
  const status = d ? (d.action === "unreadable" ? "<span class='status unreadable'>Marked unreadable</span>" : "<span class='status done'>Saved (" + ({ a: "reading A", b: "reading B", edit: "edited" })[d.action] + ")</span>") : "<span class=status></span>";
  $("main").innerHTML =
    "<div class=meta><span class=who>" + esc(item.member) + "</span><span class=kind>" + KIND[item.kind] + "</span><span>" + (item.form === "ptr" ? "Trade report" : "Annual report, Schedule A") + " · page " + (item.page + 1) + " · <a href='" + item.docUrl + "' target=_blank>open the PDF</a> · <a href='#' id=fullLink>full page</a> <kbd>f</kbd></span><span class=why>" + esc(item.why.join("; ")) + "</span>" + status + "</div>" +
    "<div class=crop id=crop><img id=cropImg alt='Scan of the row'><div class=band id=band></div>" + (item.y0 === undefined ? "<div class=note>Row position unknown: showing the top of the page</div>" : item.located ? "<div class=note>Located by date and name: check it's the right row</div>" : "") + "</div>" +
    "<table><thead><tr><th></th><th class=a>A · first reader <kbd>a</kbd></th><th class=b>B · second reader <kbd>b</kbd></th><th>Answer <kbd>e</kbd> edit, <kbd>Enter</kbd> save</th></tr></thead><tbody>" + rows + "</tbody></table>" +
    "<div class=keys><kbd>a</kbd> take A · <kbd>b</kbd> take B · <kbd>e</kbd> edit · <kbd>x</kbd> unreadable · <kbd>s</kbd>/<kbd>→</kbd> skip · <kbd>←</kbd> back · <kbd>z</kbd> undo · <kbd>f</kbd> full page · in the answer: <kbd>Enter</kbd> save, <kbd>Esc</kbd> leave</div>";
  const img = $("cropImg");
  img.onload = () => position(item);
  img.src = "/page/" + item.docId + "/" + item.page + ".png";
  $("fullLink").onclick = (e) => { e.preventDefault(); full(true); };
  for (const el of document.querySelectorAll("#main [data-k]")) {
    el.addEventListener("focus", () => (editing = true));
    el.addEventListener("blur", () => (editing = false));
  }
  editing = false;
  persist();
}
function input(item, k, f) {
  const v = f?.[k];
  if (k === "owner") return "<select data-k=owner>" + (v ? "" : "<option value='' selected>?</option>") + Object.entries(OWNER).map(([o, l]) => "<option value=" + o + (v === o ? " selected" : "") + ">" + l + "</option>").join("") + "</select>";
  if (k === "tx") return "<select data-k=tx><option value=''>?</option>" + Object.entries(TXL).map(([o, l]) => "<option value=" + o + (v === o ? " selected" : "") + ">" + l + "</option>").join("") + "</select>";
  if (k === "partial") return "<input type=checkbox data-k=partial" + (v ? " checked" : "") + ">";
  if (k === "column") return "<select data-k=column><option value=''>?</option>" + (item.form === "ptr" ? amounts : values).map((l) => "<option value=" + l[0] + (v === l[0] ? " selected" : "") + ">" + esc(l) + "</option>").join("") + "</select>";
  return "<input type=text data-k=" + k + " value='" + esc(v ?? "") + "' placeholder='" + (k === "asset" ? "" : "YYYY-MM-DD") + "'>";
}
function position(item) {
  const img = $("cropImg"), crop = $("crop"), band = $("band");
  const h = img.clientHeight;
  const y0 = item.y0 ?? 0.1, y1 = item.y1 ?? 0.14;
  const mid = (y0 + y1) / 2 * h;
  const top = Math.max(0, Math.min(h - crop.clientHeight, mid - crop.clientHeight / 2));
  img.style.top = -top + "px";
  band.style.display = item.y0 === undefined ? "none" : "block";
  band.style.top = y0 * h - top + "px";
  band.style.height = (y1 - y0) * h + "px";
}
function full(open) {
  const item = view[at];
  if (!item) return;
  $("full").classList.toggle("open", open);
  if (!open) return;
  $("fullImg").src = "/page/" + item.docId + "/" + item.page + ".png";
  const band = $("fullBand");
  band.style.display = item.y0 === undefined ? "none" : "block";
  band.style.top = (item.y0 ?? 0) * 100 + "%";
  band.style.height = ((item.y1 ?? 0) - (item.y0 ?? 0)) * 100 + "%";
  $("fullImg").onload = () => band.scrollIntoView({ block: "center" });
}
$("full").onclick = () => full(false);
function esc(s) { return String(s).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]); }

function answerFields() {
  const f = {};
  for (const el of document.querySelectorAll("#main [data-k]")) {
    const k = el.dataset.k;
    const v = el.type === "checkbox" ? el.checked : el.value.trim();
    if (v !== "" && v !== false) f[k] = v;
  }
  if (f.tx !== "sale") delete f.partial;
  return f;
}
async function decide(action, fields) {
  const item = view[at];
  if (!item) return;
  if (action !== "unreadable" && !complete(item, fields)) {
    toast("That reading is incomplete: fill in the rest, then Enter");
    startEdit(fields);
    return;
  }
  if (fields?.date && !/^\\d{4}-\\d{2}-\\d{2}$/.test(fields.date)) { toast("Dates as YYYY-MM-DD"); startEdit(fields); return; }
  const decision = action === "unreadable" ? { action } : { action, fields };
  undo.push({ key: item.key, before: decisions[item.key] ?? null, at });
  await post(item.key, decision);
  decisions[item.key] = decision;
  toast(action === "unreadable" ? "Marked unreadable" : "Saved");
  next();
}
async function post(key, decision) {
  const r = await fetch("/api/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, decision }) });
  if (!r.ok) { toast("Couldn't save!"); throw new Error("save failed"); }
}
function next() {
  // Decided rows drop out of the view unless they're shown.
  if (!$("showDone").checked) { view.splice(at, 1); if (at >= view.length) at = Math.max(0, view.length - 1); }
  else at = Math.min(view.length - 1, at + 1);
  render();
}
async function undoLast() {
  const u = undo.pop();
  if (!u) return toast("Nothing to undo");
  await post(u.key, u.before);
  if (u.before) decisions[u.key] = u.before; else delete decisions[u.key];
  filter(false, u.key);
  toast("Undone");
}
function startEdit(prefill) {
  if (prefill) { const item = view[at]; for (const el of document.querySelectorAll("#main [data-k]")) { const v = prefill[el.dataset.k]; if (el.type === "checkbox") el.checked = !!v; else if (v !== undefined) el.value = v; } }
  const first = [...document.querySelectorAll("#main [data-k]")].find((el) => !el.value) ?? document.querySelector("#main [data-k]");
  first?.focus();
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ($("full").classList.contains("open")) { if (e.key === "Escape" || e.key === "f") full(false); return; }
  if (editing) {
    if (e.key === "Enter") { e.preventDefault(); decide("edit", answerFields()); }
    else if (e.key === "Escape") { document.activeElement.blur(); }
    return;
  }
  const item = view[at];
  const k = e.key;
  if (k === "a" && item) decide("a", item.a);
  else if (k === "b" && item) decide("b", item.b);
  else if (k === "e") { e.preventDefault(); startEdit(); }
  else if (k === "x") decide("unreadable");
  else if (k === "s" || k === "ArrowRight" || k === "j") { at = Math.min(view.length - 1, at + 1); render(); }
  else if (k === "ArrowLeft" || k === "k") { at = Math.max(0, at - 1); render(); }
  else if (k === "z") undoLast();
  else if (k === "f") full(true);
  else return;
  e.preventDefault();
});
window.addEventListener("resize", () => view[at] && position(view[at]));
load();
</script>
</body>
</html>`;
