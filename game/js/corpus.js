/* 墨墨 · 语料库（corpus.js）
   =====================================================================
   为什么要有这个模块（2026-10-20，jam 主题「涌现」的新证据链）：

     对话模块 chat.js 的历史只留最近 8 条 —— 那是「她还记得刚才」。
     可「语言涌现」需要的不是刚才，而是一份**长期沉淀、可检索、可对照**的私人语料：
       玩家自己说过的每一句话，和墨墨回过的每一句话，分开存、一起长。
     玩家教她词 → 字海（wordsea.js）→ 她现在说的话，最后又落回这份语料里。
     打开语料库时把词频 Top 12 广播给字海（momo:corpus → MomoWordSea.fall），
     让「你今天说的话」当场变成她屋里落下的一阵字雨。

   AntConc 式检索（作者点名要借鉴）：
     · 检索框：英文单词 / 中文子串，大小写不敏感；
     · KWIC：命中词前后各 ~18 字，命中处高亮（<mark>）；
     · 过滤：说话人（我的输入 / 墨墨的话 / 全部）、时间（今天 / 7 天 / 30 天）、
       是否已对照（EN 或 JA）；
     · 词频榜：英文按词、日文按假名/汉字块、中文按 2 字组合，内置一张很小的停用词表；
       点词频里的词 = 直接检索它。

   EN / JA 对照：
     · 不自动翻译全部。玩家点「生成 EN / JA」或「批量对照」才发请求；
     · 复用聊天同一个 /chat 端点（翻译 prompt、一次一句、串行、限速 1.2s、
       失败静默重试一次），结果只写本机 localStorage，下次打开直接命中缓存；
     · 第一次点击弹一次说明：这一句会发给 AI，仅用于生成对照。

   隐私（作者硬要求，写死在实现里）：
     · **每个用户一份独立语料，不能相交**。localStorage 键 =
       momo.corpus.v1.<hash(玩家名字 + 这台设备随机 uid)>；
       换名字 / 换浏览器 / 换设备 = 另一把钥匙，互相看不到对方的条目。
     · 语料绝不上传、不同步；EN/JA 生成只把「那一句」发去翻译，不发整份语料。
     · 面板底部常驻「只存这台设备、不上传」，并提供「清空我的语料」（二次确认）
       与「导出 JSON」（浏览器本机下载）。

   工程规矩：
     · 只注入 DOM + 一个 id 唯一的 <style>，不改 UI还原/ 的 PSD 与 CSS；
     · 入口胶囊在主画面右下角「说 话」正上方，同款羊皮纸金边；
     · 手机 844×390：面板贴住视口、内部可滚动，不依赖 1920 舞台缩放（字号可读）；
     · 不动现有聊天行为：chat.js 只多派发 momo:chatlog 事件。 */
(function () {
  "use strict";

  var SCR = "主画面";
  var ENDPOINT = window.MOMO_CHAT_URL || "https://momo-chat-api.pages.dev/chat";
  var KEY_PREFIX = "momo.corpus.v1.";
  var UID_KEY = "momo.corpus.uid";
  var MAX_ENTRIES = 2000;      /* FIFO 上限：超过就裁掉最旧的 */
  var MAX_TEXT = 2000;         /* 单条上限：超长截断，别让一条拖垮整份存档 */
  var RENDER_STEP = 60;        /* 结果列表一次画多少条，点「更多」继续 */
  var RATE_MS = 1200;          /* 翻译请求之间的最小间隔（串行、限速） */
  var TRANSLATE_TIMEOUT = 30000;
  var FALL_TOP = 12;           /* 打开时广播给字海的词频 Top N */
  var KWIC_CTX = 18;           /* KWIC 命中词前后各多少字 */

  /* ---------------- 身份 + 存储 ---------------- */
  var uid = "";
  var profile = "";
  var key = "";
  var store = null;            /* {v,uid,profile,entries,notice,createdAt} */
  var entries = [];
  var dataVersion = 0;         /* 数据改动计数：词频/统计缓存靠它失效 */
  var storageOk = true;

  /* ---------------- 面板 / 状态 ---------------- */
  var panel = null, btn = null, openState = false;
  var els = {};
  var state = { tab: "all", q: "", time: "all", align: "all", limit: RENDER_STEP };
  var modal = { onOk: null, open: false };
  var busy = Object.create(null);   /* entryId:lang -> true，防同一句重复发请求 */
  var queue = [];
  var running = false;
  var lastCall = 0;
  var statusTimer = 0;
  var statsCache = { v: -1, unique: 0 };
  var freqCache = { key: "", arr: [] };

  /* ============================================================
     基础工具
     ============================================================ */
  function $(sel, root) { return (root || document).querySelector(sel); }

  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function pad8(n) {
    var s = (n >>> 0).toString(16);
    while (s.length < 8) s = "0" + s;
    return s;
  }

  function randomUid() {
    var s = "";
    try {
      var a = new Uint32Array(4);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
      for (var i = 0; i < a.length; i++) s += pad8(a[i]);
    } catch (e) { s = ""; }
    if (!s) {
      for (var j = 0; j < 4; j++) s += pad8(Math.floor(Math.random() * 0xffffffff));
    }
    return s.slice(0, 24);
  }

  function ensureUid() {
    var u = null;
    try { u = localStorage.getItem(UID_KEY); } catch (e) {}
    if (!u || !/^[0-9a-f]{8,32}$/.test(u)) {
      u = randomUid();
      try { localStorage.setItem(UID_KEY, u); } catch (e) {}
    }
    return u;
  }

  /* 两轮 FNV-1a 拼成 16 位十六进制：够区分「名字 + 本机 uid」；
     碰撞概率对单机语料可以忽略。 */
  function hashKey(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul ? Math.imul(h1 ^ c, 16777619) : ((h1 ^ c) * 16777619) | 0;
      h2 = Math.imul ? Math.imul(h2 ^ c, 2246822519) : ((h2 ^ c) * 2246822519) | 0;
    }
    return pad8(h1) + pad8(h2);
  }

  function profileNow() {
    try {
      var o = JSON.parse(localStorage.getItem("momo.profile"));
      if (o && typeof o.name === "string" && o.name.trim()) return o.name.trim().slice(0, 40);
    } catch (e) {}
    return "你";
  }

  function roomNow() {
    try {
      var s = window.MomoStore && window.MomoStore.state;
      if (s) return { room: String(s.room || ""), floor: String(s.floor || "") };
    } catch (e) {}
    return { room: "", floor: "" };
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function trunc(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function localLower(s) { return String(s == null ? "" : s).toLowerCase(); }

  function fmtTime(ts) {
    var d = new Date(ts || 0);
    if (isNaN(d.getTime())) return "—";
    var now = new Date();
    var hm = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    if (d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return "今天 " + hm;
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }

  /* 身份/键只在名字或 uid 变了时才重算；键变了就换一份库（互相不可见）。 */
  function ensureIdentity() {
    var p = profileNow();
    if (!uid) uid = ensureUid();
    if (p === profile && key) return false;
    profile = p;
    key = KEY_PREFIX + hashKey(profile + "|" + uid);
    load();
    return true;
  }

  /* ---------------- 数据校验 + 读写 ---------------- */
  function newId(ts) {
    return "c" + (ts || Date.now()).toString(36) + "-" +
           Math.random().toString(36).slice(2, 6) + (Math.random() * 1296 | 0).toString(36);
  }

  function sanitizeEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    var who = raw.who === "user" || raw.who === "momo" ? raw.who : null;
    if (!who) return null;
    var text = String(raw.text == null ? "" : raw.text);
    if (!text) return null;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    var ts = Number(raw.ts);
    if (!isFinite(ts) || ts <= 0) ts = Date.now();
    var tags = Array.isArray(raw.tags) ? raw.tags.slice(0, 12).map(String) : [];
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : newId(ts),
      ts: ts,
      who: who,
      text: text,
      room: String(raw.room == null ? "" : raw.room).slice(0, 24),
      floor: String(raw.floor == null ? "" : raw.floor).slice(0, 12),
      en: String(raw.en == null ? "" : raw.en).slice(0, 800),
      ja: String(raw.ja == null ? "" : raw.ja).slice(0, 800),
      tags: tags
    };
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(key); } catch (e) { storageOk = false; }
    var env = null;
    try { env = raw ? JSON.parse(raw) : null; } catch (e) { env = null; }
    if (!env || typeof env !== "object" || !Array.isArray(env.entries)) {
      env = { v: 1, uid: uid, profile: profile, entries: [], notice: false, createdAt: Date.now() };
    }
    var seen = Object.create(null);
    var list = [];
    for (var i = 0; i < env.entries.length; i++) {
      var e = sanitizeEntry(env.entries[i]);
      if (!e) continue;
      if (seen[e.id]) e.id = newId(e.ts);
      seen[e.id] = 1;
      list.push(e);
    }
    entries = list.slice(-MAX_ENTRIES);          /* 历史遗留超量：FIFO 裁旧 */
    store = env;
    store.v = 1;
    store.uid = uid;
    store.profile = profile;
    store.entries = entries;
    if (typeof store.notice !== "boolean") store.notice = !!store.notice;
    if (!store.createdAt) store.createdAt = Date.now();
    dataVersion++;
    statsCache = { v: -1, unique: 0 };
    freqCache = { key: "", arr: [] };
  }

  function save() {
    if (!store) return false;
    store.v = 1;
    store.uid = uid;
    store.profile = profile;
    store.entries = entries;
    var payload;
    try { payload = JSON.stringify(store); } catch (e) { return false; }
    for (var attempt = 0; attempt < 4; attempt++) {
      try {
        localStorage.setItem(key, payload);
        storageOk = true;
        return true;
      } catch (err) {
        storageOk = false;
        /* 配额被打爆：先按比例裁旧，再重试；最坏只剩 100 条也保住能写。 */
        var keep = attempt === 0 ? Math.max(300, Math.floor(entries.length * 0.7))
                 : attempt === 1 ? 300
                 : attempt === 2 ? 100 : 0;
        if (entries.length > keep) {
          entries = keep ? entries.slice(-keep) : [];
          store.entries = entries;
          try { payload = JSON.stringify(store); } catch (e) { return false; }
        } else {
          break;
        }
      }
    }
    return false;
  }

  /* 捕获：chat.js 在 user 提交处与 finish 处派发 momo:chatlog。
     这里只认 user / momo，别的 who 一律忽略。 */
  function capture(who, text, ts) {
    if (who !== "user" && who !== "momo") return null;
    var t = String(text == null ? "" : text).replace(/\s*\n+\s*/g, " ").trim();
    if (!t) return null;
    if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT);
    ensureIdentity();
    var pos = roomNow();
    var now = (typeof ts === "number" && ts > 0) ? ts : Date.now();
    var entry = {
      id: newId(now), ts: now, who: who, text: t,
      room: pos.room, floor: pos.floor, en: "", ja: "", tags: []
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    dataVersion++;
    save();
    updateBadge();
    if (openState) refreshUI();
    maybeThemeHint(who);
    return entry;
  }

  /* 2026-10-20 评测补充：语料库是「涌现」的落点，但入口藏在右下角 —— 第一次
     存进玩家的话时，用一次 toast 点出这条机制（每个设备只提示一次）。 */
  var HINT_KEY = "momo.corpus.hint1";
  function maybeThemeHint(who) {
    if (who !== "user") return;
    try { if (localStorage.getItem(HINT_KEY)) return; localStorage.setItem(HINT_KEY, "1"); } catch (e) { return; }
    setTimeout(function () {
      var t = document.getElementById("momo-toast");
      if (!t) { t = document.createElement("div"); t.id = "momo-toast"; document.body.appendChild(t); }
      t.textContent = "你们说过的话，会在这里长成一片语料 · 关掉对话后点「语 料」";
      t.className = "toast-ok";
      t.style.display = "block";
      clearTimeout(t._t);
      t._t = setTimeout(function () { t.style.display = "none"; }, 5200);
    }, 1800);
  }

  /* ============================================================
     词频（英文按词 / 日文按假名·汉字块 / 中文按 2 字组合）
     ============================================================ */
  function charset(s) {
    var o = Object.create(null);
    var a = String(s || "").split(/\s+/);
    for (var i = 0; i < a.length; i++) if (a[i]) o[a[i]] = 1;
    return o;
  }

  /* 停用词表刻意保持「小」：只去掉冠词/代词/助词/常见虚词，不动实词。 */
  var EN_STOP = charset(
    "the a an and or but if then than so because as of in on at to for from by with without " +
    "about into over after before under above between during is are was were be been being am " +
    "do does did doing done have has had having i you he she it we they me him her us them my " +
    "your his its our their this that these those there here what who whom whose which when " +
    "where why how not no nor none too very just only also even still yet already again ever " +
    "never always often sometimes can could will would shall should may might must ok okay oh " +
    "ah um uh hmm yeah yep yes maybe well like"
  );
  var JA_STOP = charset(
    "は が を に で と も の や ね よ か な て だ さ ぞ わ へ から まで より など です ます " +
    "ました して してる する した いる ある こと もの ので のに けど でも って ば たら なら " +
    "でしょう だろう ください そして しかし だから"
  );
  var ZH_STOP = charset(
    "我们 你们 他们 她们 它们 什么 这个 那个 这些 那些 就是 不是 没有 可以 因为 所以 但是 " +
    "可是 如果 那么 这样 那样 怎么 为什么 一个 一下 一点 有点 一直 已经 现在 还是 还有 然后 " +
    "而且 或者 虽然 不过 只是 真的 知道 觉得 时候 这里 那里 自己 东西 事情 应该 可能 需要 " +
    "不会 不能 不要 怎么样 是不是 有没有 我的 你的 他的 她的"
  );

  function isHan(c) { return /[\u4e00-\u9fff\u3005\u3006]/.test(c); }
  function isKana(c) { return /[\u3040-\u30ff\u30fc]/.test(c); }

  /* 返回一条文本的候选词（重复也保留，交给上层计数）。 */
  function tokensOf(text) {
    var src = String(text || "");
    var out = [];

    /* 英文：按词（统一小写，去掉句尾撇号/连字符） */
    var en = src.match(/[A-Za-z][A-Za-z'’\-]{1,}/g) || [];
    for (var i = 0; i < en.length; i++) {
      var w = en[i].toLowerCase().replace(/['’\-]+$/, "");
      if (w.length >= 2 && !EN_STOP[w]) out.push(w);
    }

    /* 日文：只要句子里有假名，就按「假名块 / 汉字块」切；
       单字假名基本是助词，靠 JA_STOP 滤掉；单字汉字保留（可能是实词）。 */
    if (/[\u3040-\u30ff]/.test(src)) {
      var jre = /[\u3040-\u30ff\u30fc\u4e00-\u9fff\u3005\u3006]+/g, jm;
      while ((jm = jre.exec(src))) {
        var run = jm[0], p = 0;
        while (p < run.length) {
          var han = isHan(run.charAt(p));
          var q = p + 1;
          while (q < run.length && isHan(run.charAt(q)) === han) q++;
          var chunk = run.slice(p, q);
          p = q;
          if (JA_STOP[chunk]) continue;
          if (han) {
            if (chunk.length >= 1) out.push(chunk);     /* 汉字块 */
          } else if (chunk.length >= 2) {
            out.push(chunk);                            /* 假名块（≥2 字才当词） */
          }
        }
      }
    } else if (/[\u4e00-\u9fff]/.test(src)) {
      /* 中文：连续汉字串 → 相邻 2 字组合（overlapping bigram） */
      var hre = /[\u4e00-\u9fff]+/g, hm;
      while ((hm = hre.exec(src))) {
        var hrun = hm[0];
        for (var k = 0; k + 1 < hrun.length; k++) {
          var bg = hrun.slice(k, k + 2);
          if (!ZH_STOP[bg]) out.push(bg);
        }
      }
    }
    return out;
  }

  function wordCounts(list) {
    var map = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var toks = tokensOf(list[i].text);
      for (var j = 0; j < toks.length; j++) {
        map[toks[j]] = (map[toks[j]] || 0) + 1;
      }
    }
    var arr = [];
    for (var w in map) arr.push({ w: w, c: map[w] });
    arr.sort(function (a, b) {
      if (b.c !== a.c) return b.c - a.c;
      return a.w < b.w ? -1 : a.w > b.w ? 1 : 0;
    });
    return arr;
  }

  function uniqueWordCount() {
    if (statsCache.v === dataVersion) return statsCache.unique;
    var n = wordCounts(entries).length;
    statsCache = { v: dataVersion, unique: n };
    return n;
  }

  /* ============================================================
     过滤（说话人 / 时间 / 是否已对照 / 检索）
     ============================================================ */
  function inTab(e) {
    return state.tab === "all" || e.who === state.tab;
  }

  function inTime(e) {
    if (state.time === "all") return true;
    var now = new Date(), d = new Date(e.ts);
    if (state.time === "today") {
      return d.getFullYear() === now.getFullYear() &&
             d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    }
    var days = state.time === "7" ? 7 : 30;
    return now.getTime() - e.ts <= days * 86400000 && e.ts <= now.getTime() + 60000;
  }

  function aligned(e) { return !!(e.en || e.ja); }

  function inAlign(e) {
    if (state.align === "all") return true;
    if (state.align === "yes") return aligned(e);
    return !aligned(e);
  }

  function matchesQuery(e) {
    if (!state.q) return true;
    var q = localLower(state.q);
    return localLower(e.text).indexOf(q) >= 0 ||
           localLower(e.en).indexOf(q) >= 0 ||
           localLower(e.ja).indexOf(q) >= 0;
  }

  /* 词频的统计范围：tab + 时间 + 对照状态（不含检索词，
     否则点词频之后侧栏会自己塌掉）。 */
  function scopeEntries() {
    var list = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (inTab(e) && inTime(e) && inAlign(e)) list.push(e);
    }
    return list;
  }

  function filteredEntries() {
    var list = [];
    for (var i = entries.length - 1; i >= 0; i--) {   /* 新的在前 */
      var e = entries[i];
      if (inTab(e) && inTime(e) && inAlign(e) && matchesQuery(e)) list.push(e);
    }
    return list;
  }

  function scopedWordCounts() {
    var ck = state.tab + "|" + state.time + "|" + state.align + "|" + dataVersion;
    if (freqCache.key === ck) return freqCache.arr;
    var arr = wordCounts(scopeEntries());
    freqCache = { key: ck, arr: arr };
    return arr;
  }

  function topWords(n) {
    return scopedWordCounts().slice(0, n || FALL_TOP);
  }

  /* ============================================================
     渲染
     ============================================================ */
  function updateBadge() {
    if (!btn) return;
    /* 作者 2026-10-20 P0：按钮只留「语 料」两个字，不显示计数（要和「说 话」同宽），
       条数放到面板标题「墨墨 · 语料库 · N 句」与统计区。这里只用 aria/title 给读屏和悬停。 */
    var n = entries.length;
    btn.setAttribute("aria-label", "打开语料库（当前 " + n + " 条）");
    btn.title = "墨墨 · 语料库（" + n + " 条，只存这台设备）";
  }

  function renderStats() {
    if (!els.statCnt) return;
    var anc = 0;
    for (var i = 0; i < entries.length; i++) if (aligned(entries[i])) anc++;
    els.statCnt.textContent = String(entries.length);
    if (els.titleN) els.titleN.textContent = " · " + entries.length + " 句";
    els.statWords.textContent = String(uniqueWordCount());
    els.statAlign.textContent = String(anc);
  }

  function chipWord(item) {
    var b = mk("button", "mcp-word");
    b.type = "button";
    b.title = item.w;
    b.appendChild(mk("span", "mcp-word-w", item.w));
    b.appendChild(mk("em", "mcp-word-c", String(item.c)));
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      setSearch(item.w);
    });
    return b;
  }

  function renderFreq() {
    if (!els.freqList) return;
    els.freqList.innerHTML = "";
    var items = topWords(18);
    if (!items.length) {
      els.freqList.appendChild(mk("div", "mcp-freq-empty",
        entries.length ? "当前筛选下没有可统计的词。" : "说几句话，词就长出来了。"));
      return;
    }
    for (var i = 0; i < items.length; i++) els.freqList.appendChild(chipWord(items[i]));
  }

  function kwicFragment(text, q) {
    var frag = document.createDocumentFragment();
    text = String(text || "");
    var idx = q ? localLower(text).indexOf(localLower(q)) : -1;
    if (idx < 0) {
      frag.appendChild(document.createTextNode(trunc(text, 180)));
      return frag;
    }
    var start = Math.max(0, idx - KWIC_CTX);
    var end = Math.min(text.length, idx + q.length + KWIC_CTX);
    if (start > 0) frag.appendChild(mk("span", "mcp-ell", "…"));
    frag.appendChild(document.createTextNode(text.slice(start, idx)));
    frag.appendChild(mk("mark", "mcp-mark", text.slice(idx, idx + q.length)));
    frag.appendChild(document.createTextNode(text.slice(idx + q.length, end)));
    if (end < text.length) frag.appendChild(mk("span", "mcp-ell", "…"));
    return frag;
  }

  function refLine(lang, text) {
    var row = mk("div", "mcp-refline " + lang);
    row.appendChild(mk("b", "mcp-reflang", lang.toUpperCase()));
    var t = mk("span", "mcp-reftext");
    t.textContent = text;
    row.appendChild(t);
    return row;
  }

  function actionBtn(entry, lang) {
    var bk = entry.id + ":" + lang;
    var b = mk("button", "mcp-tbtn");
    b.type = "button";
    if (busy[bk]) {
      b.textContent = lang.toUpperCase() + " …";
      b.disabled = true;
    } else {
      b.textContent = "生成 " + lang.toUpperCase();
    }
    b.title = "调用 /chat 把这句翻译成 " + (lang === "en" ? "英文" : "日文") +
              "（只发这一句，结果只存本机）";
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      ensureNotice(function () { translateEntry(entry, lang, null); });
    });
    return b;
  }

  function createHit(e) {
    var card = mk("article", "mcp-hit");
    card.setAttribute("data-id", e.id);

    var meta = mk("div", "mcp-hit-meta");
    meta.appendChild(mk("span", "mcp-who " + (e.who === "user" ? "me" : "her"),
                        e.who === "user" ? "你" : "墨墨"));
    meta.appendChild(mk("time", "mcp-time", fmtTime(e.ts)));
    if (e.room) meta.appendChild(mk("span", "mcp-room", e.room));
    if (e.floor) meta.appendChild(mk("span", "mcp-floor", e.floor));
    card.appendChild(meta);

    var p = mk("p", "mcp-hit-text");
    p.appendChild(kwicFragment(e.text, state.q));
    p.title = e.text;
    p.addEventListener("click", function (ev) {
      ev.stopPropagation();
      p.classList.toggle("mcp-open");
    });
    card.appendChild(p);

    if (e.en) card.appendChild(refLine("en", e.en));
    if (e.ja) card.appendChild(refLine("ja", e.ja));

    var missing = [];
    if (!e.en) missing.push("en");
    if (!e.ja) missing.push("ja");
    if (missing.length) {
      var acts = mk("div", "mcp-hit-acts");
      for (var i = 0; i < missing.length; i++) acts.appendChild(actionBtn(e, missing[i]));
      card.appendChild(acts);
    }
    return card;
  }

  function emptyHint(text) {
    var d = mk("div", "mcp-empty");
    d.textContent = text;
    return d;
  }

  function renderList() {
    if (!els.results) return;
    var sc = els.results.scrollTop;
    var mainSc = els.main ? els.main.scrollTop : 0;
    var list = filteredEntries();
    els.results.innerHTML = "";
    els.count.textContent = state.q
      ? "命中 " + list.length + " 条 · 共 " + entries.length + " 句"
      : "共 " + list.length + " 句";

    if (!list.length) {
      els.results.appendChild(emptyHint(
        entries.length
          ? "没有命中。换个词，或把「时间 / 对照状态」放宽一点。"
          : "还没有语料。回主画面点右下角「说 话」和她说几句——" +
            "你说过的每句话、她回过的每句话，都会分开长进这里。"));
    } else {
      var show = list.slice(0, state.limit);
      for (var i = 0; i < show.length; i++) els.results.appendChild(createHit(show[i]));
    }

    if (els.moreWrap) {
      els.moreWrap.innerHTML = "";
      if (list.length > state.limit) {
        var more = mk("button", "mcp-more",
          "再显示 " + Math.min(RENDER_STEP, list.length - state.limit) + " 条（还有 " +
          (list.length - state.limit) + " 条）");
        more.type = "button";
        more.addEventListener("click", function (ev) {
          ev.stopPropagation();
          state.limit += RENDER_STEP;
          renderList();
        });
        els.moreWrap.appendChild(more);
      }
    }
    els.results.scrollTop = sc;
    if (els.main) els.main.scrollTop = mainSc;
  }

  function syncTabs() {
    if (!els.tabs) return;
    var bs = els.tabs.querySelectorAll(".mcp-tab");
    for (var i = 0; i < bs.length; i++) {
      var on = bs[i].getAttribute("data-tab") === state.tab;
      bs[i].classList.toggle("on", on);
      bs[i].setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  function renderAll() {
    renderStats();
    renderFreq();
    renderList();
    syncTabs();
    updateBadge();
  }

  function refreshUI() {
    if (!openState) { updateBadge(); return; }
    renderAll();
  }

  function setSearch(word) {
    state.q = String(word || "");
    state.limit = RENDER_STEP;
    if (els.search) {
      els.search.value = state.q;
      if (window.innerWidth > 900) { try { els.search.focus(); } catch (e) {} }
    }
    renderList();
  }

  /* 打开时把「当前词频 Top 12」广播出去；若有字海，就让这些词落进她屋里。 */
  function broadcastTop() {
    var top = [];
    try {
      var arr = scopedWordCounts();
      for (var i = 0; i < arr.length && i < FALL_TOP; i++) top.push(arr[i].w);
    } catch (e) {}
    if (!top.length) return;
    try {
      document.dispatchEvent(new CustomEvent("momo:corpus", { detail: { top: top.slice() } }));
    } catch (e) {}
    try {
      if (window.MomoWordSea && typeof window.MomoWordSea.fall === "function") {
        window.MomoWordSea.fall(top.join(" "));
      }
    } catch (e) {}
  }

  /* ============================================================
     EN / JA 对照（复用聊天端点；一次一句、串行、限速、只存本机）
     ============================================================ */
  var PROMPT = {
    en: "把下面这句游戏对白翻译成自然、简洁的英文。保持原语气（傲娇、有点毒舌、闷骚），" +
        "不要扩写。只输出一行译文，不要引号、不要解释、不要任何前后缀。",
    ja: "把下面这句游戏对白翻译成自然、口语化的日文。保持原语气（ツンデレ、少し毒舌），" +
        "不要扩写。只输出一行译文，不要引号、不要解释、不要任何前后缀。"
  };

  function cleanOut(s) {
    s = String(s == null ? "" : s).replace(/\r/g, "").trim();
    s = s.replace(/^["'“”‘’「」『』]+/g, "").replace(/["'“”‘’「」『』]+$/g, "").trim();
    s = s.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
    if (s.length > 500) s = s.slice(0, 500);
    return s;
  }

  function jsonContent(raw) {
    try {
      var o = JSON.parse(raw);
      var ch = o.choices && o.choices[0];
      var m = ch && (ch.message || ch.delta || ch);
      return (m && m.content) || "";
    } catch (e) { return ""; }
  }

  function readReply(res) {
    if (res.body && res.body.getReader) {
      var reader = res.body.getReader();
      var dec = new TextDecoder("utf-8");
      var raw = "", got = "", buf = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return null;
          var chunk = dec.decode(r.value, { stream: true });
          raw += chunk;
          buf += chunk;
          var lines = buf.split("\n");
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.slice(0, 5) !== "data:") continue;
            var payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              var o = JSON.parse(payload);
              var ch = o.choices && o.choices[0];
              var d = ch && ch.delta;
              if (d && d.content) got += d.content;
              var m = ch && ch.message;
              if (m && m.content) got += m.content;
            } catch (e) { /* 半行 / 心跳 */ }
          }
          return pump();
        });
      }
      return pump().then(function () {
        if (got) return got;
        return jsonContent(raw);
      });
    }
    if (res.text) return res.text().then(jsonContent);
    return Promise.resolve("");
  }

  function callChat(text, lang) {
    return new Promise(function (resolve, reject) {
      if (!window.fetch) { reject(new Error("no fetch")); return; }
      var ctrl = ("AbortController" in window) ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TRANSLATE_TIMEOUT);
      var opt = {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: PROMPT[lang] },
            { role: "user", content: text }
          ],
          max_tokens: 400,
          temperature: 0.2
        })
      };
      if (ctrl) opt.signal = ctrl.signal;
      fetch(ENDPOINT, opt).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return readReply(res);
      }).then(function (out) {
        clearTimeout(timer);
        out = cleanOut(out);
        if (!out) throw new Error("empty translation");
        resolve(out);
      })["catch"](function (err) {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /* 失败静默重试一次；仍失败交给上层，不弹报错、不污染聊天面板。 */
  function translateWithRetry(text, lang) {
    return callChat(text, lang)["catch"](function () {
      /* 这一跳在国内实测首字节 1~15 秒都见过；失败时先给玩家一句「在重试」，
         再换一条连接重发一次，不要让她看起来什么都没发生。 */
      setStatus("网络有点慢，正在重试这一句…", 6000);
      return delay(900).then(function () { return callChat(text, lang); });
    });
  }

  /* 打开语料库时顺手把 pages.dev 的 DNS/TLS 烫热：第一次翻译往往就快很多。
     失败静默，不影响本地语料。 */
  var warmedAt = 0;
  function warmTranslate() {
    if (!window.fetch || Date.now() - warmedAt < 120000) return;
    warmedAt = Date.now();
    try {
      var c = ("AbortController" in window) ? new AbortController() : null;
      if (c) setTimeout(function () { c.abort(); }, 8000);
      fetch(ENDPOINT, { method: "GET", cache: "no-store", signal: c ? c.signal : undefined })
        ["catch"](function () {});
    } catch (e) {}
  }

  function setStatus(text, holdMs) {
    if (!els.status) return;
    els.status.textContent = text || "";
    els.status.classList.toggle("on", !!text);
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = 0; }
    if (text && holdMs) {
      statusTimer = setTimeout(function () {
        if (els.status) { els.status.textContent = ""; els.status.classList.remove("on"); }
        statusTimer = 0;
      }, holdMs);
    }
  }

  /* 串行队列 + 最小间隔：同一时间最多一条翻译请求在路上。 */
  function enqueue(fn) {
    queue.push(fn);
    runQueue();
  }

  function runQueue() {
    if (running) return;
    var fn = queue.shift();
    if (!fn) return;
    running = true;
    var gap = Math.max(0, RATE_MS - (Date.now() - lastCall));
    setTimeout(function () {
      lastCall = Date.now();
      var p;
      try { p = fn(); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function () {
        running = false; runQueue();
      }, function () {
        running = false; runQueue();
      });
    }, gap);
  }

  /* 单条：成功写进入口、save；失败只更新状态，不打断玩家。 */
  function translateEntry(entry, lang, cb) {
    if (!entry || !lang) { if (cb) cb(false); return; }
    if (entry[lang]) { if (cb) cb(true); return; }
    var bk = entry.id + ":" + lang;
    if (busy[bk]) { if (cb) cb(false); return; }
    busy[bk] = true;
    if (openState) renderList();
    setStatus((lang === "en" ? "EN" : "JA") + " 对照生成中…（只发这一句，只存本机）");

    enqueue(function () {
      return translateWithRetry(entry.text, lang).then(function (out) {
        entry[lang] = out;
        save();
        if (openState) { renderStats(); renderList(); }
        setStatus("已生成 " + lang.toUpperCase() + " 对照 · 只存本机", 4200);
        return true;
      })["catch"](function () {
        setStatus("网络不稳：这条 " + lang.toUpperCase() + " 对照没生成，稍后再点一次。", 6500);
        return false;
      }).then(function (ok) {
        delete busy[bk];
        if (cb) cb(ok);
        return ok;
      });
    });
  }

  function batchTranslate() {
    ensureNotice(function () {
      var list = filteredEntries();
      var jobs = [];
      for (var i = 0; i < list.length && jobs.length < 8; i++) {
        var e = list[i];
        if (!e.en) jobs.push({ e: e, lang: "en" });
        if (!e.ja && jobs.length < 8) jobs.push({ e: e, lang: "ja" });
        if (jobs.length >= 8) break;
      }
      if (!jobs.length) { setStatus("当前结果都已有对照。", 3600); return; }
      var total = jobs.length, done = 0;
      setStatus("批量对照开始：共 " + total + " 条，串行生成中…");
      for (var j = 0; j < jobs.length; j++) {
        (function (job) {
          translateEntry(job.e, job.lang, function (ok) {
            done++;
            if (done >= total) {
              setStatus(ok ? "批量对照完成 · 只存本机" : "部分对照没生成，稍后再点一次。", 6000);
            } else if (ok) {
              setStatus("对照生成中… " + done + "/" + total);
            }
          });
        })(jobs[j]);
      }
    });
  }

  /* ============================================================
     弹窗（首次翻译说明 / 清空二次确认）
     ============================================================ */
  function showModal(opts) {
    if (!els.modalMask) return;
    modal.open = true;
    modal.onOk = opts.onOk || null;
    els.modalTitle.textContent = opts.title || "";
    els.modalText.textContent = opts.text || "";
    els.modalOk.textContent = opts.ok || "知道了";
    els.modalCancel.textContent = opts.cancel || "取消";
    els.modalOk.classList.toggle("mcp-primary", !opts.danger);
    els.modalOk.classList.toggle("mcp-dangerbtn", !!opts.danger);
    els.modalCancel.style.display = opts.hideCancel ? "none" : "";
    els.modalMask.classList.add("on");
  }

  function hideModal() {
    modal.open = false;
    modal.onOk = null;
    if (els.modalMask) els.modalMask.classList.remove("on");
  }

  function ensureNotice(cb) {
    if (store && store.notice) { cb(); return; }
    showModal({
      title: "生成 EN / JA 对照",
      text: "会把这句话发给 AI（和「说 话」用的是同一个接口），仅用于生成对照；" +
            "结果只存这台设备，不会上传整份语料。不会自动翻译全部，只有你点的那句才会发。",
      ok: "知道了，继续",
      cancel: "取消",
      onOk: function () {
        if (store) { store.notice = true; save(); }
        cb();
      }
    });
  }

  /* ============================================================
     样式（注入，id 唯一；不改 UI还原/ 的 PSD 与 CSS）
     ============================================================ */
  function injectStyle() {
    if (document.getElementById("momo-corpus-css")) return;
    var CSS =
      /* ---- 主画面入口胶囊：作者 2026-10-20 P0 ----
         必须和「说 话」（common.css 的 .momo-chat-btn）完全同款同尺寸同位置：
         这里刻意逐条复制它的声明，只把 bottom 改成 398px
         （说话 322 + 高 62 + 间距 14 = 398，正好叠在正上方 14px 缝）。
         按钮文字只有「语 料」两个字 —— 与「说 话」等宽，计数不放在按钮上。 */
      "#scr-主画面 .momo-corpus-btn{position:absolute;right:76px;bottom:398px;" +
      "height:62px;padding:0 28px 0 32px;display:inline-flex;align-items:center;" +
      "background:rgba(38,28,21,.58);border:1px solid rgba(214,178,128,.6);border-radius:999px;" +
      "color:#f4e6cd;font-family:\"FZXiaoBiaoSong-B05S\",\"方正小标宋简体\",serif;" +
      "font-size:25px;letter-spacing:7px;text-indent:7px;cursor:pointer;backdrop-filter:blur(3px);" +
      "box-shadow:0 8px 24px rgba(0,0,0,.35);" +
      "transition:background .18s ease,opacity .3s ease,transform .18s ease;}" +
      "#scr-主画面 .momo-corpus-btn:hover{background:rgba(58,43,31,.72);transform:translateY(-1px);}" +
      "#scr-主画面 .momo-corpus-btn.off{opacity:0;pointer-events:none;}" +
      "#scr-主画面.story-lock .momo-corpus-btn,#scr-主画面 .momo-corpus-btn.chat-open{" +
      "opacity:0;pointer-events:none;}" +
      /* ---- 羊皮纸浮层面板（fixed：手机 844×390 也保持可读字号，内部滚动） ---- */
      ".momo-corpus-panel{position:fixed;left:50%;top:50%;width:min(1160px,calc(100vw - 48px));" +
      "height:min(780px,calc(100vh - 56px));transform:translate(-50%,-50%) translateY(16px);" +
      "display:flex;flex-direction:column;padding:0;z-index:760000;box-sizing:border-box;" +
      "background:linear-gradient(160deg,#fcf9f4 0%,#f6eedf 62%,#efe2ca 100%);" +
      "border:2px solid #c9a86a;border-radius:18px;color:#3e3430;" +
      "font-family:\"FZXiaoBiaoSong-B05S\",\"方正小标宋简体\",\"Songti SC\",serif;" +
      "box-shadow:0 30px 90px rgba(0,0,0,.55),inset 0 0 0 6px rgba(201,168,106,.14);" +
      "opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease;" +
      "overflow:hidden;touch-action:manipulation;}" +
      ".momo-corpus-panel.on{opacity:1;pointer-events:auto;transform:translate(-50%,-50%);}" +
      ".momo-corpus-panel *{box-sizing:border-box;}" +
      ".mcp-head{display:flex;align-items:center;gap:18px;padding:18px 26px 10px;" +
      "border-bottom:1px solid rgba(201,168,106,.35);flex:0 0 auto;}" +
      ".mcp-titlewrap{min-width:0;}" +
      ".mcp-title{font-size:30px;letter-spacing:4px;white-space:nowrap;}" +
      ".mcp-title-n{font-size:18px;letter-spacing:2px;opacity:.55;}" +
      ".mcp-sub{font-size:14px;letter-spacing:1px;opacity:.48;margin-top:3px;white-space:nowrap;}" +
      ".mcp-stats{display:flex;gap:20px;margin-left:auto;align-items:baseline;}" +
      ".mcp-stat{display:flex;align-items:baseline;gap:5px;white-space:nowrap;}" +
      ".mcp-stat b{font-size:27px;font-weight:400;color:#8a5a2b;}" +
      ".mcp-stat i{font-style:normal;font-size:13px;opacity:.55;}" +
      ".mcp-x{width:38px;height:38px;flex:0 0 auto;border:1px solid rgba(201,168,106,.45);" +
      "border-radius:50%;background:rgba(255,255,255,.35);color:#5a4634;font-size:24px;" +
      "line-height:1;cursor:pointer;font-family:inherit;padding:0;}" +
      ".mcp-x:hover{background:rgba(201,168,106,.22);}" +
      ".mcp-tabs{display:flex;gap:8px;padding:10px 26px 0;flex:0 0 auto;}" +
      ".mcp-tab{padding:5px 16px 6px;border-radius:999px;border:1px solid rgba(201,168,106,.5);" +
      "background:transparent;color:#6b5540;font-family:inherit;font-size:16px;cursor:pointer;" +
      "letter-spacing:1px;}" +
      ".mcp-tab:hover{background:rgba(201,168,106,.16);}" +
      ".mcp-tab.on{background:#3e3430;border-color:#3e3430;color:#f7ebd6;}" +
      ".mcp-tools{display:flex;gap:10px;padding:10px 26px 12px;flex-wrap:wrap;align-items:center;flex:0 0 auto;}" +
      ".mcp-search{flex:1 1 260px;min-width:140px;height:38px;padding:0 13px;border-radius:9px;" +
      "border:1px solid rgba(140,108,70,.4);background:rgba(255,253,248,.85);color:#3e3430;" +
      "font-family:inherit;font-size:16px;outline:none;}" +
      ".mcp-search:focus{border-color:#c9a86a;box-shadow:0 0 0 2px rgba(201,168,106,.2);}" +
      ".mcp-search::placeholder{color:rgba(90,70,50,.4);}" +
      ".mcp-tools select{height:38px;padding:0 8px;border-radius:9px;border:1px solid rgba(140,108,70,.4);" +
      "background:rgba(255,253,248,.85);color:#4b3c2d;font-family:inherit;font-size:15px;" +
      "outline:none;cursor:pointer;}" +
      ".mcp-tools select:focus{border-color:#c9a86a;}" +
      ".mcp-batch{height:38px;padding:0 15px;border-radius:999px;border:1px solid rgba(140,108,70,.45);" +
      "background:rgba(255,253,248,.7);color:#5a4634;font-family:inherit;font-size:15px;" +
      "letter-spacing:1px;cursor:pointer;}" +
      ".mcp-batch:hover{background:rgba(201,168,106,.22);}" +
      ".mcp-main{display:flex;gap:16px;padding:0 26px 12px;flex:1 1 auto;min-height:0;}" +
      ".mcp-freq{width:212px;flex:0 0 212px;display:flex;flex-direction:column;min-height:0;" +
      "border-right:1px solid rgba(201,168,106,.3);padding-right:14px;}" +
      ".mcp-freq-head{font-size:16px;letter-spacing:3px;color:#7a5c3a;padding:2px 2px 8px;" +
      "flex:0 0 auto;}" +
      ".mcp-freq-head span{font-size:10px;letter-spacing:1px;opacity:.55;margin-left:4px;}" +
      ".mcp-freq-list{display:flex;flex-direction:column;gap:5px;overflow-y:auto;min-height:0;flex:1 1 auto;" +
      "padding-right:4px;}" +
      ".mcp-word{display:flex;align-items:center;justify-content:space-between;gap:8px;" +
      "padding:4px 9px;border-radius:7px;border:1px solid transparent;background:rgba(255,252,246,.55);" +
      "color:#4b3c2d;font-family:inherit;font-size:15px;cursor:pointer;text-align:left;width:100%;}" +
      ".mcp-word:hover{background:rgba(201,168,106,.2);border-color:rgba(201,168,106,.45);}" +
      ".mcp-word-w{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;}" +
      ".mcp-word-c{font-style:normal;font-size:12px;opacity:.55;flex:0 0 auto;}" +
      ".mcp-freq-hint{font-size:11px;opacity:.42;padding:7px 2px 0;flex:0 0 auto;}" +
      ".mcp-freq-empty{font-size:13px;line-height:1.6;opacity:.55;padding:4px 2px;}" +
      ".mcp-resbox{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;}" +
      ".mcp-count{font-size:13px;opacity:.6;padding:2px 2px 8px;flex:0 0 auto;}" +
      ".mcp-results{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;" +
      "gap:9px;padding-right:6px;}" +
      ".mcp-hit{border:1px solid rgba(201,168,106,.3);border-radius:12px;padding:10px 14px 11px;" +
      "background:rgba(255,252,246,.55);}" +
      ".mcp-hit-meta{display:flex;align-items:baseline;gap:9px;font-size:13px;opacity:.7;flex-wrap:wrap;}" +
      ".mcp-who{font-size:13px;letter-spacing:1px;padding:1px 8px;border-radius:999px;opacity:1;}" +
      ".mcp-who.me{background:rgba(110,150,170,.2);color:#3f5e70;}" +
      ".mcp-who.her{background:rgba(201,168,106,.28);color:#7a5320;}" +
      ".mcp-room,.mcp-floor{font-size:12px;opacity:.7;}" +
      ".mcp-hit-text{margin:5px 0 2px;font-size:17px;line-height:1.65;color:#332b26;cursor:pointer;" +
      "display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}" +
      ".mcp-hit-text.mcp-open{display:block;overflow:visible;-webkit-line-clamp:unset;}" +
      ".mcp-mark{background:rgba(255,196,90,.46);color:#5a2f00;border-radius:3px;padding:0 1px;" +
      "box-shadow:0 0 0 1px rgba(201,140,40,.2);}" +
      ".mcp-ell{opacity:.45;}" +
      ".mcp-refline{display:flex;align-items:baseline;gap:8px;font-size:14px;line-height:1.6;" +
      "padding:2px 0;color:#5b4a3a;}" +
      ".mcp-reflang{font-size:10px;letter-spacing:1px;color:#8a5a2b;flex:0 0 auto;opacity:.8;}" +
      ".mcp-reftext{white-space:pre-wrap;word-break:break-word;}" +
      ".mcp-refline.en .mcp-reftext{color:#4a5e6b;}" +
      ".mcp-refline.ja .mcp-reftext{color:#6b5442;}" +
      ".mcp-hit-acts{display:flex;gap:8px;margin-top:7px;flex-wrap:wrap;}" +
      ".mcp-tbtn{padding:3px 12px;border-radius:999px;border:1px solid rgba(140,108,70,.4);" +
      "background:rgba(255,250,240,.7);color:#6b5138;font-family:inherit;font-size:12.5px;" +
      "cursor:pointer;letter-spacing:.5px;}" +
      ".mcp-tbtn:hover:not(:disabled){background:rgba(201,168,106,.22);}" +
      ".mcp-tbtn:disabled{opacity:.55;cursor:default;}" +
      ".mcp-empty{font-size:15px;line-height:1.8;opacity:.6;padding:26px 16px;text-align:center;}" +
      ".mcp-morewrap{flex:0 0 auto;text-align:center;padding-top:8px;}" +
      ".mcp-more{padding:5px 18px;border-radius:999px;border:1px solid rgba(140,108,70,.4);" +
      "background:rgba(255,250,240,.7);color:#6b5138;font-family:inherit;font-size:13px;cursor:pointer;}" +
      ".mcp-more:hover{background:rgba(201,168,106,.22);}" +
      ".mcp-foot{display:flex;align-items:center;gap:14px;padding:10px 26px 14px;flex:0 0 auto;" +
      "border-top:1px solid rgba(201,168,106,.35);}" +
      ".mcp-privacy{flex:1 1 260px;font-size:12.5px;line-height:1.55;opacity:.66;}" +
      ".mcp-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;}" +
      ".mcp-btn{padding:6px 14px;border-radius:999px;border:1px solid rgba(140,108,70,.42);" +
      "background:rgba(255,252,246,.75);color:#5a4634;font-family:inherit;font-size:14px;" +
      "cursor:pointer;letter-spacing:1px;}" +
      ".mcp-btn:hover{background:rgba(201,168,106,.2);}" +
      ".mcp-danger{color:#8c3b2f;border-color:rgba(140,59,47,.4);}" +
      ".mcp-danger:hover{background:rgba(140,59,47,.1);}" +
      ".mcp-primary{background:#3e3430;border-color:#3e3430;color:#f7ebd6;}" +
      ".mcp-primary:hover{background:#54463c;}" +
      ".mcp-dangerbtn{background:#8c3b2f;border-color:#8c3b2f;color:#fff3ec;}" +
      ".mcp-status{position:absolute;left:50%;bottom:66px;transform:translateX(-50%);max-width:86%;" +
      "padding:7px 18px;border-radius:999px;background:rgba(62,52,48,.9);color:#f7ebd6;" +
      "font-size:13px;letter-spacing:.5px;opacity:0;pointer-events:none;transition:opacity .18s ease;" +
      "z-index:4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      ".mcp-status.on{opacity:1;}" +
      ".mcp-modal-mask{position:absolute;inset:0;display:none;align-items:center;justify-content:center;" +
      "padding:22px;background:rgba(30,22,16,.45);z-index:9;}" +
      ".mcp-modal-mask.on{display:flex;}" +
      ".mcp-modal{width:min(480px,100%);background:#fbf6ec;border:1.5px solid #c9a86a;border-radius:14px;" +
      "padding:20px 22px 16px;box-shadow:0 20px 60px rgba(0,0,0,.4),inset 0 0 0 5px rgba(201,168,106,.12);}" +
      ".mcp-modal-title{font-size:21px;letter-spacing:2px;margin-bottom:10px;color:#3e3430;}" +
      ".mcp-modal-text{font-size:15px;line-height:1.75;color:#5a4634;margin-bottom:16px;}" +
      ".mcp-modal-acts{display:flex;gap:10px;justify-content:flex-end;}" +
      /* ---- 手机 / 矮视口：贴住视口、内部滚动（不跟 1920 舞台一起缩成蚂蚁字） ---- */
      "@media (max-width:900px),(max-height:560px){" +
      ".momo-corpus-panel{left:8px;top:8px;transform:none;width:calc(100vw - 16px);" +
      "height:calc(100vh - 16px);border-radius:12px;border-width:1.5px;}" +
      ".momo-corpus-panel.on{transform:none;}" +
      ".mcp-head{gap:8px;padding:8px 12px 6px;}" +
      ".mcp-title{font-size:17px;letter-spacing:1px;}" +
      ".mcp-title-n{font-size:11px;letter-spacing:0;}" +
      ".mcp-sub{display:none;}" +
      ".mcp-stats{gap:9px;}" +
      ".mcp-stat b{font-size:17px;}" +
      ".mcp-stat i{font-size:10px;}" +
      ".mcp-x{width:28px;height:28px;font-size:18px;}" +
      ".mcp-tabs{padding:5px 12px 0;gap:6px;}" +
      ".mcp-tab{padding:3px 10px 4px;font-size:12px;letter-spacing:.5px;}" +
      ".mcp-tools{padding:6px 12px 7px;gap:6px;}" +
      ".mcp-search{height:30px;font-size:12px;padding:0 9px;flex:1 1 130px;}" +
      ".mcp-tools select{height:30px;font-size:11.5px;padding:0 4px;}" +
      ".mcp-batch{height:30px;font-size:11.5px;padding:0 10px;}" +
      ".mcp-main{flex-direction:column;gap:7px;padding:0 12px 6px;overflow-y:auto;min-height:0;}" +
      ".mcp-resbox{flex:0 0 auto;order:1;min-height:0;}" +
      ".mcp-freq{order:2;width:auto;flex:0 0 auto;border-right:0;border-top:1px solid rgba(201,168,106,.3);" +
      "padding:5px 0 0;flex-direction:column;gap:3px;}" +
      ".mcp-freq-head{font-size:11px;letter-spacing:1px;padding:0 0 3px;}" +
      ".mcp-freq-list{flex-direction:row;overflow-x:auto;overflow-y:hidden;gap:4px;max-height:30px;" +
      "flex:0 0 auto;padding-bottom:2px;}" +
      ".mcp-word{width:auto;flex:0 0 auto;font-size:11px;padding:2px 7px;gap:4px;}" +
      ".mcp-word-w{max-width:110px;}" +
      ".mcp-word-c{font-size:9.5px;}" +
      ".mcp-freq-hint{display:none;}" +
      ".mcp-freq-empty{font-size:10.5px;padding:0;}" +
      ".mcp-count{font-size:10.5px;padding:0 1px 4px;}" +
      ".mcp-results{overflow:visible;gap:5px;padding-right:0;}" +
      ".mcp-hit{padding:6px 9px 7px;border-radius:8px;}" +
      ".mcp-hit-meta{gap:6px;font-size:10px;}" +
      ".mcp-who{font-size:10px;padding:0 6px;}" +
      ".mcp-room,.mcp-floor{font-size:9.5px;}" +
      ".mcp-hit-text{font-size:12.5px;line-height:1.5;margin:3px 0 1px;-webkit-line-clamp:4;}" +
      ".mcp-refline{font-size:11px;gap:5px;padding:1px 0;}" +
      ".mcp-reflang{font-size:8.5px;}" +
      ".mcp-hit-acts{gap:5px;margin-top:4px;}" +
      ".mcp-tbtn{font-size:9.5px;padding:1px 8px;}" +
      ".mcp-empty{font-size:11.5px;padding:12px 8px;line-height:1.6;}" +
      ".mcp-morewrap{padding-top:5px;}" +
      ".mcp-more{font-size:10.5px;padding:3px 12px;}" +
      ".mcp-foot{padding:6px 12px 8px;gap:6px;flex-wrap:wrap;}" +
      ".mcp-privacy{font-size:9.5px;line-height:1.45;flex:1 1 100%;}" +
      ".mcp-actions{gap:6px;width:100%;justify-content:flex-start;}" +
      ".mcp-btn{font-size:10.5px;padding:3px 9px;letter-spacing:.5px;}" +
      ".mcp-status{bottom:52px;font-size:10.5px;padding:5px 12px;max-width:92%;}" +
      ".mcp-modal{padding:14px 15px 12px;}" +
      ".mcp-modal-title{font-size:15px;margin-bottom:7px;}" +
      ".mcp-modal-text{font-size:11.5px;line-height:1.6;margin-bottom:11px;}" +
      ".mcp-modal-acts .mcp-btn{font-size:11px;padding:4px 10px;}" +
      "}" +
      "@media (prefers-reduced-motion:reduce){" +
      ".momo-corpus-panel,.momo-corpus-btn,.mcp-status{transition:none;}" +
      "}";
    var st = document.createElement("style");
    st.id = "momo-corpus-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ============================================================
     面板构建
     ============================================================ */
  function stage() {
    return document.querySelector('[data-screen="' + SCR + '"] .stage');
  }

  function buildButton() {
    if (btn && btn.parentNode) { updateBadge(); return true; }
    var stg = stage();
    if (!stg) return false;
    injectStyle();
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "momo-corpus-btn";
    btn.textContent = "语 料";          /* 作者 P0：只有两个字，和「说 话」等宽 */
    btn.setAttribute("aria-label", "打开语料库");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      togglePanel();
    });
    stg.appendChild(btn);
    watchChatOpen();
    updateBadge();
    return true;
  }

  /* 聊天面板打开时把语料胶囊收起来（和「说 话」按钮自己 .off 的行为一致）：
     手机上反缩放后的胶囊会压到聊天面板右上角的关闭键，不能挡入口。 */
  var chatWatch = null;
  function watchChatOpen() {
    if (chatWatch) { syncChatOpen(); return; }
    var box = document.querySelector('[data-screen="' + SCR + '"] .momo-chat');
    if (!box || typeof MutationObserver === "undefined") return;
    chatWatch = new MutationObserver(syncChatOpen);
    chatWatch.observe(box, { attributes: true, attributeFilter: ["class"] });
    syncChatOpen();
  }
  function syncChatOpen() {
    var box = document.querySelector('[data-screen="' + SCR + '"] .momo-chat');
    if (btn) btn.classList.toggle("chat-open", !!(box && box.classList.contains("on")));
  }

  function buildPanel() {
    if (panel) return true;
    injectStyle();
    panel = document.createElement("div");
    panel.className = "momo-corpus-panel";
    panel.id = "momo-corpus-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "墨墨 · 语料库");
    panel.innerHTML =
      '<div class="mcp-head">' +
        '<div class="mcp-titlewrap">' +
          '<div class="mcp-title">墨墨 · 语料库<span class="mcp-title-n"> · 0 句</span></div>' +
          '<div class="mcp-sub">她的话与你的话，分开长成一份私人语料</div>' +
        '</div>' +
        '<div class="mcp-stats">' +
          '<span class="mcp-stat"><b data-stat="count">0</b><i>句</i></span>' +
          '<span class="mcp-stat"><b data-stat="words">0</b><i>独立词</i></span>' +
          '<span class="mcp-stat"><b data-stat="align">0</b><i>已对照</i></span>' +
        '</div>' +
        '<button class="mcp-x" type="button" aria-label="关闭语料库">×</button>' +
      '</div>' +
      '<div class="mcp-tabs" role="tablist">' +
        '<button class="mcp-tab on" type="button" data-tab="all" role="tab" aria-selected="true">全部</button>' +
        '<button class="mcp-tab" type="button" data-tab="user" role="tab" aria-selected="false">我的输入</button>' +
        '<button class="mcp-tab" type="button" data-tab="momo" role="tab" aria-selected="false">墨墨的话</button>' +
      '</div>' +
      '<div class="mcp-tools">' +
        '<input class="mcp-search" type="search" autocomplete="off" spellcheck="false" ' +
               'placeholder="检索：英文单词 / 中文子串（不区分大小写）">' +
        '<select class="mcp-time" aria-label="时间范围">' +
          '<option value="all">全部时间</option>' +
          '<option value="today">今天</option>' +
          '<option value="7">近 7 天</option>' +
          '<option value="30">近 30 天</option>' +
        '</select>' +
        '<select class="mcp-align" aria-label="对照状态">' +
          '<option value="all">对照：全部</option>' +
          '<option value="yes">已对照</option>' +
          '<option value="no">未对照</option>' +
        '</select>' +
        '<button class="mcp-batch" type="button" title="只生成当前结果里还没有对照的句子，一次最多 8 条">批量对照</button>' +
      '</div>' +
      '<div class="mcp-main">' +
        '<aside class="mcp-freq">' +
          '<div class="mcp-freq-head">词 频 <span>Top</span></div>' +
          '<div class="mcp-freq-list"></div>' +
          '<div class="mcp-freq-hint">点词直接检索</div>' +
        '</aside>' +
        '<section class="mcp-resbox">' +
          '<div class="mcp-count">—</div>' +
          '<div class="mcp-results"></div>' +
          '<div class="mcp-morewrap"></div>' +
        '</section>' +
      '</div>' +
      '<div class="mcp-foot">' +
        '<div class="mcp-privacy">只存这台设备 · 不上传 · 每个玩家独立（不同名字 / 浏览器互不可见）。' +
          'EN / JA 对照只在你点「生成」时把那一句发给 AI，结果只写本机。</div>' +
        '<div class="mcp-actions">' +
          '<button class="mcp-btn mcp-export" type="button">导出 JSON</button>' +
          '<button class="mcp-btn mcp-danger mcp-clear" type="button">清空我的语料</button>' +
          '<button class="mcp-btn mcp-close" type="button">收 起</button>' +
        '</div>' +
      '</div>' +
      '<div class="mcp-status" aria-live="polite"></div>' +
      '<div class="mcp-modal-mask">' +
        '<div class="mcp-modal" role="dialog" aria-modal="true">' +
          '<div class="mcp-modal-title"></div>' +
          '<div class="mcp-modal-text"></div>' +
          '<div class="mcp-modal-acts">' +
            '<button class="mcp-btn mcp-modal-cancel" type="button">取消</button>' +
            '<button class="mcp-btn mcp-primary mcp-modal-ok" type="button">知道了</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    els = {
      panel: panel,
      statCnt: $('[data-stat="count"]', panel),
      titleN: $(".mcp-title-n", panel),
      statWords: $('[data-stat="words"]', panel),
      statAlign: $('[data-stat="align"]', panel),
      tabs: $(".mcp-tabs", panel),
      search: $(".mcp-search", panel),
      time: $(".mcp-time", panel),
      align: $(".mcp-align", panel),
      batch: $(".mcp-batch", panel),
      freqList: $(".mcp-freq-list", panel),
      main: $(".mcp-main", panel),
      count: $(".mcp-count", panel),
      results: $(".mcp-results", panel),
      moreWrap: $(".mcp-morewrap", panel),
      status: $(".mcp-status", panel),
      modalMask: $(".mcp-modal-mask", panel),
      modalTitle: $(".mcp-modal-title", panel),
      modalText: $(".mcp-modal-text", panel),
      modalOk: $(".mcp-modal-ok", panel),
      modalCancel: $(".mcp-modal-cancel", panel),
      privacy: $(".mcp-privacy", panel)
    };

    /* 面板内点击不再冒泡：别让游戏的全局点击逻辑（点一下推进）抢事件 */
    panel.addEventListener("click", function (e) { e.stopPropagation(); });

    $(".mcp-x", panel).addEventListener("click", function (e) {
      e.stopPropagation(); closePanel();
    });
    $(".mcp-close", panel).addEventListener("click", function (e) {
      e.stopPropagation(); closePanel();
    });

    els.tabs.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".mcp-tab") : null;
      if (!b) return;
      state.tab = b.getAttribute("data-tab") || "all";
      state.limit = RENDER_STEP;
      syncTabs();
      renderFreq();
      renderList();
    });

    var searchTimer = 0;
    els.search.addEventListener("input", function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchTimer = 0;
        state.q = els.search.value.trim();
        state.limit = RENDER_STEP;
        renderList();
      }, 90);
    });
    els.search.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") {
        els.search.value = "";
        state.q = "";
        state.limit = RENDER_STEP;
        renderList();
      }
    });

    els.time.addEventListener("change", function () {
      state.time = els.time.value || "all";
      state.limit = RENDER_STEP;
      renderFreq();
      renderList();
    });
    els.align.addEventListener("change", function () {
      state.align = els.align.value || "all";
      state.limit = RENDER_STEP;
      renderFreq();
      renderList();
    });
    els.batch.addEventListener("click", function (e) {
      e.stopPropagation();
      batchTranslate();
    });

    els.modalOk.addEventListener("click", function (e) {
      e.stopPropagation();
      var fn = modal.onOk;
      hideModal();
      if (fn) { try { fn(); } catch (err) {} }
    });
    els.modalCancel.addEventListener("click", function (e) {
      e.stopPropagation();
      hideModal();
    });
    els.modalMask.addEventListener("click", function (e) {
      if (e.target === els.modalMask) hideModal();
    });

    $(".mcp-export", panel).addEventListener("click", function (e) {
      e.stopPropagation(); exportJSON();
    });
    $(".mcp-clear", panel).addEventListener("click", function (e) {
      e.stopPropagation(); askClear();
    });
    return true;
  }

  /* ============================================================
     打开 / 关闭 / 导出 / 清空
     ============================================================ */
  function openPanel() {
    warmTranslate();
    if (!buildPanel()) return;
    if (!buildButton()) { /* 主画面舞台还没就绪也没关系，面板仍可开 */ }
    ensureIdentity();
    if (storageOk) load();
    openState = true;
    panel.classList.add("on");
    /* 与聊天面板一致：自己的面板打开时把入口收起（.off 的声明照抄 .momo-chat-btn.off） */
    if (btn) btn.classList.add("off");
    renderAll();
    broadcastTop();
    setStatus("", 0);
    if (window.innerWidth > 900) {
      setTimeout(function () {
        try { if (openState && els.search) els.search.focus(); } catch (e) {}
      }, 80);
    }
  }

  function closePanel() {
    if (!panel) return;
    openState = false;
    panel.classList.remove("on");
    if (btn) btn.classList.remove("off");
    hideModal();
  }

  function togglePanel() {
    if (openState) closePanel();
    else openPanel();
  }

  function safeName(s) {
    return String(s || "player").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 32) || "player";
  }

  function dateStamp() {
    var d = new Date();
    return d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2);
  }

  function exportJSON() {
    var data = {
      app: "墨墨的洋馆", kind: "momo-corpus", v: 1,
      uid: uid, profile: profile,
      exportedAt: new Date().toISOString(),
      count: entries.length,
      entries: entries
    };
    try {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "momo-corpus-" + safeName(profile) + "-" + dateStamp() + ".json";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 1500);
      setStatus("已导出到本机下载（" + entries.length + " 条）。", 4200);
    } catch (e) {
      setStatus("导出失败：这个浏览器不允许下载。", 4200);
    }
  }

  function askClear() {
    if (!entries.length) { setStatus("这份语料库已经是空的。", 3000); return; }
    showModal({
      title: "清空我的语料？",
      text: "会删掉这台设备上「" + profile + "」的 " + entries.length +
            " 条语料，无法恢复。其他玩家的语料不会被碰到（他们用另一把钥匙）。",
      ok: "确定清空",
      cancel: "再想想",
      danger: true,
      onOk: function () {
        entries = [];
        if (store) store.entries = entries;
        dataVersion++;
        save();
        state.limit = RENDER_STEP;
        renderAll();
        updateBadge();
        setStatus("已清空这份语料库。", 3600);
      }
    });
  }

  /* ============================================================
     事件接线 / 启动
     ============================================================ */
  document.addEventListener("momo:chatlog", function (e) {
    var d = e && e.detail;
    if (!d) return;
    capture(d.who, d.text, d.ts);
  });

  document.addEventListener("momo:show", function (e) {
    var scr = e && e.detail && e.detail.screen;
    if (scr === SCR) {
      buildButton();
      watchChatOpen();
      setTimeout(syncChatOpen, 30);
      if (openState) { ensureIdentity(); if (storageOk) load(); renderAll(); }
    } else if (openState) {
      closePanel();
    }
  });

  /* 别的标签页改了同一份语料（很少见，但别让两页各存一份不一致） */
  window.addEventListener("storage", function (e) {
    if (!e || e.key !== key) return;
    if (!storageOk) return;
    load();
    if (openState) renderAll(); else updateBadge();
  });

  /* Esc：先关弹窗，再关面板（搜索框会自己 stopPropagation） */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (modal.open) { hideModal(); return; }
    if (openState) closePanel();
  });

  /* 启动：语料库本身只依赖 DOM 与 localStorage；主画面入口等舞台就绪。 */
  function boot() {
    ensureIdentity();
    if (!buildButton()) {
      /* 脚本可能早于 DOMContentLoaded 求值（拆分模式） */
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
          buildButton();
          watchChatOpen();
          setTimeout(syncChatOpen, 50);
        });
      }
    }
    updateBadge();
  }
  boot();

  /* ---------------- 对外接口（含自动化验证用的只读出口） ---------------- */
  window.MomoCorpus = {
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    capture: capture,
    isOpen: function () { return openState; },
    /** 当前玩家的语料条目（浅拷贝，避免外部改到内部结构） */
    entries: function () {
      return entries.map(function (e) {
        return { id: e.id, ts: e.ts, who: e.who, text: e.text, room: e.room,
                 floor: e.floor, en: e.en, ja: e.ja, tags: e.tags.slice() };
      });
    },
    stats: function () {
      var anc = 0;
      for (var i = 0; i < entries.length; i++) if (aligned(entries[i])) anc++;
      return { count: entries.length, words: uniqueWordCount(), aligned: anc };
    },
    top: function (n) { return topWords(n || FALL_TOP); },
    /** 本地存储键：两个 profile / 两台设备必须是两个不同键 */
    storageKey: function () { return key; },
    uid: function () { return uid; },
    profile: function () { return profile; },
    clear: function () {
      entries = [];
      if (store) store.entries = entries;
      dataVersion++;
      save();
      if (openState) renderAll();
      updateBadge();
    },
    exportJSON: exportJSON,
    /* 让自动化测试能稳定地打开面板并读到渲染结果 */
    _render: function () { if (openState) renderAll(); },
    _setSearch: function (q) { setSearch(q); }
  };
})();
