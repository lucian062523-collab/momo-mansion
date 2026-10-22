/* 墨墨 · 字海（wordsea.js）
   =====================================================================
   主画面场景后面的那层字：她学过的每一个词，都在这片海里漂着。

   三种形态（都是同一套粒子的不同参数，不是三段独立动画）：
     ① 潮 —— 常驻。字从上往下慢慢落、左右轻微摆。密度 = 她记住的词量，
        玩家第一天看到的是稀薄的一层，学得越多海越满（这就是「涌现」看得见的部分）。
     ② 瀑布 —— 她说出一句话、或者刚学会一个词时，那一串字从顶端砸下来，
        落进海里变成常驻粒子。模型的回复也是从这条路径进海的：
        **她说的话最终变成了海里的字**。
     ③ 浪 —— 情绪事件（好感升级 / 心情变化 / 点她）涌起一道横浪，
        浪高与摆幅由心情决定，色温由好感决定。

   情绪不画进度条，全部落在海面上：
     心情低 → 字下沉变快、摆幅变小、边缘发灰；物资见底 → 字会「碎」（掉到一半消失）；
     好感高 → 色温更暖、字更亮、摆得更从容。

   几条工程规矩：
     · 只画 canvas，pointer-events:none，绝不挡点击。
     · prefers-reduced-motion 下只画一帧静止的字，不跑 RAF。
     · 节点在 .scene2 之后插入 —— 压在场景图上、墨墨立绘下（这一层全体没有 z-index，
       顺序就是层级）。所以字是「在屋子里飘」，不是盖在人脸上。
     · 学习进度跨周目保留（见 store.js §8），所以这片海不会因为重开周目清空。 */
(function () {
  "use strict";

  var SCR = "主画面";
  var W = 1920, H = 1080;
  var FONT = '"FZXiaoBiaoSong-B05S", "方正小标宋简体", "Songti SC", serif';

  /* 常驻词海（潮）开关 —— 2026-10-20 作者要求：**背景里一直漂着的字删掉**，
     只保留「她说话时落下来的那串字」（瀑布）。想恢复就把这里改 true。 */
  var AMBIENT = false;

  var cv = null, ctx = null, raf = 0, last = 0, running = false, t = 0;
  var parts = [];       // 常驻的字
  var falls = [];       // 瀑布：正在下落的句子
  var waves = [];       // 浪：横着涌过去的字

  var reduce = false;
  try { reduce = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}

  /* ---------------- 参数：情绪 → 海面 ---------------- */
  var P = {
    dens: 34,        // 常驻字的目标数量
    vy: 26,          // 下落速度 px/s
    sway: 18,        // 左右摆幅
    alpha: 0.16,     // 基础不透明度
    warm: 1,         // 1=暖金，0=冷灰
    crumble: 0       // >0 时字会掉到一半就散掉
  };

  function S() { return (window.MomoStore && window.MomoStore.state) || {}; }

  function learnedCount() {
    var l = (S().learn || {}).learned || {};
    return Object.keys(l).length;
  }

  function tune() {
    var s = S();
    var n = learnedCount();
    var mood = Math.max(0, Math.min(100, s.mood == null ? 50 : s.mood));
    var sup = Math.max(0, Math.min(100, s.supplies == null ? 60 : s.supplies));
    var aff = Math.max(0, s.affection || 0);

    /* 一开始 34 个字只是「海面有点东西」，学到 60 个词左右就到 180 个字封顶 */
    P.dens = AMBIENT ? Math.round(46 + Math.min(134, n * 2.4)) : 0;
    P.vy = 18 + mood * 0.55 + (sup < 40 ? 26 : 0);
    P.sway = 10 + Math.min(26, mood * 0.26);
    P.alpha = 0.26 + Math.min(0.14, aff / 760 * 0.14) + (mood / 100) * 0.04;
    P.warm = 0.55 + Math.min(0.45, aff / 760 * 0.45);
    P.crumble = sup < 40 ? (40 - sup) / 40 : 0;   // 物资见底：字会散
    syncCount();
  }

  /* ---------------- 字从哪来 ---------------- */
  function wordIndex() {
    if (wordIndex._i) return wordIndex._i;
    var idx = {};
    var D = window.MOMO_DATA || {};
    ["words_en", "words_ja"].forEach(function (k) {
      (D[k] || []).forEach(function (w) { if (w && w.id) idx[w.id] = w; });
    });
    wordIndex._i = idx;
    return idx;
  }

  function charsOf(text) {
    var out = [];
    String(text || "").replace(/\s+/g, "").split("").forEach(function (c) {
      if (/[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/.test(c)) out.push(c);
    });
    return out;
  }

  /* 她记住的词 → 字。英文取字母、日文取假名（没有假名就用词干）；
     一个词都没记住时给一层极淡的「底字」，免得第一天画面是空的。 */
  function seaChars() {
    var idx = wordIndex();
    var l = (S().learn || {}).learned || {};
    var bag = [];
    Object.keys(l).forEach(function (id) {
      var w = idx[id];
      if (!w) return;
      var src = w.lang === "ja" ? (w.kana || w.lemma) : w.lemma;
      bag = bag.concat(charsOf(src));
    });
    if (!bag.length) {
      var en = (window.MOMO_DATA || {}).words_en || [];
      for (var i = 0; i < 40 && i < en.length; i++) bag = bag.concat(charsOf(en[i].lemma));
    }
    return bag;
  }

  /* ---------------- 画布 ---------------- */
  function stage() { return document.querySelector('[data-screen="' + SCR + '"] .stage'); }

  function ensure() {
    if (cv && cv.parentNode) return true;
    var stg = stage();
    if (!stg) return false;
    var scene = stg.querySelector(".scene2");
    if (scene && scene.nextSibling) {
      cv = document.createElement("canvas");
      stg.insertBefore(cv, scene.nextSibling);
    } else {
      cv = document.createElement("canvas");
      stg.appendChild(cv);
    }
    cv.width = W;
    cv.height = H;
    cv.className = "wordsea";
    cv.setAttribute("aria-hidden", "true");
    ctx = cv.getContext("2d");
    return !!ctx;
  }

  /* 新增一个常驻字；位置尽量避开正中间那张脸（左右两侧与下方更密） */
  function spawn(atTop) {
    var bag = seaChars();
    if (!bag.length) return null;
    var r = Math.random();
    var x = r < 0.34 ? Math.random() * W * 0.34
          : r < 0.68 ? W * 0.66 + Math.random() * W * 0.34
          : Math.random() * W;
    return {
      ch: bag[(Math.random() * bag.length) | 0],
      x: x,
      y: atTop ? -30 - Math.random() * 120 : Math.random() * H,
      vy: 0.55 + Math.random() * 1.1,
      size: 17 + Math.random() * 17,
      amp: 6 + Math.random() * P.sway,
      freq: 0.15 + Math.random() * 0.5,
      ph: Math.random() * Math.PI * 2,
      a: 0.45 + Math.random() * 0.55,
      life: 1
    };
  }

  function syncCount() {
    if (!ctx) return;
    if (!AMBIENT) { parts.length = 0; return; }
    var want = reduce ? Math.min(70, P.dens) : P.dens;
    while (parts.length < want) {
      var p = spawn(false);
      if (!p) break;
      parts.push(p);
    }
    while (parts.length > want) parts.pop();
  }

  /* ---------------- 三种形态 ---------------- */
  /* ② 瀑布：一句话从顶端砸下来。落到底就消失 —— 她的「声音」进海只需要一次 */
  function fall(text) {
    if (!ensure()) return;
    var cs = charsOf(text).slice(0, 40);
    if (!cs.length) return;
    /* 摊开到整条画面上沿：对话框会盖住中间那一大块，全挤在正中就只剩最后几帧看得见。 */
    for (var i = 0; i < cs.length; i++) {
      var lane = W * (0.10 + Math.random() * 0.80);
      falls.push({
        ch: cs[i],
        x: lane + (Math.random() - 0.5) * 150,
        y: -40 - Math.random() * 320,
        vy: 300 + Math.random() * 240,
        size: 28 + Math.random() * 16,
        ph: Math.random() * Math.PI * 2,
        a: 0.62 + Math.random() * 0.34
      });
    }
    start();
  }

  /* ③ 浪：一道横浪从左往右推，浪高由当前心情决定 */
  function wave(strength) {
    if (!ensure()) return;
    var mood = Math.max(0, Math.min(100, S().mood == null ? 50 : S().mood));
    var k = Math.max(0.4, Math.min(1.6, strength || (0.5 + mood / 100)));
    var bag = seaChars();
    if (!bag.length) return;
    var cs = [];
    for (var i = 0; i < 46; i++) cs.push(bag[(Math.random() * bag.length) | 0]);
    waves.push({ chars: cs, t0: t, k: k, y0: H * 0.58, amp: 54 * k, speed: 720 + 320 * k });
    start();
  }

  /* ---------------- 绘制 ---------------- */
  function color(a) {
    var w = P.warm;                         /* 1=暖金（亲近）  0=冷灰（疏远/物资见底） */
    var r = Math.round(246 - 30 * (1 - w));
    var g = Math.round(218 - 40 * (1 - w));
    var b = Math.round(176 - 50 * (1 - w));
    return "rgba(" + r + "," + g + "," + b + "," + a.toFixed(3) + ")";
  }

  /* 推进一帧并绘制。返回「还有没有东西可画」—— 空海时让 RAF 自己停下，
     不要空转 60fps 一直吃电。 */
  function step(dt) {
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    /* ① 潮 */
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      p.y += P.vy * p.vy * dt;
      var x = p.x + Math.sin(t * p.freq + p.ph) * p.amp;
      var alpha = P.alpha * p.a;
      /* 物资见底：一部分字掉到中途就散掉（碎） */
      if (P.crumble > 0) {
        var cut = H * (0.35 + 0.55 * (1 - P.crumble));
        if (p.y > cut) {
          var k = (p.y - cut) / (H - cut);
          alpha *= Math.max(0, 1 - k * 1.6);
          if (alpha < 0.004) { p.y = -30; p.x = Math.random() * W; continue; }
        }
      }
      if (p.y > H + 40) { p.y = -30 - Math.random() * 80; p.x = Math.random() * W; }
      ctx.font = p.size + "px " + FONT;
      ctx.fillStyle = color(alpha);
      ctx.fillText(p.ch, x, p.y);
    }

    /* ② 瀑布 */
    for (var j = falls.length - 1; j >= 0; j--) {
      var f = falls[j];
      f.y += f.vy * dt;
      var fx = f.x + Math.sin(t * 1.4 + f.ph) * 16;
      var fa = f.a * Math.max(0, Math.min(1, (H + 60 - f.y) / (H * 0.35)));
      ctx.font = f.size + "px " + FONT;
      ctx.fillStyle = color(fa);
      ctx.fillText(f.ch, fx, f.y);
      if (f.y > H + 60) falls.splice(j, 1);
    }

    /* ③ 浪 */
    for (var m = waves.length - 1; m >= 0; m--) {
      var wv = waves[m];
      var age = t - wv.t0;
      if (age > 3.4) { waves.splice(m, 1); continue; }
      var prog = age * wv.speed;
      var fade = 1 - Math.max(0, (age - 2.1) / 1.3);
      for (var n = 0; n < wv.chars.length; n++) {
        var wx = -120 + n * 46 + prog;
        if (wx < -80 || wx > W + 80) continue;
        var phase = (wx / W) * Math.PI * 2 - age * 2.6;
        var wy = wv.y0 - Math.sin(phase) * wv.amp - Math.cos(phase * 0.5) * 12;
        ctx.font = (26 + 10 * Math.sin(n + age)) + "px " + FONT;
        ctx.fillStyle = color((0.22 + 0.18 * Math.abs(Math.sin(phase))) * fade);
        ctx.fillText(wv.chars[n], wx, wy);
      }
    }

    return !!(parts.length || falls.length || waves.length);
  }

  function frame(now) {
    if (!running) return;
    var dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    t += dt;
    if (!step(dt)) { running = false; raf = 0; return; }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (reduce || running) return;
    if (!AMBIENT && !falls.length && !waves.length) return;
    if (!ensure()) return;
    syncCount();           /* 画布是这时候才建出来的，粒子得在这之后补 */
    /* 常驻粒子的存在与否只在「潮」开着时才重要；瀑布是真内容，不能被它拦下 ——
       2026-10-20 撤掉常驻词海时，这里曾把瀑布一起挡死（字堆在画布上不动）。 */
    if (AMBIENT && !parts.length) return;
    paintOnce();           /* 先落一帧：从切屏到第一次 RAF 之间不该是空的 */
    running = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  /* 只画一帧，不推进时间。给 start() 的第一帧和 reduced-motion 用。 */
  function paintOnce() { if (ctx) step(0); }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (ctx) ctx.clearRect(0, 0, W, H);
  }

  /* reduced-motion：只画一帧静态的字，证明「海」存在，但不动 */
  function still() {
    if (!ensure()) return;
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    parts.slice(0, 70).forEach(function (p) {
      ctx.font = p.size + "px " + FONT;
      ctx.fillStyle = color(P.alpha * p.a);
      ctx.fillText(p.ch, p.x, p.y);
    });
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener("momo:show", function (e) {
    var on = e.detail && e.detail.screen === SCR;
    if (!on) { stop(); return; }
    tune();
    if (reduce) { if (ensure()) { syncCount(); still(); } }
    else start();
  });

  /* 她说了话（chat.js 的模型回复 / 兜底台词）→ 那句话落成瀑布 */
  document.addEventListener("momo:chatline", function (e) {
    if (!e.detail || !e.detail.text) return;
    fall(e.detail.text);
  });

  /* 存档变了：密度与色温跟着重算；学到新词就再落一场 */
  var lastLearned = -1;
  document.addEventListener("momo:store", function () {
    tune();
    var n = learnedCount();
    if (lastLearned >= 0 && n > lastLearned) {
      var idx = wordIndex();
      var ids = Object.keys((S().learn || {}).learned || {});
      var newest = ids.slice(-1)[0];
      var w = idx[newest];
      if (w) fall(w.lang === "ja" ? (w.kana || w.lemma) : w.lemma);
    }
    lastLearned = n;
    if (!reduce) start();
  });

  document.addEventListener("momo:room", function () { tune(); });

  /* 点她一下：海面回一道浪（不影响 idle 的台词逻辑） */
  function bindHit() {
    var hit = document.querySelector('[data-screen="' + SCR + '"] .momo-hit');
    if (!hit) return false;
    /* 2026-10-20：点她不再起浪 —— 作者只要「说话时落字」这一种表现 */
    return true;
  }
  if (!bindHit()) document.addEventListener("DOMContentLoaded", bindHit);

  window.MomoWordSea = {
    fall: fall,
    wave: wave,
    refresh: function () { tune(); if (!reduce) start(); },
    params: function () { return { dens: P.dens, vy: P.vy, sway: P.sway, alpha: P.alpha, warm: P.warm, crumble: P.crumble, parts: parts.length }; },
    chars: function () { return seaChars(); },
    /* 供自动化验证：手动推进 n 帧（无头浏览器里 RAF 不按真实时间跑，
       截图前用这个把动画推到「看得见」的位置） */
    tick: function (n, dt) {
      if (!ensure()) return false;
      syncCount();
      for (var i = 0; i < (n || 1); i++) { t += (dt || 1 / 60); step(dt || 1 / 60); }
      return true;
    },
    state: function () { return { running: running, parts: parts.length, falls: falls.length, waves: waves.length, reduce: reduce }; }
  };

  lastLearned = learnedCount();
  tune();
  if (reduce) {
    document.addEventListener("momo:show", function (e) {
      if (e.detail && e.detail.screen === SCR) setTimeout(still, 60);
    });
  }
})();
