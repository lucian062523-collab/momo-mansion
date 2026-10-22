/* 墨墨 · 剧情通道（story-hub.js）
   开屏第四卡「剧情通道」→ 心之桥章节阁。定位是**路线图 + 重看**，不是选关器：
     · 已通关章节 → 可重看整章（party.replay：剧本+茶会对局重演，奖励只发一次）
     · 门槛已达成、未开过 → 「今晚有约」，回主画面直接开席（请柬留给自然触发，
       从这里跳是玩家自己的选择，尊重它）
     · 未达门槛 → 灰显 + 写明门槛（好感等级 × 陪伴天数）——目标感看得见
     · 未来章节（八灯中的空位）→ 「谜」
   首次游玩的正门仍是主画面的请柬（party.js 三入口），这里只是回廊。
   「关于作者」从开屏挪进设置界面的小字入口（点开一张羊皮纸小卡）。
   数据全读 chapters.json：加章节只加数据，这里零改动。 */
(function () {
  "use strict";
  var CHD = (window.MOMO_DATA || {}).chapters || {};
  var STORE = window.MomoStore;
  if (!STORE) return;
  var BRIDGE_LAMPS = (CHD.bridge || {}).lamps || 8;

  /* ---------------- 状态 ---------------- */
  function bridge() {
    var st = STORE.state;
    if (!st.bridge || typeof st.bridge !== "object") st.bridge = { lit: 0 };
    return st.bridge;
  }
  function affectionLv() {
    var L = (window.MOMO_DATA || {}).lessons || {};
    var levels = (((L.economy || {}).affection || {}).levels) ||
                 [0, 20, 50, 100, 160, 240, 340, 460, 600, 760];
    var a = STORE.state.affection || 0, lv = 0;
    for (var i = 0; i < levels.length; i++) if (a >= levels[i]) lv = i + 1;
    return lv;
  }
  function totalDays() {
    return (window.MomoDaily && MomoDaily.state) ? (MomoDaily.state().total_days || 0) : 0;
  }
  function gatesMet(c) {
    var g = (c || {}).gates || {};
    return affectionLv() >= (g.affection_lv || 1) && totalDays() >= (g.days_total || 0);
  }
  function isDone(c) {
    /* flag 形如 "bridge.ch1_done"：已通关 = flag 落定，或灯已点到该章的位数（兜底） */
    var b = bridge();
    var k = String((c || {}).flag || "").replace(/^bridge\./, "");
    return !!(k && b[k]) || (b.lit || 0) >= (c.lamp || 1);
  }
  function lampName(n) {
    var out = "";
    (CHD.lamps || []).forEach(function (l) { if (l.n === n) out = l.name || ""; });
    return out;
  }

  /* ---------------- 通用弹窗件（羊皮纸家族） ---------------- */
  function maskOf(id) {
    var m = document.createElement("div");
    m.id = id;
    document.body.appendChild(m);
    return m;
  }
  function closeBy(m) {
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }

  /* ---------------- 章节阁 ---------------- */
  var hub = null;
  function openHub() {
    closeHub();
    hub = maskOf("story-hub-mask");
    var b = bridge();
    var html = '<div id="story-hub-panel">' +
      '<div class="sh-title">剧 情 通 道</div>' +
      '<div class="sh-sub">心之桥 · 八盏灯 —— 走过一盏，桥上便亮一盏。' +
      '　已点亮 <b>' + (b.lit || 0) + '</b> / ' + BRIDGE_LAMPS + '</div>' +
      '<div class="sh-list">';
    for (var n = 1; n <= BRIDGE_LAMPS; n++) {
      var ch = null;
      (CHD.chapters || []).forEach(function (c) { if (c.lamp === n) ch = c; });
      html += rowOf(n, ch);
    }
    var fromMain = !!(document.querySelector('#scr-主画面.active, #scr-主画面.on'));
    html += '</div>' +
      '<div class="sh-foot">主线从生活里长出来：门槛到了，点「进入」就能接上。这里也是回廊。</div>' +
      '<div style="display:' + (/(?:^|[?&])(test|edit)=1(?:&|$)/.test(location.search) ? "flex" : "none") + ';gap:10px;justify-content:center;flex-wrap:wrap;margin:2px 0 10px">' +
        '<button class="mn-btn" id="story-test-body" type="button" style="opacity:.78">测试：从正文开始</button>' +
        '<button class="mn-btn" id="story-test-teaparty" type="button" style="opacity:.78">测试：茶会前</button>' +
        '<button class="mn-btn" id="story-test-tea" type="button" style="opacity:.78">测试：AI 茶会</button>' +
      '</div>' +
      '<button class="mn-btn" id="story-hub-close" type="button">' + (fromMain ? "关 闭" : "回 开 屏") + '</button>' +
      '</div>';
    hub.innerHTML = html;
    hub.querySelector("#story-hub-close").addEventListener("click", closeHub);
    var tb = hub.querySelector("#story-test-body");
    if (tb) tb.addEventListener("click", function (e) { e.stopPropagation(); closeHub(); startBodyTest(); });
    var tp = hub.querySelector("#story-test-teaparty");
    if (tp) tp.addEventListener("click", function (e) { e.stopPropagation(); closeHub(); startTeaPartyTest(); });
    var tt = hub.querySelector("#story-test-tea");
    if (tt) tt.addEventListener("click", function (e) { e.stopPropagation(); closeHub(); startTeaTest(); });
    bindRows();
  }
  function closeHub() { closeBy(hub); hub = null; }

  function rowOf(n, c) {
    if (!c) {
      /* 未来章节：灯位保留，名字保密 */
      return '<div class="sh-row sh-row--fog">第' + CN[n] + '盏' +
        '<span class="sh-name">……</span>' +
        '<span class="sh-state">谜</span></div>';
    }
    var done = isDone(c);
    /* hub_open 的章节（作者通道）：门槛未达也能从剧情通道直接进入 */
    var canGo = !done && (gatesMet(c) || c.hub_open);
    var gate = c.gates || {};
    var state, btn = "";
    if (done) {
      state = '<span class="sh-state sh-state--lit">✦ 已点亮' +
        (lampName(n) ? '「' + lampName(n) + '」' : '') + '</span>';
      btn = '<button class="mn-btn sh-act" data-act="replay" data-id="' + c.id + '" type="button">重 看</button>';
    } else if (canGo) {
      state = '<span class="sh-state sh-state--ready">今晚有约</span>';
      btn = '<button class="mn-btn mn-btn--main sh-act" data-act="enter" data-id="' + c.id + '" type="button">进入</button>';
    } else {
      var need = [];
      if (gate.affection_lv) need.push("好感 Lv" + gate.affection_lv + "（现在 Lv" + affectionLv() + "）");
      if (gate.days_total) need.push("陪伴满 " + gate.days_total + " 天（已 " + totalDays() + " 天）");
      state = '<span class="sh-state sh-state--lock">未解锁 · ' + (need.join(" · ") || "——") + '</span>';
    }
    return '<div class="sh-row' + (done ? "" : canGo ? "" : " sh-row--lock") + '">' +
      '第' + CN[n] + '盏' +
      '<span class="sh-name">《' + (c.title || "") + '》' +
        (lampName(n) ? " · " + lampName(n) : "") + '</span>' +
      state + btn + '</div>';
  }
  var CN = ["", "一", "二", "三", "四", "五", "六", "七", "八"];

  function bindRows() {
    [].slice.call(hub.querySelectorAll(".sh-act")).forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-id"), act = btn.getAttribute("data-act");
        var ch = null;
        (CHD.chapters || []).forEach(function (c) { if (c.id === id) ch = c; });
        if (!ch) return;
        /* 「进入」先弹二选一：从头回溯 / 继续演绎（每次点都弹，2026-10-12 作者定）。
           其余动作（重看）照旧：动作先落档、再切屏 —— ui.js 的 momo:show 是**同步**
           派发的，先 show 再挂 going 的话 party.js 读到的是旧值，入口接不上。 */
        if (act === "enter") { askEnter(ch); return; }
        closeHub();
        if (window.MomoUI) MomoUI.show("主画面");
        if (act === "replay" && window.MomoParty) {
          setTimeout(function () { MomoParty.replay(); }, 600);
        }
      });
    });
  }

  /* ---------------- 进入章节前的分岔：从头回溯 / 继续演绎 ----------------
     进度是 director 每演一句就落档的 st.script={id,i}（persistScript）。
       · 继续演绎 —— 留着它：回主画面后 director 的 resumePending 接管，从那句接着演；
                      不挂 going（否则等这段演完，下次回主画面会被入口当成「重新开席」）。
       · 从头回溯 —— 清掉它：入口照常从 open_script（目前 = 本章第一部分《前言》）开头演。
     只认本章自己的剧本进度：else 开场演到一半的 st.script 会被误当成章节进度。 */
  function chapterScripts(ch) {
    var out = {};
    if (ch.open_script) out[ch.open_script] = 1;
    (ch.scripts || []).forEach(function (id) { if (id) out[id] = 1; });
    var eb = ch.end_branches || {};
    for (var k in eb) if (eb[k]) out[eb[k]] = 1;
    return out;
  }
  function progressOf(ch) {
    var s = (STORE.state.script) || {};
    var S = ((window.MOMO_DATA || {}).dialogues || {}).脚本 || {};
    if (!s.id || !chapterScripts(ch)[s.id]) return null;
    var sc = S[s.id];
    if (!sc || !sc.nodes || !sc.nodes.length) return null;
    var i = Math.max(0, Math.min(s.i | 0, sc.nodes.length - 1));
    return { id: s.id, i: i, node: sc.nodes[i] || {} };
  }
  function goChapter(ch, restart) {
    closeHub();
    if (restart) {
      var st = STORE.state;
      if (!st.script) st.script = { id: "", i: 0 };
      else { st.script.id = ""; st.script.i = 0; }   /* 进度清空 → 入口从开头演 */
      bridge().going = true;                         /* 挂 going：回主画面由入口从 open_script 开头演 */
    } else {
      /* 继续演绎**不挂 going**：主画面的 resumePending 自己会接着演。
         挂了的话，等这段演完，下次回主画面入口会把它当成「重新开席」又从头演一遍。 */
    }
    STORE.save();
    if (window.MomoUI) MomoUI.show("主画面");
  }
  function askEnter(ch) {
    var p = progressOf(ch);
    var line = "";
    if (p) {
      var t = (p.node.text || "").replace(/\s+/g, " ").trim();
      line = "上次演到：" + (t ? "「" + t.slice(0, 16) + (t.length > 16 ? "…" : "") + "」" : "（第 " + (p.i + 1) + " 句）");
    } else {
      line = "还没有可续的进度，两种选法都从《前言》第一句开始。";
    }
    var m = maskOf("story-enter-mask");
    m.innerHTML =
      '<div id="story-enter-panel">' +
        '<div class="cf-title">《' + (ch.title || "") + '》</div>' +
        '<div class="cf-sub">' + line + '\n从头回溯 = 从第一句重新演起\n继续演绎 = 接着上次那一句往下演</div>' +
        '<div class="cf-btns">' +
          '<button class="cf-btn' + (p ? "" : " cf-btn--main") + '" id="story-enter-restart" type="button">从 头 回 溯</button>' +
          '<button class="cf-btn' + (p ? " cf-btn--main" : "") + '" id="story-enter-resume" type="button">继 续 演 绎</button>' +
        '</div>' +
      '</div>';
    m.querySelector("#story-enter-restart").addEventListener("click", function (e) {
      e.stopPropagation(); closeBy(m); goChapter(ch, true);
    });
    m.querySelector("#story-enter-resume").addEventListener("click", function (e) {
      e.stopPropagation(); closeBy(m); goChapter(ch, false);
    });
    /* 点面板外 = 收起，退回章节阁（误点还有退路） */
    m.addEventListener("click", function () { closeBy(m); });
  }

  /* 开屏第四卡：剧情通道 */
  var card = document.querySelector('#scr-开屏 [data-name="剧情通道"]');
  if (card) card.addEventListener("click", function (e) {
    e.stopPropagation();
    openHub();
  });

  /* ---------------- 关于作者（从开屏挪进设置界面的小字入口） ---------------- */
  var about = null;
  function openAbout() {
    closeAbout();
    about = maskOf("about-mask");
    about.innerHTML =
      '<div id="about-panel">' +
        '<div class="mn-title">关 于 作 者</div>' +
        '<div class="ab-line">《墨墨的洋馆》</div>' +
        '<div class="ab-line ab-dim">一位只想要你好好背单词的作者。</div>' +
        '<div class="ab-line ab-dim">她负责毒舌，我负责代码；谁都不许偷懒。</div>' +
        '<div class="ab-line ab-dim">引擎：一个网页，与数不清的夜。</div>' +
        '<button class="mn-btn" id="about-close" type="button">知 道 了</button>' +
      '</div>';
    about.querySelector("#about-close").addEventListener("click", closeAbout);
  }
  function closeAbout() { closeBy(about); about = null; }
  var setScr = document.querySelector('[data-screen="设置界面"]');
  if (setScr) {
    var entry = document.createElement("div");
    entry.className = "about-entry";
    entry.textContent = "关于作者";
    entry.addEventListener("click", function (e) {
      e.stopPropagation();
      openAbout();
    });
    (setScr.querySelector(".stage") || setScr).appendChild(entry);
  }

  /* ---------------- 主画面「剧」入口（2026-10-20 评测优化） ----------------
     背景：剧情通道原来只挂在开屏第四卡上。玩家走「新的故事」→ 开场演完，
     人已经在主画面了，而《前言》还藏在「设置 → 返回标题 → 剧情通道」后面，
     第一小时很容易完全找不到主线。
     这里在主画面的 地/学/玩 下面补一个同款「剧」按钮（不改原有美术与布局），
     点开就是同一个章节阁。主线还没开始/没通关时按钮带一圈呼吸光，
     提示这里还有东西可看。 */
  /* 样式跟这个入口一起走（common.css 在 UI还原 符号链接里，不动它；
     直接用注入的 <style>，构建会连 story-hub.js 一起内联）。 */
  (function () {
    if (document.getElementById("story-entry-css")) return;
    var st = document.createElement("style");
    st.id = "story-entry-css";
    st.textContent = [
      "#scr-主画面 .story-entry{position:absolute;left:1772px;top:382px;width:104px;height:104px;" +
        "border-radius:22px;background-color:rgba(58,42,30,.78);border:1.5px solid #c9a86a;" +
        "box-shadow:0 4px 18px rgba(0,0,0,.34),inset 0 0 20px rgba(201,168,106,.16);" +
        "transition:box-shadow .15s ease;}",
      "#scr-主画面 .story-entry:hover{box-shadow:0 4px 22px rgba(0,0,0,.42),inset 0 0 28px rgba(255,214,150,.44);}",
      "#scr-主画面 .story-entry .btn-label{position:absolute;left:0;top:0;width:100%;height:100%;" +
        "display:flex;align-items:center;justify-content:center;font-family:\"FZXiaoBiaoSong-B05S\",\"方正小标宋简体\",serif;" +
        "font-size:46px;color:#f7f3ee;letter-spacing:0;text-shadow:0 0 6px rgba(255,240,224,.45),0 1px 2px rgba(60,40,25,.28);}",
      "@keyframes story-entry-breath{0%,100%{box-shadow:0 4px 18px rgba(0,0,0,.34),inset 0 0 20px rgba(201,168,106,.16);}" +
        "50%{box-shadow:0 4px 26px rgba(0,0,0,.42),inset 0 0 30px rgba(255,214,150,.55),0 0 22px 4px rgba(255,214,130,.22);}}",
      "#scr-主画面 .story-entry.has-new{animation:story-entry-breath 3.2s ease-in-out infinite;}",
      "#scr-主画面.story-lock .story-entry{opacity:0;pointer-events:none;transition:opacity .35s ease;}",
      "@media (max-width:900px){#scr-主画面 .story-entry{left:1738px;top:472px;width:138px;height:138px;border-radius:28px;}" +
        "#scr-主画面 .story-entry .btn-label{font-size:62px;}}",
      "@media (prefers-reduced-motion: reduce){#scr-主画面 .story-entry.has-new{animation:none;}}"
    ].join("\n");
    document.head.appendChild(st);
  })();

  var mainScr = document.querySelector('[data-screen="主画面"]');
  var mainEntry = null;
  function markNew() {
    if (!mainEntry) return;
    var on = false;
    try { on = !bridge().prologue_done; } catch (e) {}
    mainEntry.classList.toggle("has-new", on);
  }
  if (mainScr) {
    mainEntry = document.createElement("div");
    mainEntry.className = "story-entry layer btn";
    mainEntry.setAttribute("data-name", "剧情通道");
    mainEntry.innerHTML = '<span class="btn-label" data-kind="fixed" style="left:0;top:0;width:100%;height:100%;font-size:46px;color:#f7f3ee;letter-spacing:0;align-items:center;justify-content:center;text-align:center;white-space:nowrap">剧</span>';
    mainEntry.addEventListener("click", function (e) {
      e.stopPropagation();
      openHub();
    });
    (mainScr.querySelector(".stage") || mainScr).appendChild(mainEntry);
    document.addEventListener("momo:show", function (e) {
      if (e.detail && e.detail.screen === "主画面") markNew();
    });
    document.addEventListener("momo:script_end", markNew);
    markNew();
  }

  /* ---------------- 测试入口（2026-10-20 作者要：从新写的正文处开始） ----------------
     不演前言、不看开屏，直接落到《月见茶会》正文（作者新稿 1/5）第一句。
     用法：剧情通道里点「测试：从正文开始」；或打开 ?test=ch1 / ?test=tea。 */
  function ensureTestProfile() {
    try {
      if (!localStorage.getItem("momo.profile")) {
        localStorage.setItem("momo.profile", JSON.stringify({ name: "测试君" }));
      }
    } catch (e) {}
  }
  function startBodyTest() {
    ensureTestProfile();
    var st = STORE.state;
    st.story = st.story || {};
    st.story.intro_done = true;                 /* 不自动播开场 */
    st.bridge = st.bridge || {};
    st.bridge.prologue_done = true;             /* 跳过前言 */
    st.script = { id: "", i: 0 };
    st.room = "卧房"; st.floor = "F1";
    STORE.save();
    if (window.MomoDirector) { try { MomoDirector.stop(); } catch (e) {} }
    if (window.MomoUI) MomoUI.show("主画面");
    setTimeout(function () {
      if (window.MomoDirector && MomoDirector.play) MomoDirector.play("ch1_正文");
    }, 420);
  }
  function startTeaPartyTest() {
    ensureTestProfile();
    var st = STORE.state;
    st.story = st.story || {};
    st.story.intro_done = true;
    st.bridge = st.bridge || {};
    st.bridge.prologue_done = true;
    st.script = { id: "", i: 0 };
    st.room = "茶会空间"; st.floor = "F3";
    STORE.save();
    if (window.MomoDirector) { try { MomoDirector.stop(); } catch (e) {} }
    if (window.MomoUI) MomoUI.show("主画面");
    setTimeout(function () {
      if (window.MomoDirector && MomoDirector.play) MomoDirector.play("ch1_茶会前");
    }, 420);
  }
  function startTeaTest() {
    ensureTestProfile();
    var st = STORE.state;
    st.story = st.story || {};
    st.story.intro_done = true;
    st.bridge = st.bridge || {};
    st.bridge.prologue_done = true;
    st.script = { id: "", i: 0 };
    st.room = "茶歇间"; st.floor = "F3";
    STORE.save();
    if (window.MomoDirector) { try { MomoDirector.stop(); } catch (e) {} }
    if (window.MomoUI) MomoUI.show("主画面");
    setTimeout(function () {
      if (window.MomoTeaAI && MomoTeaAI.start) MomoTeaAI.start();
    }, 420);
  }

  /* URL 直达：?test=ch1 / ?test=tea（方便无头/手机快速验收） */
  try {
    var q = new URLSearchParams(location.search);
    var t = q.get("test");
    if (t === "ch1" || t === "tea" || t === "teaparty") {
      /* 测试入口要绕开姓名弹窗：没有名字就先补一个再重载一次。 */
      var hasProfile = false;
      try { hasProfile = !!localStorage.getItem("momo.profile"); } catch (e) {}
      if (!hasProfile) {
        ensureTestProfile();
        setTimeout(function () { location.reload(); }, 60);
      } else {
        setTimeout(function () {
          if (t === "tea") startTeaTest();
          else if (t === "teaparty") startTeaPartyTest();
          else startBodyTest();
        }, 2600);
      }
    }
  } catch (e) {}

  /* 供自动化验证用 */
  window.MomoStoryHub = {
    startBody: startBodyTest,
    startTeaParty: startTeaPartyTest,
    startTea: startTeaTest,
    open: openHub,
    close: closeHub,
    openAbout: openAbout,
    rows: function () {
      return [].slice.call((hub || document).querySelectorAll(".sh-row")).map(function (r) {
        return r.textContent.replace(/\s+/g, " ");
      });
    },
    done: function (id) {
      var c = null;
      (CHD.chapters || []).forEach(function (x) { if (x.id === id) c = x; });
      return c ? isDone(c) : false;
    },
    gates: function (id) {
      var c = null;
      (CHD.chapters || []).forEach(function (x) { if (x.id === id) c = x; });
      return c ? gatesMet(c) : false;
    }
  };
})();
