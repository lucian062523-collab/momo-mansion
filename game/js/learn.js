/* 墨墨 · 学习界面（渲染层）
   5 块面板 × 2 个语种，全部由数据驱动 —— 面板里没有一个写死的词。

   数据：
     MOMO_DATA.words_en / words_ja        词库（雅思 6.0/6.5/7.0/7.5+ · 标日初级上 1–24 課）
     MOMO_DATA.grammar_en / grammar_ja    语法库（章节 + 语法点）
   事实来源：
     MomoSRS   记忆调度（三档自评 → 下次到期日 → 掌握判定）
     MomoQuiz  出题判分（四变体）
     MomoStore 存档（learn.lang / learned / starred / wrong / grammar）

   职责边界：本文件只管「把数据画成 DOM」和「把点击变成状态变更」。
   记忆怎么排、题怎么出、对错怎么判，全在 srs.js / quiz.js 里，这里不重复实现。 */
(function () {
  "use strict";
  var STORE = window.MomoStore, SRS = window.MomoSRS, QUIZ = window.MomoQuiz;
  var DATA = window.MOMO_DATA || {};
  if (!STORE || !SRS || !QUIZ) return;

  var scr = document.querySelector('[data-screen="学习界面"]');
  if (!scr) return;

  var SUBTABS = [
    { key: "wc", name: "单词卡片" },
    { key: "sd", name: "背单词" },
    { key: "nb", name: "记词本" },
    { key: "gr", name: "语法页" },
    { key: "mk", name: "错题集" },
    { key: "qz", name: "练习" }
  ];
  var TIER_EN = { 1: "雅思 6.0 · 核心", 2: "雅思 6.5", 3: "雅思 7.0", 4: "雅思 7.5+" };
  var KIND_ZH = { meaning: "词义选择", cloze: "填空", colloc: "用法搭配", listen: "听音选词" };
  var DRILL_N = 10;          // 一组练习的题量

  /* ============================================================ 学习产出
     数值全部来自 game/content/lessons.json 的 economy.currency_gain，
     这里一个数都不写死（daily.js 已经把它整理成 MomoDaily.GIVE，优先取它）。
     产出统一走 STORE.earn —— 那是「钱从哪来」与数值层之间唯一的接缝。 */
  var ECON = ((DATA.lessons || {}).economy || {});
  var GAIN = ECON.currency_gain || {};
  var GIVE = (window.MomoDaily && window.MomoDaily.GIVE) || {
    flashcard_remember: GAIN.flashcard_remember || 0,
    flashcard_fuzzy: GAIN.flashcard_fuzzy || 0,
    quiz_correct_srs: GAIN.quiz_correct_srs || 0,
    quiz_correct_practice: GAIN.quiz_correct_practice || 0,
    combo_bonus_per_item: GAIN.combo_bonus_per_item || 0
  };

  /* 答题产出的唯一出口：加钱 → 记账（source=learn）→ 让货币读数闪一下 */
  function pay(n) {
    if (!n) return 0;
    STORE.earn(n, "learn");
    sfxOf("sfx-coin");
    flashMoney(n);
    coinFly();
    return n;
  }

  var tabsBox = scr.querySelector(".learn-subtabs");
  var langsBox = scr.querySelector(".learn-langs");
  var panels = {};
  SUBTABS.forEach(function (t) { panels[t.key] = scr.querySelector('.learn-panel[data-learn="' + t.key + '"]'); });
  if (!tabsBox || !langsBox) return;

  function learn() { return STORE.state.learn; }
  function words(l) { return (l === "ja" ? DATA.words_ja : DATA.words_en) || []; }
  function grammar(l) { return l === "ja" ? DATA.grammar_ja : DATA.grammar_en; }

  var lang = learn().lang === "ja" ? "ja" : "en";
  var tab = SUBTABS[0].key;
  var wcIdx = { en: 0, ja: 0 };          // 单词卡片各自记位置，切语种不会跳
  /* 单词卡片的「词库检索」：英语存首字母（""＝全部），日语存课次（0＝全部），
     外加一个关键词。只筛「单词卡片」这一块，背单词/练习的课次不受影响。 */
  var wcScope = { en: "", ja: 0 };
  var wcQuery = { en: "", ja: "" };
  var wcTocBuilt = null;                  // 侧栏按语种搭一次，换语种才重建
  var drill = null;                       // 当前练习会话
  var nbFilter = "all";
  var DECK_N = 20;                        // 一轮背单词的卡量
  var sdRound = null;                     // 当前背单词轮次
  /* 日语才有课次结构：0 = 全部。切语种时归零 */
  var sdLesson = 0, qzLesson = 0;
  var lessonCountCache = {};

  /* ============================================================ 货币读数
     学习是货币唯一的产出口，读数就挂在本屏右上角（标签栏 left:60 + 1286 宽 ≈ 1346 结束，
     再往右是空的；BACK 在左下角，不冲突）。
     没有这块读数，经济系统就只活在存档里 —— 答对一题钱在涨，得让人亲眼看见。 */
  var moneyNum = null, moneyGain = null;
  function buildMoney() {
    if (moneyNum) return;
    var st = scr.querySelector(".stage") || scr;
    var box = document.createElement("div");
    box.className = "learn-money";
    var lbl = document.createElement("span");
    lbl.textContent = "货币";
    moneyNum = document.createElement("b");
    moneyGain = document.createElement("i");
    moneyGain.className = "gain";
    box.appendChild(lbl);
    box.appendChild(moneyNum);
    box.appendChild(moneyGain);
    st.appendChild(box);
    renderMoney();
  }
  function renderMoney() {
    if (moneyNum) moneyNum.textContent = String(Math.round(STORE.state.currency || 0));
  }
  function flashMoney(n) {
    renderMoney();
    if (!moneyGain || n <= 0) return;
    moneyGain.textContent = "+" + n;
    /* 重放动画：先摘掉 class 并强制回流，再加回去，否则连着两次加钱只有第一次会动 */
    moneyGain.classList.remove("flash");
    void moneyGain.offsetWidth;
    moneyGain.classList.add("flash");
  }

  /* 金币飞入：一枚小金币从「刚才点过的位置」飞向右上角的货币读数。
     坐标全部走视口系（position:fixed）—— .stage 有缩放变换，舞台系换算反而绕。
     起点取最近一次点击的落点：加钱的动作几乎都是点出来的，视觉上就是
     「从点的那里掉出一枚金币、叮的一声落进钱袋」。 */
  var lastTap = null;
  document.addEventListener("pointerdown", function (e) {
    lastTap = { x: e.clientX, y: e.clientY };
  }, true);
  function coinFly() {
    if (!moneyNum) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var coin = document.createElement("i");
    coin.className = "coin-fly";
    var from = lastTap || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    coin.style.left = from.x + "px";
    coin.style.top = from.y + "px";
    /* 必须挂 body：.stage 带 scale 变换，transform 会劫持 fixed 的包含块，
       挂进去视口坐标就全错位了。 */
    document.body.appendChild(coin);
    var r = moneyNum.getBoundingClientRect();
    coin.style.setProperty("--to-x", (r.left + r.width / 2 - from.x) + "px");
    coin.style.setProperty("--to-y", (r.top + r.height / 2 - from.y) + "px");
    setTimeout(function () { if (coin.parentNode) coin.parentNode.removeChild(coin); }, 900);
  }
  document.addEventListener("momo:store", renderMoney);

  function slot(root, name) { return root.querySelector('[data-f="' + name + '"]'); }
  function put(root, name, text) {
    var e = slot(root, name);
    if (e) e.textContent = text == null ? "" : String(text);
    return e;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function rows(root, name) {
    var tpl = root.querySelector('template[data-tpl="' + name + '"]');
    return tpl ? tpl.content.firstElementChild : null;
  }
  function levelLabel(w) {
    if (w.lang === "ja") return w.lesson ? "标日初级上 · 第" + w.lesson + "課"
                                        : "月见茶会 · 词包";   /* 章节新增词不挂課号；原有课词（如 ja_橋）不受影响 */
    if (w.tags && w.tags.indexOf("s1c1") >= 0) return "月见茶会 · 词包";
    return TIER_EN[w.tier] || "雅思 · 词库";
  }
  function subLabel(w) { return w.lang === "ja" ? w.kana : (w.pron || ""); }

  /* ============================================================ Q 版陪读小人
     站在「单词卡片」「背单词」的卡片右侧，脸跟着自评结果变：
       答对 / 认识          → 积极池里随机一张
       答错 / 模糊 / 不认识  → 消极池里随机一张
     只换脸、不参与判分：记忆调度在 srs.js，这里纯表现。
     池子与文件名的对应关系都在 game/content/qmomo.json，改归类不用碰这个文件。 */
  var QM = DATA.qmomo || {};
  var qcEls = {};
  var qcPools = { good: QM.positive || [], bad: QM.negative || [] };

  function qcPick(kind) {
    var pool = qcPools[kind];
    if (!pool || !pool.length) return QM["default"];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  /* kind: good | bad | 其它（回到常态脸） */
  function qcSet(key, kind) {
    var el = qcEls[key];
    if (!el) return;
    var file = (kind === "good" || kind === "bad") ? qcPick(kind) : QM["default"];
    var u = file && (window.ASSET_URI || {})[file];
    if (!u) return;
    el.dataset.qcFile = file;
    el.style.backgroundImage = 'url("' + u + '")';
  }
  function qcInit() {
    [].slice.call(scr.querySelectorAll(".qc-momo")).forEach(function (el) {
      var k = el.getAttribute("data-qc");
      if (!k) return;
      qcEls[k] = el;
      if (!el.style.backgroundImage) qcSet(k, "");
    });
  }

  /* ============================================================ 答题反馈三件套
     ① 台词：dialogues.json 的「答题」桶（right / wrong / combo / perfect），
        答对答错当场给一句毒舌 —— 数值零惩罚的硬规则不变，情绪由台词承担。
     ② 音效 / 语音：存在才放（MomoAudio 缺席即无声，不影响流程）。
     ③ 连击徽章：连对 ≥2 时挂在题头右上，每次更新弹一下。 */
  var TAUNT = ((DATA.dialogues || {})["答题"]) || {};
  var lastTaunt = {};
  function taunt(kind) {
    var pool = TAUNT[kind];
    if (!pool || !pool.length) return "";
    var s = pool[Math.floor(Math.random() * pool.length)];
    for (var i = 0; i < 4 && s === lastTaunt[kind]; i++) {
      s = pool[Math.floor(Math.random() * pool.length)];
    }
    lastTaunt[kind] = s;
    return s;
  }
  function sfxOf(name) { if (window.MomoAudio) MomoAudio.sfx(name); }
  /* 语音池随机：MomoAudio.pick 已按「当前学习语种」挑好池（学英语放英语、学
     日语放日语、没录变体回落中文），这里只负责「同池不连着重复」。台词数量
     不受代码限制 —— 按 vo-[en-|ja-]前缀-1..N 放进 game/audio/ 即可。 */
  var lastVo = {};
  function voPick(prefix) {
    if (!window.MomoAudio || !MomoAudio.pick) return;
    var s = MomoAudio.pick(prefix);
    if (!s) return;
    for (var i = 0; i < 4 && s === lastVo[prefix]; i++) s = MomoAudio.pick(prefix);
    lastVo[prefix] = s;
    MomoAudio.vo(s);
  }

  var comboEl = null;
  function comboChip(n) {
    var head = qz.querySelector(".dr-head");
    if (!head) return;
    if (!comboEl) {
      comboEl = document.createElement("span");
      comboEl.className = "dr-combo";
      head.appendChild(comboEl);
    }
    comboEl.textContent = "×" + n + " 连对";
    comboEl.classList.remove("pop");
    void comboEl.offsetWidth;                    /* 重放弹跳动画 */
    comboEl.classList.add("pop");
  }
  function comboChipDrop() {
    if (comboEl) { comboEl.remove(); comboEl = null; }
  }

  /* ============================================================ 单词卡片 */
  var wc = panels.wc;
  var flipWrap = wc.querySelector(".flip-wrap");
  var starBtn = wc.querySelector("#starBtn");
  var collectBtn = wc.querySelector("#collectBtn");

  function starList() {
    var L = learn();
    if (!L.starred) L.starred = { en: [], ja: [] };
    if (!L.starred[lang]) L.starred[lang] = [];
    return L.starred[lang];
  }
  function isStarred(id) { return starList().indexOf(id) >= 0; }

  /* 当前检索条件下的词表：英语 A→Z（数据本身就是字母序），日语按课次 */
  function wcPool() {
    var scope = wcScope[lang];
    var q = String(wcQuery[lang] || "").trim().toLowerCase();
    return words(lang).filter(function (w) {
      if (lang === "ja") {
        if (scope && w.lesson !== scope) return false;
      } else if (scope && String(w.lemma).charAt(0).toUpperCase() !== scope) {
        return false;
      }
      if (!q) return true;
      var hay = [w.lemma, w.kanji, w.kana, w.romaji, w.pron, w.meaning_zh, w.pos,
                 w.lesson ? "l" + w.lesson : "", w.lesson ? "第" + w.lesson + "課" : ""];
      return hay.filter(Boolean).join(" ").toLowerCase().indexOf(q) >= 0;
    });
  }

  /* 左侧「词库检索」面板：索引按钮（英语 A–Z / 日语 第N課）+ 搜索框。
     只在换了语种时重建一次 —— 打字时重建会把输入焦点弄丢。 */
  function renderWcToc() {
    var toc = slot(wc, "toc");
    if (!toc) return;
    if (wcTocBuilt === lang) { markWcToc(); return; }
    wcTocBuilt = lang;
    clear(toc);
    toc.hidden = false;

    var h = document.createElement("h4");
    h.textContent = lang === "ja" ? "词 库 检 索 · 按课" : "词 库 检 索 · 按首字母";
    toc.appendChild(h);

    var inp = document.createElement("input");
    inp.type = "search";
    inp.className = "wc-search";
    inp.value = wcQuery[lang] || "";
    inp.placeholder = lang === "ja" ? "词形 / 释义 / 课号…" : "单词 / 释义…";
    inp.addEventListener("input", function () {
      wcQuery[lang] = inp.value;
      wcIdx[lang] = 0;
      renderWC();
    });
    inp.addEventListener("click", function (e) { e.stopPropagation(); });
    toc.appendChild(inp);

    var box = document.createElement("div");
    box.className = "lesson-toc" + (lang === "ja" ? "" : " letter-toc");
    toc.appendChild(box);
    function mk(val, label, count) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("data-scope", String(val));
      if (!val) b.className = "all";
      b.appendChild(document.createTextNode(label));
      if (count != null) {
        var n = document.createElement("i");
        n.textContent = count;
        b.appendChild(n);
      }
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        wcScope[lang] = val;
        wcIdx[lang] = 0;
        markWcToc();
        renderWC();
      });
      box.appendChild(b);
    }
    if (lang === "ja") {
      var cnt = lessonCounts("ja");
      mk(0, "全 部");
      for (var i = 1; i <= 24; i++) mk(i, "第 " + i + " 課", cnt[i] || 0);
    } else {
      var letters = {};
      words("en").forEach(function (w) {
        var c = String(w.lemma).charAt(0).toUpperCase();
        if (c) letters[c] = (letters[c] || 0) + 1;
      });
      mk("", "全 部");
      Object.keys(letters).sort().forEach(function (c) { mk(c, c); });
    }
    markWcToc();
  }
  function markWcToc() {
    var toc = slot(wc, "toc");
    if (!toc) return;
    [].slice.call(toc.querySelectorAll("[data-scope]")).forEach(function (b) {
      var v = b.getAttribute("data-scope");
      b.classList.toggle("on", lang === "ja" ? Number(v) === wcScope.ja : v === wcScope.en);
    });
  }

  function renderWC() {
    renderWcToc();
    var list = wcPool();
    var nav = wc.querySelector(".wc-nav");
    if (!list.length) {
      put(wc, "word", (wcQuery[lang] || wcScope[lang]) ? "没有匹配的词" : "词库为空");
      put(wc, "pos", "0 / 0");
      if (nav) nav.style.display = "none";
      return;
    }
    if (nav) nav.style.display = "";
    wcIdx[lang] = Math.max(0, Math.min(wcIdx[lang], list.length - 1));
    var w = list[wcIdx[lang]];
    var i = wcIdx[lang];

    flipWrap.classList.remove("flipped");
    put(wc, "level", levelLabel(w));
    put(wc, "word", QUIZ.form(w));
    put(wc, "pron", subLabel(w));
    put(wc, "pos", w.pos);
    put(wc, "mean", w.meaning_zh);
    put(wc, "ex", w.example.t);
    put(wc, "exzh", w.example.zh);
    /* 背面：搭配做成深色盒子里的词块，下面是同义/反义/罗马音/例句回显 */
    put(wc, "back-title", w.lang === "ja" ? "读 音 与 搭 配" : "搭 配 与 同 义");
    var segs = slot(wc, "segs");
    clear(segs);
    var chips = (w.colloc || []).slice(0, 3);
    if (!chips.length) chips = [w.lemma];
    chips.forEach(function (c) {
      var s = document.createElement("span");
      s.className = "seg";
      s.textContent = c;
      segs.appendChild(s);
    });
    put(wc, "note", "→ " + w.meaning_zh);
    var dl = slot(wc, "list");
    clear(dl);
    function row(label, val, en) {
      if (!val || !val.length) return;
      var div = document.createElement("div");
      var b = document.createElement("b");
      b.textContent = label;
      div.appendChild(b);
      var sp = document.createElement("span");
      if (en) sp.className = "en";
      sp.textContent = "　" + val.join(" · ");
      div.appendChild(sp);
      dl.appendChild(div);
    }
    if (w.lang === "ja") {
      row("读音", [w.kana + "（" + w.romaji + "）"]);
      if (w.kanji) row("汉字", [w.kanji]);
    }
    row("同义词", w.syn, true);
    row("反义词", w.ant, true);
    row("搭配", w.colloc, true);
    row("例句", [w.example.t], true);

    var counter = wc.querySelector(".wc-pos");
    if (counter) counter.textContent = (i + 1) + " / " + list.length;

    var on = isStarred(w.id);
    starBtn.classList.toggle("collected", on);
    starBtn.setAttribute("aria-pressed", String(on));
    collectBtn.classList.toggle("collected", on);
    collectBtn.setAttribute("aria-pressed", String(on));
    collectBtn.textContent = on ? "✓ 已在记词本中" : "＋ 收入记词本";
  }

  function toggleStar() {
    var list = wcPool();
    var w = list[wcIdx[lang]];
    if (!w) return;
    var arr = starList(), k = arr.indexOf(w.id);
    if (k < 0) arr.push(w.id); else arr.splice(k, 1);
    STORE.save();
    renderWC();
    if (tab === "nb") renderNB();
  }

  function stepWC(d) {
    var list = wcPool();
    if (!list.length) return;
    wcIdx[lang] = (wcIdx[lang] + d + list.length) % list.length;
    renderWC();
  }

  /* ============================================================ 记词本 */
  var nb = panels.nb;
  var nbRowTpl = rows(nb, "nb-item");

  function renderNB() {
    var list = words(lang);
    var ids = list.map(function (w) { return w.id; });
    var st = SRS.stats(ids);
    put(nb, "all", st.total);
    put(nb, "done", st.done);
    put(nb, "wait", st.wait);
    var rate = st.total ? Math.round(st.done / st.total * 100) : 0;
    var bar = slot(nb, "bar");
    if (bar) bar.style.width = rate + "%";
    put(nb, "goal", "远 期 目 标 · 再 复 习 " + st.wait + " 词");
    put(nb, "rate", "掌 握 率 " + rate + "%");

    [].slice.call(nb.querySelectorAll(".nb-tab")).forEach(function (t) {
      var f = t.getAttribute("data-filter");
      t.setAttribute("aria-selected", String(f === nbFilter));
      var n = f === "all" ? st.total : (f === "done" ? st.done : st.wait);
      t.textContent = (f === "all" ? "全部 " : (f === "done" ? "已掌握 " : "待复习 ")) + n;
    });

    var box = slot(nb, "list");
    clear(box);
    /* 只画前 400 行：词库上千条，全量塞进 DOM 会让面板卡顿，滚动也失去意义 */
    var MAX = 400, shown = 0;
    for (var i = 0; i < list.length && shown < MAX; i++) {
      var w = list[i];
      var s = SRS.status(w.id);
      if (nbFilter !== "all" && s !== nbFilter) continue;
      var el = nbRowTpl.cloneNode(true);
      el.classList.add("st-" + s);
      put(el, "w", QUIZ.form(w));
      put(el, "sub", subLabel(w));
      put(el, "mean", w.pos + " " + w.meaning_zh);
      put(el, "seal", s === "done" ? "已掌握" : (s === "wait" ? "待复习" : "新收录"));
      box.appendChild(el);
      shown += 1;
    }
    if (!shown) {
      var empty = document.createElement("li");
      empty.className = "nb-item";
      empty.textContent = nbFilter === "all" ? "词库为空" : "这一类暂时没有词 —— 去练习几组就会有了";
      box.appendChild(empty);
    }
  }

  /* ============================================================ 语法页 */
  var gr = panels.gr;
  var grPointId = null;

  function renderGrToc() {
    var G = grammar(lang);
    var toc = slot(gr, "toc");
    clear(toc);
    if (!G || !G.points || !G.points.length) {
      toc.textContent = "语法库为空";
      return;
    }
    var cur = grPointId || G.points[0].id;
    (G.chapters || []).forEach(function (c) {
      var pts = G.points.filter(function (p) { return p.chapter === c.id; });
      if (!pts.length) return;
      var h = document.createElement("h4");
      h.textContent = c.title;
      toc.appendChild(h);
      pts.forEach(function (p) {
        var b = document.createElement("button");
        b.type = "button";
        b.setAttribute("data-point", p.id);
        b.textContent = p.title;
        if (p.id === cur) b.classList.add("on");
        b.addEventListener("click", function () { grPointId = p.id; renderGr(); });
        toc.appendChild(b);
      });
    });
  }

  function renderGrDetail() {
    var G = grammar(lang);
    if (!G || !G.points || !G.points.length) {
      put(gr, "title", "语法库为空");
      return;
    }
    var p = G.points.filter(function (x) { return x.id === grPointId; })[0] || G.points[0];
    grPointId = p.id;
    put(gr, "kicker", p.kicker);
    put(gr, "title", p.title);
    put(gr, "title-sub", p.title_sub);
    put(gr, "formula-label", p.formula_label);
    var f = slot(gr, "formula");
    clear(f);
    (p.formula || []).forEach(function (seg) {
      var s = document.createElement("span");
      if (seg.zh) s.className = "zh";
      s.textContent = seg.t;
      f.appendChild(s);
    });
    var ex = slot(gr, "examples");
    clear(ex);
    (p.examples || []).forEach(function (e, i) {
      var item = document.createElement("div");
      item.className = "gr-ex-item";
      var no = document.createElement("span");
      no.className = "no";
      var noi = document.createElement("i");
      noi.textContent = String(i + 1);
      no.appendChild(noi);
      item.appendChild(no);
      var para = document.createElement("p");
      var em = document.createElement("em");
      if (e.hl && String(e.t).indexOf(e.hl) >= 0) {
        var parts = String(e.t).split(e.hl);
        em.appendChild(document.createTextNode(parts[0]));
        var strong = document.createElement("strong");
        strong.textContent = e.hl;
        em.appendChild(strong);
        em.appendChild(document.createTextNode(parts.slice(1).join(e.hl)));
      } else {
        em.textContent = e.t;
      }
      para.appendChild(em);
      var zh = document.createElement("span");
      zh.textContent = e.zh;
      para.appendChild(zh);
      item.appendChild(para);
      ex.appendChild(item);
    });
    put(gr, "note-label", p.note_label);
    var note = slot(gr, "note");
    /* note 允许 <b> <i> <em> <strong>（契约里限定），是自家内容，直接内联 */
    if (note) note.innerHTML = p.note || "";
    var foot = slot(gr, "foot");
    if (foot) {
      clear(foot);
      foot.appendChild(document.createTextNode(p.foot + "　"));
      var i1 = document.createElement("i");
      i1.textContent = "◆";
      foot.appendChild(i1);
      foot.appendChild(document.createTextNode(
        p.lang === "ja" ? "　L" + p.page + "　" : "　第 " + p.page + " 页　"));
      var i2 = document.createElement("i");
      i2.textContent = "◆";
      foot.appendChild(i2);
      foot.appendChild(document.createTextNode("　" + (p.lang === "ja" ? "初级上" : "雅思")));
    }
    /* 记一笔「看过」—— 语法页的进度是独立于 SRS 的（语法点不做间隔重复） */
    var L = learn();
    if (!L.grammar) L.grammar = { en: [], ja: [] };
    if (!L.grammar[lang]) L.grammar[lang] = [];
    if (L.grammar[lang].indexOf(p.id) < 0) {
      L.grammar[lang].push(p.id);
      STORE.save();
    }
  }

  function renderGr() { renderGrToc(); renderGrDetail(); }

  /* ============================================================ 错题集 */
  var mk = panels.mk;
  var mkRowTpl = rows(mk, "mk-item");

  function wrongList() {
    var L = learn();
    if (!L.wrong) L.wrong = { en: [], ja: [] };
    if (!L.wrong[lang]) L.wrong[lang] = [];
    return L.wrong[lang];
  }
  /* 错题按「最近答错的排最前」；同一题只留一条，重犯就顶到最前。
     picked / right 存的是**当时那道题的选项文本** —— 填空题的正确答案是词形、
     ＊词义题的正确答案是释义，不能一律拿 meaning_zh 顶上。 */
  function addWrong(w, kind, picked, right) {
    var arr = wrongList();
    var id = w.id;
    for (var i = arr.length - 1; i >= 0; i--) if (arr[i].id === id) arr.splice(i, 1);
    arr.unshift({ id: id, kind: kind, picked: picked == null ? "" : String(picked),
                  right: right == null ? "" : String(right) });
    if (arr.length > 100) arr.length = 100;
    STORE.save();
  }

  function renderMK() {
    var byId = {};
    words(lang).forEach(function (w) { byId[w.id] = w; });
    var arr = wrongList();
    var box = slot(mk, "list");
    clear(box);
    var kept = 0;
    arr.forEach(function (rec) {
      var w = byId[rec.id];
      if (!w) return;
      kept += 1;
      var el = mkRowTpl.cloneNode(true);
      el.setAttribute("data-word", w.id);
      put(el, "no", kept);
      var q = slot(el, "q");
      clear(q);
      q.appendChild(document.createTextNode(QUIZ.form(w) + "　"));
      var em = document.createElement("em");
      em.textContent = "· " + (KIND_ZH[rec.kind] || "词义选择");
      q.appendChild(em);
      put(el, "picked", rec.picked || "—");
      put(el, "right", rec.right || w.meaning_zh);
      put(el, "why-label", "错因 · " + w.pos);
      put(el, "why", w.meaning_zh + "　例：" + w.example.t + "　" + w.example.zh);
      var drop = el.querySelector('[data-act="drop"]');
      if (drop) {
        drop.addEventListener("click", function (e) {
          e.stopPropagation();
          var a = wrongList();
          for (var i = a.length - 1; i >= 0; i--) if (a[i].id === w.id) a.splice(i, 1);
          STORE.save();
          el.classList.add("removed");
          setTimeout(renderMK, 260);
        });
      }
      box.appendChild(el);
    });
    if (!kept) {
      var empty = document.createElement("div");
      empty.className = "mk-item";
      empty.style.padding = "18px";
      empty.style.textAlign = "center";
      empty.style.fontSize = "12.5px";
      empty.textContent = "还没有错题 —— 去「练习」做几组，答错的会自动收进来";
      box.appendChild(empty);
    }
    var cnt = slot(mk, "count");
    if (cnt) cnt.textContent = String(kept);
  }

  var mkRedo = mk.querySelector('[data-act="redo"]');
  if (mkRedo) {
    mkRedo.addEventListener("click", function () {
      var box = slot(mk, "list");
      [].slice.call(box.querySelectorAll(".mk-item.removed")).forEach(function (el) {
        el.classList.remove("removed");
        el.removeAttribute("open");
      });
      /* 「重做」= 把这批错题立刻排到练习队列最前面 */
      var arr = wrongList();
      if (arr.length) startDrill(arr.map(function (r) { return r.id; }));
    });
  }

  /* ============================================================ 课次选择器
     日语按《标日初级上》的课次选范围，英语没有课次结构、目录整块隐藏。
     「背单词」选卡组、「练习」选出题范围，共用这一套（外观沿用语法页那份目录）。 */
  function lessonCounts(l) {
    if (!lessonCountCache[l]) {
      var c = {};
      words(l).forEach(function (w) { if (w.lesson) c[w.lesson] = (c[w.lesson] || 0) + 1; });
      lessonCountCache[l] = c;
    }
    return lessonCountCache[l];
  }
  function pickByLesson(l, lesson) {
    var all = words(l);
    return lesson ? all.filter(function (w) { return w.lesson === lesson; }) : all;
  }
  function renderLessonToc(root, sel, onPick) {
    var toc = slot(root, "toc");
    if (!toc) return;
    clear(toc);
    if (lang !== "ja") { toc.hidden = true; return; }
    toc.hidden = false;
    var h = document.createElement("h4");
    h.textContent = "日语 · 按课选";
    toc.appendChild(h);
    var box = document.createElement("div");
    box.className = "lesson-toc";
    toc.appendChild(box);
    var cnt = lessonCounts("ja");
    function mk(lesson, label) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("data-lesson", String(lesson));
      if (!lesson) b.className = "all";
      b.appendChild(document.createTextNode(label));
      if (lesson) {
        var i = document.createElement("i");
        i.textContent = cnt[lesson] || 0;
        b.appendChild(i);
      }
      if (lesson === sel) b.classList.add("on");
      b.addEventListener("click", function (e) { e.stopPropagation(); onPick(lesson); });
      box.appendChild(b);
    }
    mk(0, "全 部");
    for (var i = 1; i <= 24; i++) mk(i, "第 " + i + " 課");
  }

  /* ============================================================ 背单词
     卡组翻牌：认识 / 看释义 / 不认识。认识→记得(2)、不认识→忘了(0)，
     与单词卡片那三档自评走的是同一套记忆调度，所以「待复习」在记词本里立刻可见。 */
  var sd = panels.sd;

  function deckIds() {
    var pool = pickByLesson(lang, sdLesson).map(function (w) { return w.id; });
    /* 先打乱再交给 SRS.pick：到期词仍排最前，但新存档下不会永远只背词表开头那几个 */
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return SRS.pick(pool, DECK_N);
  }

  function startDeck() {
    var byId = {};
    pickByLesson(lang, sdLesson).forEach(function (w) { byId[w.id] = w; });
    var items = deckIds().map(function (id) { return byId[id]; }).filter(Boolean);
    sdRound = items.length
      ? { items: items, i: 0, hit: 0, miss: 0, earned: 0, marks: [], busy: false } : null;
    var acts = slot(sd, "acts"), stage = slot(sd, "stage"), sum = slot(sd, "summary");
    if (acts) acts.style.display = "";
    if (stage) stage.style.display = "";
    if (sum) sum.classList.remove("show");
    renderSD();
  }

  function deckLabel() {
    if (lang !== "ja") return "本轮进度";
    return sdLesson ? "第 " + sdLesson + " 課" : "全部词库";
  }

  /* 「目标词」在例句里加粗：找不到原形（例句用了变形）就整句照排 */
  function exNode(w) {
    var em = document.createElement("em");
    var t = String(w.example.t), f = QUIZ.form(w), k = t.indexOf(f);
    if (k >= 0) {
      em.appendChild(document.createTextNode(t.slice(0, k)));
      var st = document.createElement("strong");
      st.textContent = f;
      em.appendChild(st);
      em.appendChild(document.createTextNode(t.slice(k + f.length)));
    } else {
      em.appendChild(document.createTextNode(t));
    }
    return em;
  }

  function sdCard(w, stacked) {
    var card = document.createElement("div");
    card.className = "sd-card" + (stacked ? " stack" : "");
    if (stacked) { card.setAttribute("aria-hidden", "true"); return card; }
    var h = document.createElement("h2");
    h.className = "sd-word";
    h.textContent = QUIZ.form(w);
    card.appendChild(h);
    var p = document.createElement("p");
    p.className = "sd-phon";
    p.appendChild(document.createTextNode(lang === "ja" ? w.kana : (w.pron || "")));
    var b = document.createElement("b");
    b.textContent = w.pos;
    p.appendChild(b);
    card.appendChild(p);
    var hint = document.createElement("p");
    hint.className = "sd-hint";
    hint.textContent = "点 击 卡 面 · 或 「看 释 义」";
    card.appendChild(hint);
    /* 释义层：默认 rotateY(90deg) 立在侧面，翻面时转到 0（见组件 CSS） */
    var back = document.createElement("div");
    back.className = "sd-back";
    var bh = document.createElement("h3");
    bh.textContent = QUIZ.form(w);
    back.appendChild(bh);
    var mean = document.createElement("p");
    mean.className = "mean";
    mean.textContent = w.meaning_zh;
    back.appendChild(mean);
    var ex = document.createElement("p");
    ex.className = "ex";
    ex.appendChild(exNode(w));
    ex.appendChild(document.createElement("br"));
    ex.appendChild(document.createTextNode(w.example.zh));
    back.appendChild(ex);
    card.appendChild(back);
    return card;
  }

  function renderSD() {
    renderLessonToc(sd, sdLesson, function (les) { sdLesson = les; startDeck(); });
    var stage = slot(sd, "stage"), dots = slot(sd, "dots");
    clear(stage); clear(dots);
    put(sd, "deck", deckLabel());
    if (!sdRound) {
      put(sd, "now", 0);
      put(sd, "total", 0);
      var acts0 = slot(sd, "acts"), sum0 = slot(sd, "summary");
      if (acts0) acts0.style.display = "none";
      if (sum0) sum0.classList.remove("show");
      var empty = document.createElement("p");
      empty.className = "sd-hint";
      empty.style.paddingTop = "96px";
      empty.textContent = "这个词范围里没有词";
      stage.appendChild(empty);
      return;
    }
    var r = sdRound;
    put(sd, "now", Math.min(r.i + 1, r.items.length));
    put(sd, "total", r.items.length);
    r.items.forEach(function (_, k) {
      var d = document.createElement("i");
      if (r.marks[k]) d.className = r.marks[k];
      if (k === r.i) d.classList.add("now");
      dots.appendChild(d);
    });
    /* 卡组厚度：DOM 顺序必须是 [正面, 垫卡1, 垫卡2] —— 组件 CSS 用
       :first-child / :nth-child(2)(3) 定位，:nth-child(n+4) 直接隐藏 */
    stage.appendChild(sdCard(r.items[r.i], false));
    for (var k = r.i + 1; k <= Math.min(r.i + 2, r.items.length - 1); k++) {
      stage.appendChild(sdCard(r.items[k], true));
    }
    stage.firstElementChild.addEventListener("click", flipSD);
  }

  function flipSD() {
    if (!sdRound || sdRound.busy) return;
    var card = slot(sd, "stage").firstElementChild;
    var back = card && card.querySelector(".sd-back");
    if (back) back.classList.toggle("show");
    sfxOf("sfx-flip");
  }

  function sdAdvance(kind) {
    var r = sdRound;
    if (!r || r.busy || r.i >= r.items.length) return;
    r.busy = true;
    r.marks[r.i] = kind;
    if (kind === "hit") r.hit += 1; else r.miss += 1;
    SRS.grade(r.items[r.i].id, kind === "hit" ? 2 : 0);
    /* 「认识」与单词卡片的「记得」是同一档自评，产出也走同一个数（5） */
    if (kind === "hit") { r.earned = (r.earned || 0) + pay(GIVE.flashcard_remember); }
    /* 「认识」→ 积极脸；「不认识」→ 消极脸（键盘 ←→ 也走这里） */
    qcSet("sd", kind === "hit" ? "good" : "bad");
    sfxOf(kind === "hit" ? "sfx-right" : "sfx-wrong");
    var card = slot(sd, "stage").firstElementChild;
    if (card) card.classList.add(kind === "hit" ? "fly-ok" : "fly-miss");
    /* 进度点立刻落定，不等飞牌动画 —— 点击反馈必须是即时的 */
    var d = slot(sd, "dots").children[r.i];
    if (d) d.className = kind;
    setTimeout(function () {
      r.i += 1;
      r.busy = false;
      if (r.i >= r.items.length) sdFinish(); else renderSD();
    }, 430);
  }

  function sdRestart() { startDeck(); }

  function sdFinish() {
    var r = sdRound;
    var acts = slot(sd, "acts"), stage = slot(sd, "stage"), sum = slot(sd, "summary");
    if (acts) acts.style.display = "none";
    if (stage) stage.style.display = "none";
    put(sd, "now", r.items.length);
    put(sd, "hit", r.hit);
    put(sd, "miss", r.miss);
    /* 结算那块的小字原本是英文装饰（DECK COMPLETE），改成本轮真实产出 */
    var foot = sum && sum.querySelector("small");
    if (foot) foot.textContent = "本 轮 货 币 +" + (r.earned || 0);
    if (sum) sum.classList.add("show");
  }

  /* 只在「背单词」真的可见时接管方向键 —— 否则在主画面按左右键会偷偷改卡组进度 */
  document.addEventListener("keydown", function (e) {
    if (tab !== "sd" || !scr.classList.contains("active")) return;
    if (!sdRound || sdRound.busy || sdRound.i >= sdRound.items.length) return;
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flipSD(); }
    else if (e.key === "ArrowLeft") sdAdvance("miss");
    else if (e.key === "ArrowRight") sdAdvance("hit");
  });

  /* ============================================================ 练习 */
  var qz = panels.qz;
  var qzPicked = false;

  function startDrill(ids) {
    var pool = pickByLesson(lang, qzLesson).map(function (w) { return w.id; });
    /* 先打乱再交给 SRS.pick：pick 仍然把「到期的」排在最前，但如果所有词都没练过
       （新存档），不打乱的话每组题永远是词表开头那十个 —— 练十组还是那十个词。 */
    if (!ids || !ids.length) {
      for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
    }
    var queue = ids && ids.length ? ids.slice(0, DRILL_N) : SRS.pick(pool, DRILL_N);
    var items = QUIZ.build(lang, queue, DRILL_N);
    /* 组不出题（词库太小或字段缺失）时不硬撑，直接把原因说清楚 */
    if (!items.length) {
      drill = null;
      put(qz, "title", "题库不足");
      put(qz, "prog", "0 / 0");
      put(qz, "ask", "—");
      put(qz, "prompt", "当前语种的词库还组不出题");
      put(qz, "sub", "");
      clear(slot(qz, "choices"));
      put(qz, "fb", "");
      return;
    }
    /* combo = 当前连对了几题（答错清零）；earned = 本组已经赚到的货币 */
    drill = { items: items, i: 0, right: 0, wrong: 0, combo: 0, earned: 0 };
    comboChipDrop();
    renderQZ();
  }

  function renderQZ() {
    renderLessonToc(qz, qzLesson, function (les) { qzLesson = les; drill = null; startDrill(null); });
    if (!drill) { startDrill(null); return; }
    var it = drill.items[drill.i];
    var box = slot(qz, "choices");
    if (!it) { renderQZSummary(); return; }
    qzPicked = false;
    put(qz, "kicker", (lang === "ja" ? "标 日 初 级 上" : "雅 思 词 汇") + " · " + (KIND_ZH[it.kind] || "练习"));
    /* 标题放难度档而不是原词 —— 题干区已经有大号词形了，重复一遍纯属占地方 */
    put(qz, "title", levelLabel(it.word));
    put(qz, "prog", (drill.i + 1) + " / " + drill.items.length);
    put(qz, "ask", it.ask);
    put(qz, "prompt", it.prompt);
    put(qz, "sub", it.prompt_sub || "");
    var pr = slot(qz, "prompt");
    pr.classList.remove("dr-prompt--click");
    if (it.kind === "listen" && QUIZ.ttsOk()) {
      pr.classList.add("dr-prompt--click");
      pr.onclick = function () { QUIZ.speak(it.word.lemma, lang); };
      QUIZ.speak(it.word.lemma, lang);
    } else {
      pr.onclick = null;
    }
    clear(box);
    it.choices.forEach(function (c, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "dr-choice";
      var k = document.createElement("span");
      k.className = "k";
      k.textContent = "ABCD"[i] || "?";
      b.appendChild(k);
      b.appendChild(document.createTextNode(c.t));
      b.addEventListener("click", function () { answerQZ(i); });
      box.appendChild(b);
    });
    put(qz, "fb", "");
  }

  function answerQZ(i) {
    if (qzPicked || !drill) return;
    qzPicked = true;
    var it = drill.items[drill.i];
    var right = QUIZ.answerIndex(it);
    var ok = i === right;
    [].slice.call(slot(qz, "choices").children).forEach(function (b, k) {
      b.disabled = true;
      if (k === right) b.classList.add("ok");
      else if (k === i) b.classList.add("bad");
    });
    var gained = 0, bonus = 0;
    if (ok) {
      /* 「到期复习词」答对给 8、其他练习给 2 —— 想多赚就得多复习，赚钱节奏跟记忆周期绑在一起。
         必须在 grade 之前问 isDue：grade 会把 due 推到下一次，问晚了永远是「不是到期词」。 */
      var due = SRS.isDue(it.word.id);
      drill.right += 1;
      drill.combo += 1;
      SRS.grade(it.word.id, 2);
      bonus = drill.combo >= 3 ? GIVE.combo_bonus_per_item : 0;
      gained = (due ? GIVE.quiz_correct_srs : GIVE.quiz_correct_practice) + bonus;
      drill.earned += pay(gained);
    } else {
      drill.wrong += 1;
      drill.combo = 0;
      /* 答错零惩罚（硬规则）：不扣任何数值，只记进错题集，负面情绪交给墨墨的台词 */
      SRS.grade(it.word.id, 0);
      addWrong(it.word, it.kind,
               it.choices[i] ? it.choices[i].t : "",
               it.choices[right] ? it.choices[right].t : "");
    }
    /* 「当天准确率」的分子分母由 daily.js 管（日结算时要按它算 90% 的奖励） */
    if (window.MomoDaily) window.MomoDaily.noteQuiz(ok);

    /* ---- 表现层：Q 版换脸 + 音效 + 连击徽章（判分与产出在上面已经算完） ---- */
    if (ok) {
      qcSet("qz", "good");
      sfxOf("sfx-right");
      if (drill.combo >= 2) comboChip(drill.combo);
      if (drill.combo === 3 || drill.combo === 6) {
        sfxOf("sfx-combo");
        voPick(Math.random() < 0.5 ? "vo-combo-" : "vo-right-");
      }
    } else {
      qcSet("qz", "bad");
      sfxOf("sfx-wrong");
      comboChipDrop();
      /* 毒舌语音偶尔来一句，每题都说会烦 */
      if (Math.random() < 0.3) voPick("vo-wrong-");
    }

    var fb = slot(qz, "fb");
    clear(fb);
    fb.appendChild(document.createTextNode(ok ? "✓ 答对了　" : "✗ 答错了　"));
    var b1 = document.createElement("b");
    b1.textContent = QUIZ.form(it.word);
    fb.appendChild(b1);
    fb.appendChild(document.createTextNode(
      "　" + it.word.pos + " " + it.word.meaning_zh + "　｜　" + it.word.example.t +
      (ok ? "　　＋" + gained + " 金" + (bonus ? "（连对 " + drill.combo + "）" : "") : "")));
    /* 她的当场点评：一行小字缀在解析后面 */
    var line = taunt(ok ? "right" : "wrong");
    if (line) {
      var tq = document.createElement("span");
      tq.className = "dr-taunt";
      tq.textContent = "　墨墨：" + line;
      fb.appendChild(tq);
    }
  }

  function renderQZSummary() {
    clear(slot(qz, "choices"));
    comboChipDrop();
    put(qz, "kicker", "本 组 结 束");
    put(qz, "title", "答题结果");
    put(qz, "prog", drill.right + " / " + drill.items.length);
    put(qz, "ask", "—");
    var perfect = !drill.wrong;
    put(qz, "prompt", "答对 " + drill.right + " 题 · 答错 " + drill.wrong + " 题");
    put(qz, "sub", "本 组 货 币 +" + drill.earned +
                   (drill.wrong ? "　·　错题已收进「错题集」"
                                : "　·　" + (taunt("perfect") || "全对")));
    if (perfect) {
      sfxOf("sfx-perfect");
      voPick("vo-perfect-");
    } else {
      sfxOf("sfx-settle");
    }
    var fb = slot(qz, "fb");
    clear(fb);
    fb.appendChild(document.createTextNode("练习已写入记忆调度：答对的词会拉长复习间隔，答错的词今天就重来。"));
  }

  function nextQZ() {
    if (!drill) return;
    if (drill.i + 1 >= drill.items.length) { drill.i = drill.items.length; renderQZSummary(); return; }
    drill.i += 1;
    renderQZ();
  }

  /* ============================================================ 面板 / 语种切换 */
  function showTab(key) {
    if (SUBTABS.map(function (t) { return t.key; }).indexOf(key) < 0) key = SUBTABS[0].key;
    tab = key;
    SUBTABS.forEach(function (t) {
      panels[t.key].classList.toggle("on", t.key === key);
    });
    [].slice.call(tabsBox.children).forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-learn") === key);
    });
  }

  function renderTab(key) {
    if (key === "wc") renderWC();
    else if (key === "nb") renderNB();
    else if (key === "gr") renderGr();
    else if (key === "mk") renderMK();
    else if (key === "sd") { if (!sdRound) startDeck(); else renderSD(); }
    else if (key === "qz") { if (!drill) startDrill(null); else renderQZ(); }
  }

  function showLang(key) {
    lang = key === "ja" ? "ja" : "en";
    learn().lang = lang;
    STORE.save();
    drill = null;
    grPointId = null;
    /* 课次、卡组都是分语种的：切语种必须归零，否则会拿日语的课次去筛英语词表 */
    sdLesson = 0;
    qzLesson = 0;
    sdRound = null;
    var sdActs = slot(sd, "acts"), sdStage = slot(sd, "stage");
    if (sdActs) sdActs.style.display = "";
    if (sdStage) sdStage.style.display = "";
    [].slice.call(langsBox.children).forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-lang") === lang);
    });
    renderTab(tab);
  }

  function build() {
    qcInit();
    tabsBox.innerHTML = SUBTABS.map(function (t) {
      return '<div class="learn-tab" data-learn="' + t.key + '">' + t.name + "</div>";
    }).join("");
    [].slice.call(tabsBox.children).forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var k = b.getAttribute("data-learn");
        showTab(k);
        renderTab(k);
      });
    });
    [].slice.call(langsBox.children).forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        showLang(b.getAttribute("data-lang"));
      });
    });

    /* 卡片：点空白处翻面（点按钮不翻） */
    flipWrap.addEventListener("click", function (e) {
      if (e.target.closest("button")) return;
      flipWrap.classList.toggle("flipped");
      sfxOf("sfx-flip");
    });
    starBtn.addEventListener("click", toggleStar);
    collectBtn.addEventListener("click", toggleStar);
    [].slice.call(wc.querySelectorAll("[data-nav]")).forEach(function (b) {
      b.addEventListener("click", function () {
        stepWC(b.getAttribute("data-nav") === "next" ? 1 : -1);
      });
    });
    [].slice.call(wc.querySelectorAll("[data-grade]")).forEach(function (b) {
      b.addEventListener("click", function () {
        var list = words(lang);
        var w = list[wcIdx[lang]];
        if (!w) return;
        var g = +b.getAttribute("data-grade");
        SRS.grade(w.id, g);
        /* 自评产出：记得 5 / 模糊 1 / 忘了 0 —— 诚实给奖励，但不鼓励装懂；
           答错（忘了）仍然零惩罚，负面表达交给墨墨的台词。 */
        if (g === 2) pay(GIVE.flashcard_remember);
        else if (g === 1) pay(GIVE.flashcard_fuzzy);
        sfxOf(g === 2 ? "sfx-right" : g === 1 ? "sfx-flip" : "sfx-wrong");
        /* 「记得」= 2 → 积极脸；「忘了 / 模糊」= 0 / 1 → 消极脸 */
        qcSet("wc", g === 2 ? "good" : "bad");
        /* 自评完立刻翻到下一个词：自评的语义就是「过一遍」，卡片直接换掉本身就是
           反馈（翻面状态也会重置）。原来的做法是延时 260ms 才换，手感是滞后的。 */
        stepWC(1);
      });
    });
    [].slice.call(nb.querySelectorAll(".nb-tab")).forEach(function (t) {
      t.addEventListener("click", function () {
        nbFilter = t.getAttribute("data-filter");
        renderNB();
      });
    });
    [].slice.call(sd.querySelectorAll("[data-act]")).forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var act = b.getAttribute("data-act");
        if (act === "hit") sdAdvance("hit");
        else if (act === "miss") sdAdvance("miss");
        else if (act === "flip") flipSD();
        else sdRestart();
      });
    });
    [].slice.call(qz.querySelectorAll("[data-act]")).forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.getAttribute("data-act") === "next") nextQZ();
        else startDrill(null);
      });
    });
    /* 货币读数挂在 .stage 上（不是 .learn-tabs 里）：标签栏那套代码会遍历它的子元素
       绑点击、判高亮，塞进去会被当成第七个标签。 */
    buildMoney();
    return true;
  }

  function onShow(e) {
    if (!e.detail || e.detail.screen !== "学习界面") return;
    if (!tabsBox.children.length && !build()) return;
    [].slice.call(langsBox.children).forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-lang") === lang);
    });
    showTab(tab);
    renderTab(tab);
  }
  document.addEventListener("momo:show", onShow);
  if (scr.classList.contains("active")) onShow({ detail: { screen: "学习界面" } });

  window.MomoLearn = {
    /* 当前这道题的正确答案下标（-1 = 没在答题）。只读，供自动化验证判对错用。 */
    answer: function () {
      return drill && drill.items[drill.i] ? QUIZ.answerIndex(drill.items[drill.i]) : -1;
    },
    /* 供自动化验证用；只读，不改状态 */
    state: function () {
      var L = learn();
      var wl = words(lang);
      var G = grammar(lang);
      var cur = panels[tab];
      /* 卡片显示的是「检索筛过」的那一份 —— 取词要跟屏幕一致 */
      var wcList = wcPool();
      var w = wcList[wcIdx[lang]] || null;
      return {
        lang: lang,
        tab: tab,
        panels: Object.keys(panels).length,
        /* Q 版陪读小人：当前显示的是哪张脸（data-qc-file），供断言核对 */
        qc: (function () {
          var o = {};
          Object.keys(qcEls).forEach(function (k) {
            o[k] = {
              file: qcEls[k].dataset.qcFile || "",
              has: !!qcEls[k].style.backgroundImage,
              w: Math.round(qcEls[k].getBoundingClientRect().width),
              h: Math.round(qcEls[k].getBoundingClientRect().height)
            };
          });
          return o;
        })(),
        visible: SUBTABS.filter(function (t) { return panels[t.key].offsetParent !== null; }).length,
        tabs: [].slice.call(tabsBox.children).map(function (b) {
          return { key: b.getAttribute("data-learn"), on: b.classList.contains("on") };
        }),
        langs: [].slice.call(langsBox.children).map(function (b) {
          return { key: b.getAttribute("data-lang"), on: b.classList.contains("on") };
        }),
        counts: {
          en: (DATA.words_en || []).length,
          ja: (DATA.words_ja || []).length,
          grammar_en: (DATA.grammar_en || { points: [] }).points.length,
          grammar_ja: (DATA.grammar_ja || { points: [] }).points.length
        },
        /* 词表是该语种真的词，不是任何写死的样例 */
        wcWord: (function () { return slot(wc, "word").textContent; })(),
        wcExpect: w ? QUIZ.form(w) : "",
        wcId: w ? w.id : "",
        wcLevel: slot(wc, "level").textContent,
        wcCounter: wc.querySelector(".wc-pos").textContent,
        /* 词库检索面板：当前选中项、筛后条数、索引按钮数 */
        wcScope: lang === "ja" ? wcScope.ja : wcScope.en,
        wcShown: wcList.length,
        wcTocButtons: wc.querySelectorAll(".gr-toc button").length,
        wcTocVisible: !wc.querySelector(".gr-toc").hidden,
        /* 记词本的三个数字与 SRS 统计必须一致 */
        nb: (function () {
          var st = SRS.stats(wl.map(function (x) { return x.id; }));
          return {
            stat: [+slot(nb, "all").textContent, +slot(nb, "done").textContent, +slot(nb, "wait").textContent],
            srs: [st.total, st.done, st.wait],
            rows: slot(nb, "list").querySelectorAll(".nb-item").length,
            filter: nbFilter,
            seals: [].slice.call(slot(nb, "list").querySelectorAll(".nb-seal")).map(function (e) { return e.textContent; })
          };
        })(),
        gr: {
          tocButtons: gr.querySelectorAll(".gr-toc button").length,
          tocChapters: gr.querySelectorAll(".gr-toc h4").length,
          points: G ? G.points.length : 0,
          chapters: G ? (G.chapters || []).length : 0,
          title: slot(gr, "title").textContent,
          examples: gr.querySelectorAll(".gr-ex-item").length,
          onCount: gr.querySelectorAll(".gr-toc button.on").length
        },
        mk: {
          stored: (L.wrong && L.wrong[lang] ? L.wrong[lang].length : 0),
          rendered: slot(mk, "list").querySelectorAll(".mk-item[data-word]").length,
          count: +slot(mk, "count").textContent
        },
        qz: {
          running: !!drill,
          total: drill ? drill.items.length : 0,
          index: drill ? drill.i : 0,
          right: drill ? drill.right : 0,
          wrong: drill ? drill.wrong : 0,
          kind: drill && drill.items[drill.i] ? drill.items[drill.i].kind : "",
          kinds: drill ? drill.items.map(function (x) { return x.kind; }) : [],
          choices: qz.querySelectorAll(".dr-choice").length,
          prompt: slot(qz, "prompt").textContent,
          earned: drill ? drill.earned : 0,
          combo: drill ? drill.combo : 0,
          fb: slot(qz, "fb").textContent
        },
        /* 学习产出：货币读数与本轮收入。经济系统的断言都从这里对 */
        money: {
          shown: moneyNum ? moneyNum.textContent : "",
          stored: Math.round(STORE.state.currency || 0),
          gain: moneyGain ? moneyGain.textContent : ""
        },
        /* 背单词：卡组是真词，进度点与结算数字都来自本轮真实点击 */
        sd: {
          running: !!sdRound,
          total: sdRound ? sdRound.items.length : 0,
          index: sdRound ? sdRound.i : 0,
          hit: sdRound ? sdRound.hit : 0,
          miss: sdRound ? sdRound.miss : 0,
          marks: sdRound ? sdRound.marks.slice(0, sdRound.items.length) : [],
          deck: slot(sd, "deck").textContent,
          cards: sd.querySelectorAll(".sd-stage .sd-card").length,
          stacks: sd.querySelectorAll(".sd-stage .sd-card.stack").length,
          dots: sd.querySelectorAll(".sd-dots i").length,
          dotsNow: sd.querySelectorAll(".sd-dots i.now").length,
          dotsHit: sd.querySelectorAll(".sd-dots i.hit").length,
          dotsMiss: sd.querySelectorAll(".sd-dots i.miss").length,
          revealed: !!sd.querySelector(".sd-stage .sd-back.show"),
          summaryShown: !!sd.querySelector(".sd-summary.show"),
          actsShown: (function () {
            var a = slot(sd, "acts");
            return !!a && a.style.display !== "none";
          })(),
          word: (function () {
            var c = sd.querySelector(".sd-stage .sd-card:not(.stack) .sd-word");
            return c ? c.textContent : "";
          })(),
          sumHit: +slot(sd, "hit").textContent,
          sumMiss: +slot(sd, "miss").textContent,
          earned: sdRound ? (sdRound.earned || 0) : 0
        },
        sdExpect: sdRound && sdRound.items[sdRound.i] ? QUIZ.form(sdRound.items[sdRound.i]) : "",
        sdId: sdRound && sdRound.items[sdRound.i] ? sdRound.items[sdRound.i].id : "",
        /* 课次选择器：只有日语下才出现 */
        lessons: {
          sd: { visible: !slot(sd, "toc").hidden, selected: sdLesson,
                buttons: sd.querySelectorAll(".gr-toc [data-lesson]").length,
                on: sd.querySelectorAll(".gr-toc [data-lesson].on").length },
          qz: { visible: !slot(qz, "toc").hidden, selected: qzLesson,
                buttons: qz.querySelectorAll(".gr-toc [data-lesson]").length,
                on: qz.querySelectorAll(".gr-toc [data-lesson].on").length }
        },
        starred: (L.starred && L.starred[lang] ? L.starred[lang].length : 0),
        learnedCount: Object.keys(L.learned || {}).length,
        /* 命中测试：当前面板中心的元素必须是它自己那一块 */
        hitOk: (function () {
          var box = cur && cur.querySelector(".panel");
          if (!box) return false;
          var b = box.getBoundingClientRect();
          var t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return !!t && (t === box || box.contains(t));
        })()
      };
    }
  };
})();