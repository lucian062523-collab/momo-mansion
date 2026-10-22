/* 墨墨 · 主线章节事件 —— S1C1《月见茶会》（party.js）
   心之桥八灯的第一盏。三幕结构：

     幕一（剧本） ch1_入席 —— director 播；NPC 立绘与表情由本文件的 stage()/expr() 接管，
                   姓名条由 director 的 say.who=NPC 出（数据在 dialogues.json「脚本」桶）
     幕二（对局） 茶礼制式状态机 —— 本文件在主画面叠一层桌视图跑完：
                   夜（刀/照镜/药茶）→ 昼（双镜对峙 · 发言卡 · 请离席）×2 → 终局递茶
     幕三（剧本） ch1_结A/B/C —— director 播，收在题眼问答与点灯，then:party:finish 落灯发奖

   ⚠ 2026-10-12：作者指出茶会剧情尚未定稿（「茶会的剧情我还没写呢，现在的不对」），
   要求删掉剧情与入口、只留引擎与素材。所以现在的状态是 ——
     · 幕一/幕三的四段剧本（ch1_入席 / ch1_结A/B/C）已从 dialogues.json 删除，
       chapters.json 的 ch1 条目也清空；
     · 本文件因此走下面第 27 行的静默休眠（CH 取不到就整个模块不导出），
       上面「入口三条」与各幕剧本全部处于停用状态；
     · 对局数据 party_月见茶会.json、NPC 立绘、本引擎都原样留着，等着接回来。
   完整旧版：backups/茶会删除-20261012-1345/（dialogues.json / chapters.json / party.js）。

   下面是**接回时**要恢复的入口设计（三条，都在主画面判定）：
     ① 门槛达成（好感 Lv3 × 陪伴 7 天）→ 派「月见的请柬」（一次性，改天可后补）
     ② 接了请柬（bridge.going）→ 下次回主画面直接开席
     ③ 之后从地图走进茶歇间 → 直接开席

   三条设计死规矩（与设计稿 §0 一致）：
     1. 线索即人设 —— NPC 的发言、票、刀全部由 party_月见茶会.json 的执念权重驱动，
        没有一条「为机制服务的假逻辑」；三把刀被执念锁死就是 3狐5客 的平衡本身。
     2. 全分支点灯 —— 胜负、离席与否都不影响 bridge.lit 的落定：灯量的是她敢不敢。
     3. 灯不随死亡熄灭 —— 只写 store.bridge（revive 不碰它），与 §8 周目原则同构。 */
(function () {
  "use strict";
  var CHD = (window.MOMO_DATA || {}).chapters || {};
  var CH = null;
  (CHD.chapters || []).forEach(function (c) { if (c.id === "ch1") CH = c; });
  var PT = (window.MOMO_DATA || {})["party_月见茶会"] || {};
  var STORE = window.MomoStore;
  /* CH（chapters.json 的 ch1）允许为空：茶会章节已按作者要求摘除，
     但本文件还留着《前言》的入口（前言是作者的剧本，正文就是「七天纪念日」，
     不能因为茶会没了就没人演）。章节数据缺失只让茶会那部分静默。 */
  if (!STORE || !PT.chars) return;   /* 源码直开没有 MOMO_DATA：本模块静默休眠 */

  var U = window.ASSET_URI || {};
  function uri(p) { return U[p] || p; }
  function rnd(n) { return Math.floor(Math.random() * n); }
  function pick(list) { return (list && list.length) ? list[rnd(list.length)] : null; }
  function shuffled(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = rnd(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function sfx(n) { if (window.MomoAudio) MomoAudio.sfx(n); }

  /* ---------------- 立绘注册表 ---------------- */
  function charOf(name) { return PT.chars[name] || null; }
  function label(name) {
    var c = charOf(name);
    return (c && c.label) || name;
  }
  function charFile(name, expr) {
    var c = charOf(name);
    if (!c) return null;
    var ex = c.exprs || {};
    var want = expr || "默认";
    return ex[want] || c.default || ex["默认"] || null;
  }
  function npcUrl(name, expr) {
    var f = charFile(name, expr);
    return f ? uri(f) : "";
  }
  /* 桌视图里墨墨的小像：用她当前穿着的套装默认图（读 wardrobe 数据，不碰 wardrobe.js 内部） */
  function momoUrl() {
    var W = (window.MOMO_DATA || {}).wardrobe || {};
    var worn = (STORE.state.wardrobe || {}).worn, s = null;
    (W.sets || []).forEach(function (x) { if (x.id === worn) s = x; });
    if (!s && W.sets && W.sets.length) s = W.sets[0];
    return s ? uri(s.img) : "";
  }

  /* ---------------- 门槛与 flag ---------------- */
  function gatesMet() {
    var g = CH.gates || {};
    var L = (window.MOMO_DATA || {}).lessons || {};
    var levels = (((L.economy || {}).affection || {}).levels) ||
                 [0, 20, 50, 100, 160, 240, 340, 460, 600, 760];
    var a = STORE.state.affection || 0, lv = 0;
    for (var i = 0; i < levels.length; i++) if (a >= levels[i]) lv = i + 1;
    if (lv < (g.affection_lv || 3)) return false;
    var days = (window.MomoDaily && MomoDaily.state) ? (MomoDaily.state().total_days || 0) : 0;
    return days >= (g.days_total || 7);
  }
  function bridge() {
    var st = STORE.state;
    if (!st.bridge || typeof st.bridge !== "object") st.bridge = { lit: 0 };
    return st.bridge;
  }
  /* 等剧本演完再动手（daily.js 同款）：开场 / 邀请 / 切场景四拍都可能正在演 */
  function whenIdle(fn, tries) {
    tries = tries || 0;
    if (window.MomoDirector && MomoDirector.isPlaying() && tries < 90) {
      setTimeout(function () { whenIdle(fn, tries + 1); }, 1000);
      return;
    }
    fn();
  }

  /* ---------------- 幕一/幕三 · NPC 舞台（主画面立绘层） ----------------
     动态插层（同 idle.js 的 spark-layer 先例）：插在墨墨立绘**前面**，
     她压在最前，客人们在身后围一圈。点位在 party json 的 stage_slots。 */
  var stg = null;
  function stageRoot() { return document.querySelector('[data-screen="主画面"] .stage'); }
  function stageLayer() {
    var root = stageRoot();
    if (!root) return null;
    if (stg && stg.parentNode) return stg;
    stg = root.querySelector(".party-stage");
    if (!stg) {
      stg = document.createElement("div");
      stg.className = "party-stage";
      var momo = root.querySelector("[data-costume]");
      if (momo) root.insertBefore(stg, momo); else root.appendChild(stg);
    }
    return stg;
  }
  function paintNpc(el, name, expr) {
    var url = npcUrl(name, expr);
    el.style.backgroundImage = url ? 'url("' + url + '")' : "none";
  }
  function stageClear() {
    if (stg && stg.parentNode) stg.parentNode.removeChild(stg);
    stg = null;
  }
  /* 临时摆位覆盖：作者用 ?edit=1 的修改器把每个 NPC 的
     { cx, top, w }（相对舞台宽高的比例）存进 localStorage；
     正式包没存就完全走头锚默认值，不受影响。 */
  function soloOverrides() {
    try { return JSON.parse(localStorage.getItem("momo.npc.solo.v1") || "{}") || {}; }
    catch (e) { return {}; }
  }
  /* 作者用 ?edit=1 修改器摆好的默认坐标（相对舞台宽高：cx=中心、top=顶边、w=宽度）。
     正式包就以这些为默认；作者浏览器里 localStorage 里的修改仍会临时覆盖。 */
  var DEFAULT_SOLO_POS = {
    "月见": { cx: 0.4902302924558423, top: 0.010127315257992618, w: 0.4206379961875237 },
    "千春": { cx: 0.5074849312760045, top: 0.04767071617442362, w: 0.4353963081733903 },
    "池田": { cx: 0.4959492869656076, top: -0.0013527198597657936, w: 0.5165730548590981 },
    "茶终": { cx: 0.5057718929205213, top: 0.02504340378822317, w: 0.5165730979359798 },
    "樱井": { cx: 0.5086262963341401, top: 0.0258029521334276, w: 0.4575358007656313 },
    "小野": { cx: 0.4852416664756925, top: 0.0031105323298512917, w: 0.4944335191899754 },
    "幸子": { cx: 0.49357504001411545, top: 0.02153501187543498, w: 0.5239502293154722 }
  };
  /* director 的 stage 节点入口：{who} 进场、{who, exit:true} 退场、{clear:true} 清台 */
  function stage(n) {
    n = n || {};
    var root = stageLayer();
    if (!root) return;
    if (n.clear) {
      stageClear();
      var mm0 = stageRoot() && stageRoot().querySelector('[data-costume]');
      if (mm0) mm0.classList.remove('sprite-out');
      return;
    }
    if (!n.who || !charOf(n.who)) return;
    /* 单人对话：一次只放当前说话人，尺寸与墨墨同级，居中；主立绘临时淡出。
       （2026-10-21 作者：人物大小要和墨墨同级，且不要挤进同屏） */
    if (n.solo) {
      var ex = root.querySelector('.party-npc.solo');
      if (ex && ex.getAttribute('data-npc') === n.who) { paintNpc(ex, n.who, n.expr); return; }
      stageClear();
      root = stageLayer();
      if (!root) return;
      var mm = stageRoot() && stageRoot().querySelector('[data-costume]');
      if (mm) mm.classList.add('sprite-out');
      var solo = document.createElement("div");
      solo.className = "party-npc solo";
      solo.setAttribute("data-npc", n.who);
      var url = npcUrl(n.who, n.expr || "默认");
      if (!url) return;
      /* 以墨墨的「头顶位置 + 头宽」为锚：同一屏 1:1 对齐，
         每个 NPC 用自身 alpha 估算的头宽比例反推缩放，避免大头/小头。 */
      var R = { "千春": .4385, "池田": .3115, "茶终": .2939, "樱井": .3057,
                "小野": .3486, "幸子": .2988, "月见": .4177 };
      var TOPR = { "月见": .0090 };
      var ASPECT = { "月见": 936/1550 };
      /* 舞台可能被 CSS transform 缩放（浏览器窗口不是 1920×1080 时）：
         getBoundingClientRect 是缩放后的视觉尺寸，而 left/top/width 要用
         舞台内部未缩放的布局坐标。否则非 1080p 窗口里人物会整体偏左/偏小。 */
      var stageEl = stageRoot();
      var layoutW = (stageEl && stageEl.clientWidth) || 1920;
      var layoutH = (stageEl && stageEl.clientHeight) || 1080;
      var refW = mm ? (mm.offsetWidth || layoutW * .5) : layoutW * .5;
      var ratio = R[n.who] || .5918;
      var w = refW * (.3604 / ratio) * .95;
      var asp = ASPECT[n.who] || (1024/1536);
      var h = w / asp;
      solo.style.position = "absolute";
      solo.style.width = w + "px";
      solo.style.height = "auto";
      solo.style.left = ((mm ? mm.offsetLeft + mm.offsetWidth / 2 : layoutW / 2) - w / 2) + "px";
      solo.style.top = ((mm ? mm.offsetTop : 0) - (TOPR[n.who] || 0) * h) + "px";
      solo.style.bottom = "auto";
      solo.style.maxWidth = "none";
      /* 正式入口只认 bake 进包的 DEFAULT_SOLO_POS；
         localStorage 草稿只在 ?edit=1 的修改器里生效，
         避免作者浏览器里旧的草稿把正式包位置带歪。 */
      var isEditing = /(?:^|[?&])edit=1(?:&|$)/.test(location.search);
      var ov = (isEditing ? soloOverrides()[n.who] : null) || DEFAULT_SOLO_POS[n.who];
      if (ov && ov.w) {
        w = ov.w * layoutW;
        solo.style.width = w + "px";
        solo.style.left = ((ov.cx !== undefined ? ov.cx : .5) * layoutW - w / 2) + "px";
        if (ov.top !== undefined) solo.style.top = (ov.top * layoutH) + "px";
      }
      var img = document.createElement("img");
      img.src = url; img.alt = ""; img.style.cssText = "display:block;width:100%;height:auto;pointer-events:none";
      solo.appendChild(img);
      root.appendChild(solo);
      return;
    }
    var el = root.querySelector('[data-npc="' + n.who + '"]');
    if (n.exit) { if (el) el.parentNode.removeChild(el); return; }
    if (!el) {
      el = document.createElement("div");
      el.className = "party-npc";
      el.setAttribute("data-npc", n.who);
      var slot = (PT.stage_slots || {})[n.who] || { left: 50, bottom: 0, width: 18 };
      el.style.left = slot.left + "%";
      el.style.bottom = slot.bottom + "%";
      el.style.width = slot.width + "%";
      root.appendChild(el);
    }
    paintNpc(el, n.who, n.expr);
  }
  /* director 的 say.who=NPC 时换表情入口 */
  function expr(name, e) {
    var root = stageLayer();
    if (!root) return;
    var el = root.querySelector('[data-npc="' + name + '"]');
    if (el) paintNpc(el, name, e || "默认");
  }

  /* ---------------- 请柬（门槛达成的第一次） ---------------- */
  function inviteNodes() {
    var iv = PT.invite || {}, lines = iv.lines || [], nodes = [];
    (iv.narr || []).forEach(function (t) { nodes.push({ type: "narration", text: t }); });
    if (lines[0]) nodes.push({ type: "narration", text: lines[0].text });   /* 信的内容 */
    lines.slice(1).forEach(function (l) {
      nodes.push(l.type === "say" ? { type: "say", text: l.text, expr: l.expr }
                                  : { type: "narration", text: l.text });
    });
    nodes.push({
      type: "choice",
      options: [
        { label: (iv.options || {}).go || "去看看", say: iv.go_say || "……那就，去看看。",
          then: [ { type: "set", path: "bridge.invite_seen", value: true },
                  { type: "set", path: "bridge.going", value: true } ] },
        { label: (iv.options || {}).later || "改天再说", say: iv.later_say || "算了吧，改天。",
          then: [ { type: "set", path: "bridge.invite_seen", value: true },
                  { type: "narration", text: iv.later_note || "" } ] }
      ]
    });
    nodes.push({ type: "end" });
    return nodes;
  }

  /* ---------------- 开席 ---------------- */
  function enter() {
    var st = STORE.state;
    st.floor = (CH.scene || {}).floor || "F3";
    st.room = (CH.scene || {}).room || "茶歇间";
    STORE.save();
    /* 立即重绘：store.save() 不派 momo:store（只有 apply/earn/spend/load 派），
       不主动刷会停在旧房间、要等 scene.js 的 30s 兜底轮询 */
    if (window.MomoScene && MomoScene.refresh) MomoScene.refresh();
    stageClear();
    if (!(window.MomoDirector && MomoDirector.play(CH.open_script))) begin();  /* 剧本缺失时直进对局兜底 */
  }

  /* ================================================================ 幕二 · 对局 */

  var RULES = PT.rules || {};
  /* 席位键统一用「玩家」——seats.order 里写的「你」只是桌面上的摆法（显示层） */
  var PLAYERS = (((PT.seats && PT.seats.order) ||
                  ["千春", "池田", "茶终", "你", "墨墨", "樱井", "小野", "幸子"]))
                 .map(function (n) { return n === "你" ? "玩家" : n; });
  var CARDS = PT.cards || {};
  var HOST = RULES.host || "月见";
  var active = false;
  var G = null;                 /* 对局状态 */
  var lastOutcome = "B";

  var ui = null, seatEls = {}, bubble = null, bName = null, bText = null,
      actions = null, hintEl = null, shade = null, dim = null, floatsEl = null;

  function isFox(n) { return (RULES.foxes || []).indexOf(n) >= 0; }
  function aliveList() {
    var out = [];
    PLAYERS.forEach(function (n) { if (G.alive[n]) out.push(n); });
    return out;
  }
  function aliveFoxes() { return aliveList().filter(isFox).length; }
  function aliveGuests() { return aliveList().length - aliveFoxes(); }
  function hostSay(key, name) {
    var t = ((PT.pools || {})[HOST] || {})[key] || "";
    if (!t) return;
    say(HOST, t.replace("__", name || ""), null);
  }
  function poolLine(name, bucket) {
    var P = (PT.pools || {})[name] || {};
    var v = P[bucket];
    if (!v) return null;
    if (Array.isArray(v)) {
      var s = pick(v);
      return s ? { text: s.text, expr: s.expr } : null;
    }
    return { text: v.text, expr: v.expr, vo: v.vo };
  }
  function say(who, text, e, vo) { G.queue.push({ who: who, text: text, expr: e || null, vo: vo || null }); }
  function sayLine(name, bucket) {
    var l = poolLine(name, bucket);
    if (l) say(name, l.text, l.expr, l.vo);
  }
  function playerLangLine(card) {
    var lang = ((STORE.state.learn || {}).lang === "ja") ? "ja" : "en";
    var s = CARDS[card] || {};
    var t = s.zh || "";
    if (s[lang]) t += "\n" + s[lang];
    return t;
  }

  /* ---------- 桌视图 DOM ---------- */
  function buildOverlay() {
    var root = stageRoot();
    if (!root) return false;
    ui = document.createElement("div");
    ui.className = "party-ui";

    shade = document.createElement("div");
    shade.className = "party-shade";
    ui.appendChild(shade);

    dim = document.createElement("div");
    dim.className = "party-dim";
    ui.appendChild(dim);

    hintEl = document.createElement("div");
    hintEl.className = "party-hint";
    ui.appendChild(hintEl);

    var seats = document.createElement("div");
    seats.className = "party-seats";
    (PT.seats && PT.seats.order ? PT.seats.order : PLAYERS).forEach(function (name) {
      var key = name === "你" ? "玩家" : name;     /* 席位键统一用「玩家」：与 PLAYERS/存活表同一命名 */
      var d = document.createElement("div");
      d.className = "party-seat" + (name === "你" ? " you" : "");
      d.setAttribute("data-seat", key);
      if (name === "你") {
        d.innerHTML = '<div class="ps-face ps-you-face">你</div>';
      } else {
        var url = name === "墨墨" ? momoUrl() : npcUrl(name, "默认");
        var f = document.createElement("div");
        f.className = "ps-face";
        f.style.backgroundImage = url ? 'url("' + url + '")' : "none";
        d.appendChild(f);
      }
      var l = document.createElement("div");
      l.className = "ps-name";
      l.textContent = name === "墨墨" ? "墨 墨"
                    : (name === "你" ? (window.MomoName ? MomoName.fill("{{name}}") : "你")
                                     : label(name));
      d.appendChild(l);
      seatEls[key] = d;
      seats.appendChild(d);
    });
    ui.appendChild(seats);

    bubble = document.createElement("div");
    bubble.className = "party-bubble is-hidden";
    bName = document.createElement("div");
    bName.className = "p-name";
    bText = document.createElement("div");
    bText.className = "p-text";
    bubble.appendChild(bName);
    bubble.appendChild(bText);
    ui.appendChild(bubble);

    floatsEl = document.createElement("div");
    floatsEl.className = "party-floats";
    ui.appendChild(floatsEl);
    buildFloats();

    actions = document.createElement("div");
    actions.className = "party-actions";
    ["probe", "accuse", "watch", "back"].forEach(function (k) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "party-card";
      b.setAttribute("data-card", k);
      b.textContent = (CARDS[k] || {}).label || k;
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        chooseCard(k);
      });
      actions.appendChild(b);
    });
    actions.style.display = "none";
    ui.appendChild(actions);

    ui.addEventListener("click", function (e) {
      if (!G) return;
      if (G.mode === "speech") { advance(); return; }
      var seat = e.target.closest ? e.target.closest(".party-seat") : null;
      if (seat) { pickSeat(seat.getAttribute("data-seat")); return; }
    });
    root.appendChild(ui);            /* 最后一个孩子 = 盖过对话框与导航 */
    return true;
  }

  /* 词包浮标：按 tags.s1c1 从真实词库抽，点一下念出并看释义——读茶会也是在背词 */
  function buildFloats() {
    if (!floatsEl) return;
    var lang = ((STORE.state.learn || {}).lang === "ja") ? "ja" : "en";
    var pool = (window.MOMO_DATA || {})[lang === "ja" ? "words_ja" : "words_en"] || [];
    var words = shuffled(pool.filter(function (w) { return (w.tags || []).indexOf("s1c1") >= 0; }))
                 .slice(0, ((PT.floats || {}).count) || 4);
    var POS = [[14, 16], [78, 12], [10, 54], [82, 50]];
    words.forEach(function (w, i) {
      var c = document.createElement("button");
      c.type = "button";
      c.className = "p-float";
      c.style.left = POS[i][0] + "%";
      c.style.top = POS[i][1] + "%";
      c.textContent = lang === "ja" ? (w.kanji || w.kana || w.lemma) : w.lemma;
      c.addEventListener("click", function (e) {
        e.stopPropagation();
        sfx("sfx-click");
        if (window.MomoQuiz && MomoQuiz.ttsOk && MomoQuiz.ttsOk()) MomoQuiz.speak(w.kana || w.lemma, lang);
        showBubble("", (lang === "ja" ? (c.textContent + "（" + (w.kana || "") + "）") : c.textContent) +
                        " — " + (w.meaning_zh || ""), true);
      });
      floatsEl.appendChild(c);
    });
  }

  function showBubble(who, text, silent) {
    if (!bubble) return;
    bName.textContent = who === "玩家" ? (window.MomoName ? MomoName.fill("{{name}}") : "你")
                      : who === "墨墨" ? "墨 墨"
                      : who === HOST ? label(HOST)
                      : who ? label(who) : "茶会的角落";
    bText.textContent = window.MomoName ? MomoName.fill(text) : text;
    bubble.classList.remove("is-hidden");
    if (who && seatEls[who]) {
      Object.keys(seatEls).forEach(function (k) { seatEls[k].classList.remove("talk"); });
      seatEls[who].classList.add("talk");
    }
  }
  function hideBubble() {
    if (bubble) bubble.classList.add("is-hidden");
    Object.keys(seatEls).forEach(function (k) { seatEls[k].classList.remove("talk"); });
  }
  function hint(t) { if (hintEl) hintEl.textContent = t || ""; }

  /* ---------- 台词队列（点一下推进） ---------- */
  function run(after) { G.after = after || null; pump(); }
  function pump() {
    if (!G) return;
    if (G.queue.length) {
      G.mode = "speech";
      var s = G.queue.shift();
      showBubble(s.who, s.text);
      if (s.vo && window.MomoAudio && MomoAudio.pick) {
        var v = MomoAudio.pick(s.vo);
        if (v) MomoAudio.vo(v);
      }
      return;
    }
    hideBubble();
    G.mode = "wait";
    var f = G.after; G.after = null;
    if (f) f();
  }
  function advance() { pump(); }

  function markPickable(list) {
    Object.keys(seatEls).forEach(function (k) {
      seatEls[k].classList.toggle("pickable", list.indexOf(k) >= 0);
    });
  }

  /* ---------- 夜：刀 / 照镜 / 药茶（全部由执念权重驱动） ---------- */
  function nightResolve() {
    var R = {};
    var foxes = aliveList().filter(isFox);
    var knifed = null, saved = false, poisoned = null, checkedName = null, checkedFox = false;
    /* 刀：随机一把活着的狐执刀，刀口受执念锁死（knife_zero） */
    if (foxes.length) {
      var owner = pick(foxes);
      var zero = (RULES.knife_zero || {})[owner] || [];
      var cand = aliveList().filter(function (n) {
        return !isFox(n) && zero.indexOf(n) < 0;
      });
      var wts = RULES.knife_weight || {};
      var total = 0, bag = [];
      cand.forEach(function (n) {
        var w = wts[n] != null ? wts[n] : 1;
        total += w; bag.push([n, w]);
      });
      if (total > 0) {
        var r = Math.random() * total;
        for (var i = 0; i < bag.length; i++) { r -= bag[i][1]; if (r <= 0) { knifed = bag[i][0]; break; } }
        if (!knifed && bag.length) knifed = bag[0][0];
      }
      R.knifed = knifed; R.owner = owner;
    }
    /* 药茶（小野活着才有）：幸子必救；首夜大概率回魂；次夜可能断念 */
    var PR = RULES.pharm_rules || {};
    if (G.alive[RULES.pharm] && knifed) {
      if ((PR.must_save || []).indexOf(knifed) >= 0) saved = true;
      else if (G.day === 1 && Math.random() < (PR.night1_save_chance || 0.85)) saved = true;
    }
    if (G.day >= 2 && G.alive[RULES.pharm] && Math.random() < (PR.night2_poison_chance || 0.6)) {
      var bad = (PR.never_poison || []);
      var pool = aliveList().filter(function (n) {
        return n !== knifed && n !== RULES.pharm && bad.indexOf(n) < 0;
      });
      /* 断念茶指向昨日得票最高的可疑位（没有就随机一位客人） */
      var t = G.lastTop && pool.indexOf(G.lastTop) >= 0 ? G.lastTop : pick(pool);
      if (t) poisoned = t;
    }
    /* 照镜（樱井活着才有）：首夜验沉默位，第二夜盯上千春（她的小本子早记满了） */
    if (G.alive[RULES.mirror]) {
      var order = (RULES.check_order || []).slice();
      if (G.day >= 2 && G.alive["千春"]) checkedName = "千春";
      else {
        checkedName = null;
        for (var k = 0; k < order.length; k++) {
          if (G.alive[order[k]] && G.checked.indexOf(order[k]) < 0) { checkedName = order[k]; break; }
        }
      }
      if (!checkedName) checkedName = pick(aliveList().filter(function (n) { return n !== RULES.mirror; }));
      if (checkedName) { G.checked.push(checkedName); checkedFox = isFox(checkedName); }
    }
    R.saved = saved; R.poisoned = poisoned; R.checkedName = checkedName; R.checkedFox = checkedFox;
    return R;
  }

  function kill(name, cause) {
    if (!name || !G.alive[name]) return;
    G.alive[name] = false;
    if (seatEls[name]) seatEls[name].classList.add("dead");
    if (name === "玩家") G.playerAlive = false;
  }

  function night() {
    G.day += 1;
    G.mode = "night";
    if (dim) dim.classList.add("on");
    hint("第 " + G.day + " 夜 · 隐狐斟茶");
    hostSay("night");
    if (G.playerAlive) {
      var ny = (((PT.pools || {})[HOST] || {}).night_you) || "";
      if (ny) say("", ny, null);            /* 括号旁白走无主气泡，不挂月见的名字 */
    }
    var R = nightResolve();
    G.lastNight = R;
    if (R.checkedFox && R.checkedName) G.outed = R.checkedName;   /* 照镜点名过谁，全场记住——之后的昼日持续跟随 */
    run(function () {
      /* 天亮：按「毒 → 刀 → 回魂」的顺序报账 */
      if (R.poisoned) {
        kill(R.poisoned, "poison");
        hostSay("dawn_poison", label(R.poisoned));
      }
      if (R.knifed && R.saved) hostSay("dawn_saved", label(R.knifed));
      else if (R.knifed) {
        kill(R.knifed, "knife");
        hostSay("dawn_knife", label(R.knifed));
        if (R.knifed === "玩家") {
          var kpr = (((PT.pools || {})[HOST] || {}).knife_player_react) || "";
          if (kpr) say("", kpr, null);
          var g = poolLine("墨墨", "guard");
          if (g) say("墨墨", g.text, g.expr);
        }
      }
      if (!R.knifed && !R.poisoned) hostSay("dawn_none");
      run(function () {
        if (dim) dim.classList.remove("on");
        day();
      });
    });
  }

  /* ---------- 昼：发言 → 玩家的发言卡 → 请离席 ---------- */
  function day() {
    hint("第 " + G.day + " 日 · 双镜对峙");
    hostSay("day_open");
    var P = PT.pools || {};
    if (G.day === 1) {
      /* 樱井起手报查验 → 墨墨悍跳 + tell「多一句」→ 众人反应 */
      if (G.alive[RULES.mirror]) {
        var c1 = P[RULES.mirror] && P[RULES.mirror].claim_d1;
        if (c1) say(RULES.mirror, c1.text, c1.expr);
      }
      if (G.alive["墨墨"]) {
        var cl = P["墨墨"] && P["墨墨"].claim;
        if (cl) say("墨墨", cl.text, cl.expr, cl.vo);
        var tl = P["墨墨"] && P["墨墨"].tell;
        if (tl) say("墨墨", tl.text, tl.expr);     /* 照镜不该说的那句：她对玩家的关心泄露 */
      }
      ["千春", "茶终", "小野", "池田", "幸子"].forEach(function (n) {
        if (!G.alive[n]) return;
        if (n === "幸子") sayLine(n, "claim_d1");
        else if (n === "池田") sayLine(n, "accuse");
        else sayLine(n, G.day === 1 ? "react" : "claim");
      });
    } else {
      /* D2 固定节拍只在第二日出现；第 3 昼起是纯找茬轮（照镜的名单已经摆上桌了） */
      if (G.day === 2 && G.alive["幸子"]) {
        var firm = P["幸子"] && P["幸子"].firm_d2;
        if (firm) say("幸子", firm.text, firm.expr);
      }
      if (G.day === 2 && G.alive[RULES.mirror]) {
        var last = G.lastNight || {};
        if (last.checkedName) {
          var c2 = last.checkedFox
            ? (P[RULES.mirror] && P[RULES.mirror].claim_d2_fox)
            : (P[RULES.mirror] && P[RULES.mirror].claim_d2);
          if (c2) say(RULES.mirror, c2.text, c2.expr);
        }
      }
      if (G.day >= 3 && G.alive["墨墨"]) sayLine("墨墨", "d2");   /* 第 3 昼起她开局施压 */
      var outed = G.outed || null;
      ["千春", "茶终", "小野", "池田"].forEach(function (n) {
        if (!G.alive[n]) return;
        /* 被照镜点了名的狐走防御位，其余照常找茬 */
        sayLine(n, n === outed ? "defend" : "accuse");
      });
    }
    run(function () { playerTurn(function () { doVote(); }); });
  }

  /* ---------- 玩家的发言卡 ----------
     chooseCard 后进入 pick 模式点对象；resolveCard 把反应入队，
     队列播完接回 playerTurn 存下的 next（G._cardNext）→ 投票。 */
  var pendingCard = null;
  function chooseCard(k) {
    if (!G || G.mode !== "cards") return;
    pendingCard = k;
    G.mode = "pick";
    if (actions) actions.style.display = "none";
    var targets = aliveList().filter(function (n) { return n !== "玩家"; });
    markPickable(targets);
    hint((CARDS[k] || {}).label + " · 点一位对象");
  }
  function pickSeat(name) {
    if (!G) return;
    if (G.mode === "pick" && pendingCard) {
      if (!name || name === "玩家" || !G.alive[name]) return;
      markPickable([]);
      resolveCard(pendingCard, name);
      return;
    }
    if (G.mode === "vote") {
      if (!name || name === "玩家" || !G.alive[name]) return;
      markPickable([]);
      G.playerVote = name;
      tally();
      return;
    }
    if (G.mode === "tea") {
      if (!name || name === "你") return;
      markPickable([]);
      serveTea(name);
      return;
    }
  }
  function resolveCard(k, target) {
    say("玩家", playerLangLine(k), null);
    if (k === "accuse") {
      if (target === "墨墨") { G.accusedMomo = true; sayLine("墨墨", "defend"); }
      else sayLine(target, "defend");
    } else if (k === "back") {
      if (target === "墨墨") sayLine("墨墨", "back_thanks");
      else sayLine(target, "react");
    } else {
      /* 委婉质疑 / 沉默观察：读反应 */
      sayLine(target, "watch_reaction");
    }
    pendingCard = null;
    hint("");
    run(function () {
      var f = G._cardNext; G._cardNext = null;
      if (f) f();
    });
  }
  /* 发言卡收尾要接回 vote：playerTurn 传进来的 next 存在 G._cardNext */
  function playerTurn(next) {
    if (!G.playerAlive) { next(); return; }
    G._cardNext = next;
    hint("轮到你了 · 出一张发言卡");
    G.mode = "cards";
    if (actions) actions.style.display = "";
  }

  /* ---------- 请离席（投票） ---------- */
  /* 加权抽人：客人们对「被请来的末茶人」客气——票很少落到你头上（C 线要稀有） */
  function wvote(list) {
    if (!list || !list.length) return null;
    var total = 0, bag = [];
    list.forEach(function (n) {
      var w = n === "玩家" ? 0.25 : 1;
      total += w; bag.push([n, w]);
    });
    var r = Math.random() * total;
    for (var i = 0; i < bag.length; i++) { r -= bag[i][1]; if (r <= 0) return bag[i][0]; }
    return bag[bag.length - 1][0];
  }
  function npcVote(name, votesSoFar) {
    var V = (RULES.vote || {})[name] || {};
    var alive = aliveList().filter(function (n) { return n !== name; });
    if (V.never) alive = alive.filter(function (n) { return (V.never || []).indexOf(n) < 0; });
    /* 照镜点名谁，全桌就压谁——证据比直觉响，这也让「双镜对峙」有真分量 */
    var outed = G.outed || null;
    if (outed && G.alive[outed] && name !== "墨墨" && alive.indexOf(outed) >= 0) {
      return outed;
    }
    if (name === "池田") {
      return (V["千春"] && G.alive["千春"]) ? "千春" : wvote(alive);
    }
    if (name === "墨墨") {
      /* 她的票护着自己的队伍与玩家：点名的风波一起，就把怀疑泼向客人——绝不泼你 */
      var guests = alive.filter(function (n) { return !isFox(n); });
      return pick(guests.length ? guests : alive);
    }
    return wvote(alive);
  }
  function followVote(votes) {
    /* 幸子：数票，跟着多数走；没有多数就弃跟随（随机） */
    var c = {};
    Object.keys(votes).forEach(function (k) { c[votes[k]] = (c[votes[k]] || 0) + 1; });
    var top = null, n = 0;
    Object.keys(c).forEach(function (k) { if (c[k] > n) { top = k; n = c[k]; } });
    var alive = aliveList().filter(function (x) { return x !== "幸子"; });
    return (top && alive.indexOf(top) >= 0) ? top : pick(alive);
  }
  function doVote() {
    hostSay("vote_open");
    run(function () {
      var votes = {};
      aliveList().forEach(function (n) {
        if (n === "玩家" || n === "幸子") return;
        votes[n] = npcVote(n, votes);
      });
      if (G.alive["幸子"]) votes["幸子"] = followVote(votes);
      G.votesNow = votes;
      if (G.playerAlive) {
        G.mode = "vote";
        hint("举盏 · 点一位请离席");
        markPickable(aliveList().filter(function (n) { return n !== "玩家"; }));
      } else {
        G.playerVote = null;
        tally();
      }
    });
  }
  function tally() {
    var votes = G.votesNow || {};
    if (G.playerVote) votes["玩家"] = G.playerVote;
    var c = {};
    Object.keys(votes).forEach(function (k) { c[votes[k]] = (c[votes[k]] || 0) + 1; });
    var top = [], n = 0;
    Object.keys(c).forEach(function (k) {
      if (!G.alive[k]) return;
      if (c[k] > n) { top = [k]; n = c[k]; }
      else if (c[k] === n) top.push(k);
    });
    if (!top.length) { hostSay("vote_none"); run(checkEnd); return; }
    var out = top.length > 1 ? pick(top) : top[0];
    G.lastTop = out;
    var byPlayer = G.playerVote === out;
    kill(out, "vote");
    hostSay("vote_out", label(out));
    if (out === "墨墨") {
      var key = byPlayer ? "voted_out_by_player" : "voted_out_by_npc";
      if (byPlayer) G.momoOutByPlayer = true;
      sayLine("墨墨", key);
    } else if (out !== "玩家") {
      sayLine(out, "voted_out");
    }
    hint("");
    run(checkEnd);
  }
  function checkEnd() {
    if (aliveFoxes() === 0) return finale("guest");
    if (aliveFoxes() >= aliveGuests()) return finale("fox");
    if (G.day >= (RULES.days || 4)) return finale(null);   /* 安全上限；正常局在 2~4 昼内自然分出胜负 */
    night();
  }

  /* ---------- 终局：末茶人递茶 ---------- */
  function finale(winner) {
    G.mode = "finale";
    if (winner === "fox") hostSay("fox_win");
    else if (winner === "guest") hostSay("guest_win");
    hostSay("finale");
    hint("终局之茶 · 由你递出");
    run(function () {
      /* 递给谁，谁的愿望就被听见——离席者也可以（把茶送到桥头） */
      G.mode = "tea";
      markPickable(Object.keys(seatEls).filter(function (k) { return k !== "玩家"; }));
    });
  }
  function serveTea(target) {
    G.teaTarget = target;
    markPickable([]);
    hint("");
    if (G.alive[target] && isFox(target)) {
      /* 末茶点破了活着的狐：那杯茶替真相作证 */
      kill(target, "tea");
      var t = poolLine(target, "voted_out");
      if (t) say(target, t.text, t.expr);
      if (aliveFoxes() === 0) hostSay("guest_win");
      else if (aliveFoxes() >= aliveGuests()) hostSay("fox_win");
    }
    if (target === "墨墨") G.momoOutByPlayer = G.momoOutByPlayer || true;
    run(function () {
      lastOutcome = !G.playerAlive ? "C"
                  : (G.momoOutByPlayer || G.teaTarget === "墨墨") ? "A" : "B";
      teardown();
      /* 幕三剧本（ch1_结A/B/C）随茶会一起摘除了；end_branches 缺失时别在这儿砸 TypeError，
         play() 拿不到剧本会自己返回 false（重新接回幕三时把 end_branches 填回来）。 */
      window.MomoDirector && MomoDirector.play((CH.end_branches || {})[lastOutcome] || (CH.end_branches || {}).B);
    });
  }

  function teardown() {
    if (ui && ui.parentNode) ui.parentNode.removeChild(ui);
    ui = null; seatEls = {}; bubble = null; actions = null;
    shade = null; dim = null; floatsEl = null;
    stageClear();
    G = null;
    active = false;
  }

  /* ---------- 幕二入口（幕一演完由 script_end 唤起） ---------- */
  function begin() {
    if (active) return;
    if (!buildOverlay()) return;
    active = true;
    G = {
      alive: {}, day: 0, mode: "wait", queue: [], after: null,
      playerAlive: true, playerVote: null, votesNow: null, lastTop: null,
      checked: [], outed: null, accusedMomo: false, momoOutByPlayer: false,
      teaTarget: null, lastNight: null, _cardNext: null
    };
    PLAYERS.forEach(function (n) { G.alive[n] = true; });
    hint("十五夜 · 月见茶会");
    night();
  }

  /* ---------- 幕三收尾：点灯与奖励（script_end: party:finish） ---------- */
  var replaying = false;        /* 剧情通道的重看：演整章，但奖励/点灯 toast 不重发 */
  function finish() {
    var b = bridge();
    b.lit = Math.max(b.lit || 0, CH.lamp || 1);
    if (replaying) {
      replaying = false;
      var t2 = document.getElementById("momo-toast");
      if (t2) {
        t2.textContent = "重看完成 —— 心之桥的光还在。";
        t2.className = "toast-ok";
        t2.style.display = "block";
        clearTimeout(t2._t);
        t2._t = setTimeout(function () { t2.style.display = "none"; }, 2600);
      }
      return;
    }
    var r = ((CH.rewards || {})[lastOutcome]) || (CH.rewards || {}).B || {};
    if (r.affection) STORE.apply({ affection: r.affection });
    if (r.currency) STORE.earn(r.currency, "chapter");
    sfx("sfx-award");
    var t = document.getElementById("momo-toast");
    if (t) {
      t.textContent = "心之桥 · 第 1 盏灯「勇气」已点亮" +
                      (r.affection ? "　好感 +" + r.affection : "") +
                      (r.currency ? "　货币 +" + r.currency : "");
      t.className = "toast-ok";
      t.style.display = "block";
      clearTimeout(t._t);
      t._t = setTimeout(function () { t.style.display = "none"; }, 2600);
    }
  }

  /* 点灯演出（director 的 lamp 节点）：只放光与声，写档统一在 finish——
     将来回放剧本时不会把灯重写。 */
  function light(n) {
    var root = stageRoot();
    if (!root) return;
    var d = document.createElement("div");
    d.className = "lamp-ceremony";
    d.innerHTML = '<i class="lc-glow"></i><i class="lc-core"></i>';
    root.appendChild(d);
    sfx("sfx-perfect");
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2400);
  }

  /* ---------------- 接线 ---------------- */

  /* 章节剧本的接棒：幕一演完开对局、幕三演完收尾发奖（剧本声明 then 才有）。
     2026-10-12 起 open_script 是《前言》（本章第一部分），所以「进入章节」= enter()
     直接从前言开头演起，不需要额外的重看链路了。 */
  document.addEventListener("momo:script_end", function (e) {
    if (!e || !e.detail) return;
    if (e.detail.then === "party:begin") begin();
    else if (e.detail.then === "party:finish") finish();
    /* 2026-10-20 新第一章链路：前言 → ch1_正文 → ch1_入席 → party:begin。
       剧本 then 可以直接写下一个剧本 id，这里统一接棒。 */
    else if (e.detail.then && window.MomoDirector &&
             MomoDirector.scripts().indexOf(e.detail.then) >= 0) {
      MomoDirector.play(e.detail.then);
    }
  });

  /* 章节入口（2026-10-12）：入口就是**剧情通道**。
     剧情通道点「进入」时先挂 bridge.going 再切回主画面，这里接住：
     从 CH.open_script（现在是《前言》= 本章的第一部分）开头演起。
     going 是一次性的 —— 进去就销掉，否则每次回主画面都会从头重演一遍。
     幕二/幕三写好后，在这里接上推进（原来那一支是：前言 → 赴会 → enter()）。 */
  document.addEventListener("momo:show", function (e) {
    if (!e.detail || e.detail.screen !== "主画面") return;
    if (active) return;
    if (window.MomoDirector && MomoDirector.isPlaying()) return;
    var b = bridge();
    if (b.ch1_done) return;
    if (!b.going) return;                       /* 只认剧情通道的显式进入 */
    b.going = false;
    STORE.save();
    enter();
  });

  /* 补口子（2026-10-20 评测优化）：剧情通道点「进入」时如果主画面正在自动播
     《开场》（第一次开档必播），上面那个 momo:show 监听会被 isPlaying() 挡回去，
     going 留在存档里没人接 —— 玩家点的是「进入第一章」，结果只看到开场，然后
     就停在主画面了。开场（或任何剧本）收尾时再检查一次 going，把它接上。 */
  document.addEventListener("momo:script_end", function () {
    if (active) return;
    if (window.MomoDirector && MomoDirector.isPlaying()) return;
    var b = bridge();
    if (!b.going) return;
    b.going = false;
    STORE.save();
    enter();
  });

  /* 章节入口已摘除（2026-10-12）：作者指出茶会剧情尚未定稿（「茶会的剧情我还没写呢，
     现在的不对」），要求删掉茶会的剧情与入口、只留引擎与素材。
     原先挂在这里的茶会入口判定（剧情通道「进入」/ 门槛达成 → 开席）与请柬提示 inviteNodes()
     一并撤下（见上方并行留存的前言入口）；party_月见茶会.json、对局引擎、NPC 立绘都还在，
     等作者写出正式章节后，接回一个入口即可（参考备份 backups/茶会删除-*）。 */

  /* 自动化验证出口 */
  window.MomoParty = {
    stage: stage,
    expr: expr,
    label: label,
    light: light,
    begin: begin,
    finish: finish,
    gatesMet: gatesMet,
    /* 剧情通道的重看：已通关的章节重演整章（不发奖、灯已在桥上）。
       必须在主画面已显示时调用（story-hub 先 MomoUI.show 再调这里）。 */
    replay: function () {
      if (active) return false;                       /* 正在对局中：不许重入 */
      if (!bridge().ch1_done) return false;           /* 没通关的不能「重看」 */
      replaying = true;
      /* 章节的 open_script 就是《前言》，所以 enter() 本身就是「从前言开头重演整章」——
         原来这里直接 enter() 会跳掉前言，是因为当初 open_script 是幕一的 ch1_入席。 */
      enter();
      return true;
    },
    state: function () {
      return {
        active: active,
        gates: gatesMet(),
        bridge: bridge(),
        mode: G ? G.mode : null,
        day: G ? G.day : 0,
        alive: G ? aliveList() : [],
        foxes: G ? aliveFoxes() : 0,
        outcome: lastOutcome,
        seats: Object.keys(seatEls)
      };
    }
  };
})();
