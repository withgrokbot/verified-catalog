// 0.63.0: page-to-markdown core, shared by the Worker route (/v1/products/page-to-markdown, MCP page_to_markdown) and the
// Apify Actor draft (same file, copied). Dependency-free and runtime-neutral (no DOM, no jsdom, no HTMLRewriter): a small
// HTML tree builder, a Readability-style main-content pick, cleanup (nav, footers, ads, cookie banners), token-efficient
// Markdown (no empty links, collapsed whitespace, absolute links, tables kept), login/paywall detection and robots.txt.
export const P2M_VERSION = "1.0.0";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title", "noscript", "template", "xmp"]);
// closing one of these implicitly closes an open <p>/<li>/... (simplified HTML5 rules)
const AUTO_CLOSE = { p: new Set(["p", "div", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "section", "article", "header", "footer", "form", "hr", "figure", "aside", "nav", "main"]), li: new Set(["li"]), dt: new Set(["dt", "dd"]), dd: new Set(["dt", "dd"]), tr: new Set(["tr"]), td: new Set(["td", "th", "tr"]), th: new Set(["td", "th", "tr"]), option: new Set(["option"]) };
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", laquo: "«", raquo: "»", times: "×", euro: "€", pound: "£", deg: "°", zwj: "", zwnj: "", shy: "" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; } catch (_) { return ""; } }
    const v = ENT[e.toLowerCase()]; return v !== undefined ? v : m;
  });
}
function parseAttrs(s) {
  const a = {}; const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g; let m;
  while ((m = re.exec(s))) { const k = m[1].toLowerCase(); if (!(k in a)) a[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""); }
  return a;
}
/** Parse HTML into {tag, attrs, children[], parent} nodes; text nodes are {text}. */
export function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: [] }; const stack = [root];
  const top = () => stack[stack.length - 1];
  const push = (n) => { n.parent = top(); top().children.push(n); };
  const close = (tag) => { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; return; } };
  const s = String(html || ""); const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) push({ text: decodeEntities(s.slice(last, m.index)) });
    last = re.lastIndex;
    if (!m[1]) continue;
    const tag = m[1].toLowerCase();
    if (m[0][1] === "/") { if (!VOID.has(tag)) close(tag); continue; }
    for (let i = stack.length - 1; i > 0; i--) { const t = stack[i].tag; if (AUTO_CLOSE[t] && AUTO_CLOSE[t].has(tag)) { stack.length = i; break; } if (["div", "section", "article", "table", "ul", "ol", "body"].includes(t)) break; }
    const n = { tag, attrs: parseAttrs(m[2] || ""), children: [] }; push(n);
    if (VOID.has(tag) || /\/\s*$/.test(m[2] || "")) continue;
    if (RAW.has(tag)) {
      const end = s.toLowerCase().indexOf("</" + tag, last); const stop = end < 0 ? s.length : end;
      n.children.push({ text: tag === "title" || tag === "textarea" ? decodeEntities(s.slice(last, stop)) : s.slice(last, stop), parent: n });
      const gt = end < 0 ? s.length : s.indexOf(">", end); last = re.lastIndex = gt < 0 ? s.length : gt + 1; continue;
    }
    stack.push(n);
  }
  if (last < s.length) push({ text: decodeEntities(s.slice(last)) });
  return root;
}
function* walk(n) { yield n; for (const c of n.children || []) yield* walk(c); }
const find = (n, pred) => { for (const x of walk(n)) if (x.tag && pred(x)) return x; return null; };
const findAll = (n, pred) => { const o = []; for (const x of walk(n)) if (x.tag && pred(x)) o.push(x); return o; };
export function textOf(n) { if (n.text != null) return n.text; let o = ""; for (const c of n.children || []) o += textOf(c); return o; }
const norm = (s) => s.replace(/\s+/g, " ").trim();

const DROP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "form", "button", "input", "select", "textarea", "nav", "footer", "aside", "dialog", "link", "meta", "head", "video", "audio", "map"]);
const JUNK = /(^|[\s_-])(cookie|consent|gdpr|banner|advert|ads?|ad-slot|adsbygoogle|sponsor(ed)?|promo|newsletter|subscribe|signup|share|sharing|social|related|recommend(ed)?|comments?|sidebar|breadcrumbs?|menu|navbar|nav|footer|masthead|popup|modal|overlay|toolbar|skip-link|outbrain|taboola|disqus|cta|interlanguage-link|mw-editsection|editsection|headerlink|anchor-link|heading-anchor|hash-link|mw-jump-link|vector-menu|vector-toc|toc|printfooter|catlinks|navbox|language-list|lang-list|ambox|mbox-small|wb-langlinks|noprint|mw-indicators)([\s_-]|$)/i;
const KEEP = /(^|[\s_-])(article|content|post|entry|main|body|story|markdown|prose|docs?)([\s_-]|$)/i;
function isJunk(n) {
  const a = n.attrs; const role = (a.role || "").toLowerCase();
  if (["navigation", "banner", "contentinfo", "complementary", "dialog", "alertdialog", "search", "menu", "menubar"].includes(role)) return true;
  if (a.hidden !== undefined || a["aria-hidden"] === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || "")) return true;
  const idc = (a.id || "") + " " + (a.class || "");
  if (idc.trim() && JUNK.test(idc) && !(KEEP.test(idc) && !/cookie|consent|advert|sponsor/i.test(idc))) {
    if (["html", "body", "main", "article"].includes(n.tag)) return false;
    return true;
  }
  return false;
}
function prune(n, inMain = false) {
  const keep = [];
  for (const c of n.children || []) {
    if (c.text != null) { keep.push(c); continue; }
    if (DROP_TAGS.has(c.tag) || isJunk(c)) continue;
    if (c.tag === "header" && !inMain) continue; // site header; an <article>'s own <header> keeps the title
    prune(c, inMain || c.tag === "article" || c.tag === "main"); keep.push(c);
  }
  n.children = keep;
}
const linkText = (n) => findAll(n, (x) => x.tag === "a").reduce((t, a) => t + norm(textOf(a)).length, 0);
/** Readability-style pick: <article>/<main> when it holds most of the text, else the best-scoring block. */
function pickMain(body) {
  const total = norm(textOf(body)).length || 1;
  const cands = findAll(body, (x) => x.tag === "article" || x.tag === "main" || (x.attrs.role || "") === "main" || x.attrs.itemprop === "articleBody");
  let best = null, bestLen = 0;
  for (const c of cands) { const l = norm(textOf(c)).length; if (l > bestLen) { best = c; bestLen = l; } }
  if (best && bestLen > 200 && bestLen / total > 0.25) return best;
  const score = new Map();
  for (const p of findAll(body, (x) => ["p", "pre", "td", "li", "blockquote"].includes(x.tag))) {
    const t = norm(textOf(p)); if (t.length < 25) continue;
    const s = 1 + (t.match(/,/g) || []).length + Math.min(3, Math.floor(t.length / 100));
    if (p.parent) score.set(p.parent, (score.get(p.parent) || 0) + s);
    if (p.parent && p.parent.parent) score.set(p.parent.parent, (score.get(p.parent.parent) || 0) + s / 2);
  }
  let top = null, topS = 0;
  for (const [n, s] of score) { if (!n.tag || n.tag === "#root") continue; const len = norm(textOf(n)).length || 1; const adj = s * (1 - Math.min(0.9, linkText(n) / len)); if (adj > topS) { top = n; topS = adj; } }
  if (!top) return body;
  // climb while the parent adds substantial content (sibling sections of the same article)
  while (top.parent && top.parent.tag && top.parent !== body && norm(textOf(top.parent)).length < norm(textOf(top)).length * 1.6) top = top.parent;
  return top;
}

function absUrl(href, base) { try { const u = new URL(String(href).trim(), base); return /^(https?|mailto):$/.test(u.protocol) ? u.href : null; } catch (_) { return null; } }
const esc = (s) => s.replace(/([\\`*_[\]])/g, "\\$1");
function inline(n, ctx) {
  if (n.text != null) return esc(n.text.replace(/\s+/g, " "));
  const kids = () => (n.children || []).map((c) => inline(c, ctx)).join("");
  switch (n.tag) {
    case "br": return "\n";
    case "img": { const alt = norm(n.attrs.alt || ""); const src = absUrl(n.attrs.src || n.attrs["data-src"] || "", ctx.base); return alt && src && !src.startsWith("data:") ? `![${esc(alt)}](${src})` : ""; }
    case "a": {
      const t = kids().replace(/\s+/g, " ").trim(); const h = absUrl(n.attrs.href || "", ctx.base);
      if (!t || /^[¶#§🔗]$/.test(t)) return ""; if (!h || /^javascript:/i.test(n.attrs.href || "")) return t;
      ctx.links.add(h); return `[${t}](${h})`;
    }
    case "code": case "kbd": case "samp": { const t = textOf(n).replace(/\s+/g, " ").trim(); return t ? "`" + t.replace(/`/g, "\\`") + "`" : ""; }
    case "strong": case "b": { const t = kids().trim(); return t ? `**${t}**` : ""; }
    case "em": case "i": { const t = kids().trim(); return t ? `_${t}_` : ""; }
    case "del": case "s": { const t = kids().trim(); return t ? `~~${t}~~` : ""; }
    case "sup": case "sub": return kids();
    default: return BLOCK.has(n.tag) ? "\n\n" + block(n, ctx) + "\n\n" : kids();
  }
}
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "blockquote", "table", "hr", "figure", "figcaption", "dl", "dt", "dd", "details", "summary", "address", "center", "body", "html"]);
function cell(n, ctx) { return inline(n, ctx).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim(); }
function table(n, ctx) {
  const rows = findAll(n, (x) => x.tag === "tr").filter((r) => { let p = r.parent; while (p && p.tag !== "table") p = p.parent; return p === n; });
  const grid = rows.map((r) => r.children.filter((c) => c.tag === "td" || c.tag === "th").map((c) => cell(c, ctx))).filter((r) => r.some((x) => x));
  if (!grid.length) return "";
  const w = Math.max(...grid.map((r) => r.length));
  if (w === 1) return grid.map((r) => r[0]).join("\n\n"); // layout table
  const pad = (r) => r.concat(Array(w - r.length).fill(""));
  return [`| ${pad(grid[0]).join(" | ")} |`, `|${" --- |".repeat(w)}`, ...grid.slice(1).map((r) => `| ${pad(r).join(" | ")} |`)].join("\n");
}
function list(n, ctx) {
  let i = parseInt(n.attrs.start || "1", 10) || 1; const out = [];
  for (const li of n.children.filter((c) => c.tag === "li")) {
    const mark = n.tag === "ol" ? `${i++}.` : "-";
    const body = block(li, ctx).trim().replace(/\n\n(?=(?:-|\d+\.) )/g, "\n"); if (!body) continue;
    const pad = " ".repeat(mark.length + 1);
    out.push(mark + " " + body.split("\n").map((l, k) => (k === 0 || !l ? l : pad + l)).join("\n"));
  }
  return out.join("\n");
}
function block(n, ctx) {
  const parts = []; let buf = "";
  const flush = () => { const t = buf.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim(); if (t) parts.push(t); buf = ""; };
  for (const c of n.children || []) {
    if (c.text != null || !BLOCK.has(c.tag)) { buf += inline(c, ctx); continue; }
    flush();
    const t = c.tag; let o = "";
    if (/^h[1-6]$/.test(t)) { const x = inline(c, ctx).replace(/\s+/g, " ").trim(); if (x) o = "#".repeat(+t[1]) + " " + x; }
    else if (t === "ul" || t === "ol") o = list(c, ctx);
    else if (t === "pre") { const code = textOf(c).replace(/^\n+|\s+$/g, ""); const lang = ((find(c, (x) => x.tag === "code") || c).attrs.class || "").match(/(?:language|lang)-([\w+-]+)/); if (code) o = "```" + (lang ? lang[1] : "") + "\n" + code + "\n```"; }
    else if (t === "blockquote") { const x = block(c, ctx).trim(); if (x) o = x.split("\n").map((l) => "> " + l).join("\n"); }
    else if (t === "table") o = table(c, ctx);
    else if (t === "hr") o = "---";
    else o = block(c, ctx);
    if (o && o.trim()) parts.push(o.trim());
  }
  flush();
  return parts.join("\n\n");
}
export function tidy(md) {
  return md.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\[\]\([^)]*\)/g, "").trim() + "\n";
}

const LOGIN_RE = /\b(sign|log) ?in to (continue|read|view|access)|please (sign|log) ?in|you must be logged in|login required|create a free account to (continue|read)/i;
const PAYWALL_RE = /\b(subscribe to (continue|keep) reading|this (article|story|content) is (only )?(available )?(for|to) (paid )?subscribers|subscribers only|already a subscriber\?|you('ve| have) reached your (free )?(article|story) limit|unlock this (article|story))/i;
/** Returns null or a reason: login_wall | paywall. Light text on the page plus a wall signal; ld+json isAccessibleForFree=false. */
export function detectWall(root, mainText) {
  const words = mainText.split(/\s+/).filter(Boolean).length;
  const all = norm(textOf(find(root, (x) => x.tag === "body") || root)).slice(0, 20000);
  for (const s of findAll(root, (x) => x.tag === "script" && /ld\+json/i.test(x.attrs.type || ""))) if (/"isAccessibleForFree"\s*:\s*(false|"false")/i.test(textOf(s)) && words < 400) return "paywall";
  if (PAYWALL_RE.test(all) && words < 400) return "paywall";
  const pw = find(root, (x) => x.tag === "input" && (x.attrs.type || "").toLowerCase() === "password");
  if ((pw && words < 150) || (LOGIN_RE.test(all) && words < 150)) return "login_wall";
  return null;
}

/**
 * Convert one HTML page to LLM-ready Markdown.
 * @returns {{url,title,description,markdown,links,word_count,token_estimate,blocked?:string}}
 */
export function htmlToMarkdown(html, url, opts = {}) {
  const root = parseHtml(html);
  const meta = (k) => { const m = find(root, (x) => x.tag === "meta" && ((x.attrs.name || x.attrs.property || "").toLowerCase() === k)); return m ? norm(m.attrs.content || "") : ""; };
  const tEl = find(root, (x) => x.tag === "title");
  const baseEl = find(root, (x) => x.tag === "base" && x.attrs.href);
  const base = (baseEl && absUrl(baseEl.attrs.href, url)) || url;
  const title = meta("og:title") || (tEl ? norm(textOf(tEl)) : "");
  const description = meta("description") || meta("og:description");
  const wallProbe = parseHtml(html); // unpruned copy: wall prompts often sit in modals that cleanup drops
  const body = find(root, (x) => x.tag === "body") || root;
  prune(body);
  const main = opts.fullPage ? body : pickMain(body);
  const ctx = { base, links: new Set() };
  let md = tidy(block({ tag: "#frag", attrs: {}, children: [main] }, ctx));
  if (title && !/^# /m.test(md.slice(0, 400))) md = "# " + title + "\n\n" + md;
  const words = md.replace(/[#>*_`|\-\[\]()!]/g, " ").split(/\s+/).filter(Boolean).length;
  const blocked = detectWall(wallProbe, md) || (words < 3 ? "empty_content" : null);
  return { url, title, description, markdown: md, links: [...ctx.links].slice(0, opts.maxLinks || 500), word_count: words, token_estimate: Math.ceil(md.length / 4), ...(blocked ? { blocked } : {}) };
}

// ------------------------------------------------------------------ robots.txt (RFC 9309: longest match wins, Allow on tie)
export function parseRobots(txt, agent = "*") {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of String(txt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); const i = line.indexOf(":"); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === "user-agent") { if (!lastWasAgent || !cur) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false; if (!cur) continue;
    if (k === "allow" || k === "disallow") cur.rules.push({ allow: k === "allow", path: v });
    else if (k === "crawl-delay") { const d = parseFloat(v); if (Number.isFinite(d)) cur.delay = d; }
  }
  const a = String(agent).toLowerCase();
  const mine = groups.filter((g) => g.agents.some((x) => x !== "*" && a.includes(x)));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const rules = use.flatMap((g) => g.rules).filter((r) => r.path || !r.allow);
  const delay = use.map((g) => g.delay).find((d) => d != null) ?? null;
  const rx = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, (c) => (c === "$" ? "$" : "\\" + c)).replace(/\\\$$/, "$").replace(/\*/g, ".*"));
  return {
    crawlDelay: delay,
    isAllowed(pathOrUrl) {
      let p = String(pathOrUrl); try { const u = new URL(p); p = u.pathname + u.search; } catch (_) {}
      let best = null;
      for (const r of rules) { if (!r.path) continue; if (rx(r.path).test(p) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r; }
      return !best || best.allow;
    },
  };
}
