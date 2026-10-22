/* 墨墨 · 音频引擎（audio.js）
   一句话：全站唯一的出声口 —— BGM / 音效 / 语音三条总线，各吃「音量:阅读模式界面」
   的一条滑条，音量持久化在 localStorage。

   资产从哪来：game/audio/ 下的 mp3 由构建（_tools/build_dist.py）按内容哈希拷进
   dist/audio/，并产出 window.MOMO_AUDIO（短名 → 带哈希的产物路径）。拆分模式才有；
   单文件模式与源码直开（UI还原/index.html）没有这张表 —— 所有接口静默变 no-op，
   游戏照跑，一个 try 都不用调用方写。

   三条设计死规矩：
     1. **绝不抛错、绝不阻塞**。文件缺失、解码失败、自动播放被浏览器拦 —— 全部
        吞掉。声音是氛围，不是功能：它坏它的，游戏玩游戏的。
     2. **用户手势前不出声**。浏览器的自动播放策略决定了没有点击就没有音频，
        所以 BGM 记下「想放哪首」，等第一次 pointerdown 再真的放。
     3. **语音压 BGM**（ducking）。墨墨说话时背景音乐自动退到 25%，说完弹回来 ——
        台词永远比音乐大，人声才是主角。 */
(function () {
  "use strict";
  var MAP = window.MOMO_AUDIO || {};

  var KEY = "momo.audio.v1";
  var VOL = { sfx: 0.7, bgm: 0.8, vo: 0.9 };
  try {
    var raw = localStorage.getItem(KEY);
    if (raw) {
      var v = JSON.parse(raw);
      if (v && typeof v === "object") {
        for (var k in VOL) {
          if (typeof v[k] === "number" && v[k] >= 0 && v[k] <= 1) VOL[k] = v[k];
        }
      }
    }
  } catch (e) {}
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(VOL)); } catch (e) {} }
  /* 2026-10-20（作者反馈「BGM 听不清」）：默认值从 0.55 提到 0.8。但旧存档里已经存着
     0.55 会更低的值，光改默认没用 —— 所以做一次性上调：低于 0.6 的抬到 0.8。
     只做一次（bump1 标记），玩家自己后来调小不会被反复覆盖。 */
  try {
    if (!localStorage.getItem("momo.audio.bump1") && VOL.bgm < 0.6) {
      VOL.bgm = 0.8;
      persist();
      localStorage.setItem("momo.audio.bump1", "1");
    }
  } catch (e) {}

  /* 滑条 → 声道。这三对名字是 PSD 的图层名（ui.js 的 SLIDER_PAIRS 同款），
     对应关系由 screens.css 的坐标定死：
       滑动条1      top 693 ↔ 「音效」标签 top 699
       滑动条（米白色） top 783 ↔ 「音量」标签 top 789
       滑动条2      top 873 ↔ 「语音」标签 top 878 */
  var BAR_CHANNEL = { "滑动条1": "sfx", "滑动条（米白色）": "bgm", "滑动条2": "vo" };

  /* ---------------- 基础播放 ---------------- */
  var unlocked = false;          /* 用户点过一下没有 —— 没点过之前 BGM 只能记账 */
  var pendingBgm = null;         /* 解锁那一刻该放哪首 */
  var bgmEl = null, bgmName = "";
  var voEl = null, voDuckTimer = 0;
  var sfxPool = {};              /* 同名音效并发的克隆池：连击时一声压一声才好听 */
  var SFX_MAX = 4;

  function canPlay() {
    return unlocked && typeof Audio === "function";
  }
  function fileOf(name) {
    return MAP[name] || null;
  }

  function volumeRamp(el, to, ms) {
    if (!el) return;
    var from = el.volume, t0 = Date.now();
    clearInterval(el._ramp);
    el._ramp = setInterval(function () {
      var p = Math.min(1, (Date.now() - t0) / (ms || 260));
      el.volume = Math.max(0, Math.min(1, from + (to - from) * p));
      if (p >= 1) clearInterval(el._ramp);
    }, 40);
  }

  /* ---------------- BGM ----------------
     一首循环曲 + 淡入淡出切换。场景没变就不动它 —— 主画面和学习界面共用一首，
     没必要换来换去；开屏（标题页）单独一首更安静的。 */
  function bgm(name) {
    if (!name || !fileOf(name)) return stopBgm();
    if (name === bgmName && bgmEl && !bgmEl.paused) return;
    if (!canPlay()) { pendingBgm = name; return; }
    var go = function () {
      var el = bgmEl;
      if (!el) {
        el = bgmEl = new Audio();
        el.loop = true;
        el.preload = "auto";
      }
      var swap = function () {
        el.src = fileOf(name);
        el.loop = true;
        el.volume = 0;
        bgmName = name;
        /* 语音在说话就先压着起，说完由 voEnd 弹回目标音量 */
        /* 语音在说话就先压着起，说完由 vo 的 onended 弹回目标音量 */
        el.play().then(function () {
          volumeRamp(el, VOL.bgm * (voEl && !voEl.paused ? 0.5 : 1), 900);
        })["catch"](function () { bgmName = ""; });
      };
      /* 正在放 → 先淡出再换源；没在放 → 直接放 */
      if (el.paused || !bgmName) { swap(); return; }
      volumeRamp(el, 0, 500);
      setTimeout(swap, 520);
    };
    go();
  }
  function stopBgm() {
    pendingBgm = null;
    if (!bgmEl) return;
    var el = bgmEl;
    volumeRamp(el, 0, 500);
    setTimeout(function () { if (el === bgmEl && !el.paused) el.pause(); }, 520);
    bgmName = "";
  }
  function syncBgmVol() {
    if (bgmEl && !bgmEl.paused) volumeRamp(bgmEl, VOL.bgm, 240);
  }

  /* ---------------- 语音（墨墨说话）----------------
     同一时间只播一条：新台词进来，旧的立刻收（吵架抢话不好听）。 */
  function vo(name) {
    var f = fileOf(name);
    if (!f) return false;
    if (!canPlay()) return false;
    if (!voEl) voEl = new Audio();
    var el = voEl;
    try { el.pause(); } catch (e) {}
    el.src = f;
    el.volume = VOL.vo;
    /* BGM 退后让路 */
    if (bgmEl && !bgmEl.paused) volumeRamp(bgmEl, VOL.bgm * 0.5, 200);
    var back = function () {
      if (el === voEl && bgmEl && !bgmEl.paused) syncBgmVol();
    };
    el.onended = back;
    el.onerror = back;
    /* 兜底：语音被掐断 / 文件坏了 / 解码失败都不会触发 ended，
       没有这一条 BGM 就永远停在压低后的音量 —— 「声音突然变小」就是这么来的。 */
    clearTimeout(voDuckTimer);
    voDuckTimer = setTimeout(back, 15000);
    el.play()["catch"](function () {});
    return true;
  }

  /* ---------------- 音效 ----------------
     克隆节点并发：连对的星星一声接一声，用同一个节点会互相掐断。 */
  function sfx(name) {
    var f = fileOf(name);
    if (!f || !canPlay() || !VOL.sfx) return false;
    var pool = sfxPool[name] || (sfxPool[name] = []);
    var el = null;
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].paused || pool[i].ended) { el = pool[i]; break; }
    }
    if (!el) {
      if (pool.length >= SFX_MAX) el = pool[pool.length - 1];
      else { el = new Audio(); el.preload = "auto"; pool.push(el); }
    }
    try { el.pause(); } catch (e) {}
    el.src = f;
    el.volume = VOL.sfx;
    el.play()["catch"](function () {});
    return true;
  }

  /* ---------------- 手势解锁 ---------------- */
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (pendingBgm) { var n = pendingBgm; pendingBgm = null; bgm(n); }
  }
  document.addEventListener("pointerdown", unlock, { capture: true });
  document.addEventListener("keydown", unlock, { capture: true });

  /* ---------------- 全局点击音 ----------------
     一条委托监听覆盖全站按钮：PSD 图层按钮（.layer.btn）与学习面板的
     一票原生 button。答题/出餐那类「有自己的音效」的按钮刻意不列进来 ——
     它们的反馈音比 click 更重要，叠一声 click 反而吵。 */
  var CLICK_SEL = ".layer.btn, .mini-btn, .dr-btn, .sd-btn, .wc-arrow, .wc-g, " +
                  ".wc-btn, .nb-tab, .learn-tab, .mk-redo, .mk-drop, .map-tab, " +
                  ".map-hit, .card-hit, .item-thumb";
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest(CLICK_SEL);
    if (t && !t.disabled) sfx("sfx-click");
  }, true);

  /* ---------------- 音量滑条 ----------------
     ui.js 拖滑条时广播 momo:slider（bar=图层名，p=0~1）；这里把 p 写进对应声道。
     音量屏每次显示时再把持久化的音量摆回滑条（MomoSliders.set 由 ui.js 提供）。 */
  document.addEventListener("momo:slider", function (e) {
    if (!e.detail) return;
    var ch = BAR_CHANNEL[e.detail.bar];
    if (!ch) return;
    VOL[ch] = Math.max(0, Math.min(1, +e.detail.p || 0));
    persist();
    if (ch === "bgm") syncBgmVol();
    if (ch === "vo" && voEl) voEl.volume = VOL.vo;
  });
  function restoreKnobs() {
    var REG = window.MomoSliders;
    if (!REG) return;
    if (REG["滑动条1"]) REG["滑动条1"](VOL.sfx);
    if (REG["滑动条（米白色）"]) REG["滑动条（米白色）"](VOL.bgm);
    if (REG["滑动条2"]) REG["滑动条2"](VOL.vo);
  }

  /* ---------------- BGM 的屏政策 ----------------
     开屏放标题曲（更安静），其余所有屏放主曲 —— 学习界面不换曲：
     换来换去反而打断心流，要安静玩家自己拉音量条。 */
  document.addEventListener("momo:show", function (e) {
    if (!e.detail) return;
    var s = e.detail.screen;
    if (s === "音量:阅读模式界面") restoreKnobs();
    if (s === "开屏") bgm("bgm-title");
    else if (s) bgm("bgm-main");
  });

  /* 标签页切走就停 BGM（手机后台放着音乐是很讨人厌的行为），回来接着放 */
  document.addEventListener("visibilitychange", function () {
    if (!bgmEl || !bgmName) return;
    if (document.hidden) { try { bgmEl.pause(); } catch (e) {} }
    else if (unlocked) { try { bgmEl.play()["catch"](function () {}); } catch (e) {} }
  });

  /* ---------------- 出口 ----------------
     调用方一律写 `window.MomoAudio && MomoAudio.sfx("…")` —— 不存在（源码直开/
     单文件产物）就是无声，不用各自 try。 */
  window.MomoAudio = {
    sfx: sfx,
    bgm: bgm,
    stopBgm: stopBgm,
    vo: vo,
    has: function (name) { return !!fileOf(name); },
    /* 语音池：按前缀列出所有可用台词（如 "vo-right-" → vo-right-1..N）。 */
    pool: function (prefix) {
      var out = [];
      for (var k in MAP) if (k.indexOf(prefix) === 0) out.push(k);
      return out;
    },
    /* 语音挑一句：语言沉浸版。玩家在学哪个语种（learn.lang），就优先放该语种的
       台词变体；没录变体就回落中文基础池。命名约定（三类池互不串）：
         中文 vo-greet-1   英文 vo-en-greet-1   日文 vo-ja-greet-1
       想让墨墨在某语种下「闭嘴」：不录该语种变体即可，自动回落。
       抽取带权重：**编号即权重**——-1 是主台词（权重 1），-2 减半、-3 再减。
       所以 vo-greet-1「你来了」约 2/3，vo-greet-2 约 1/3；主台词常驻、变体点缀。 */
    pick: function (prefix) {
      var lang = "";
      try {
        lang = (((window.MomoStore && MomoStore.state.learn) || {}).lang === "ja")
               ? "ja" : "en";
      } catch (e) {}
      var vp = "vo-" + lang + prefix.slice(2);   /* "vo-right-" → "vo-en-right-" */
      var pool = [];
      for (var k in MAP) if (k.indexOf(vp) === 0) pool.push(k);
      if (!pool.length) {
        for (var k2 in MAP) if (k2.indexOf(prefix) === 0) pool.push(k2);
      }
      if (!pool.length) return "";
      if (pool.length === 1) return pool[0];
      var total = 0, ws = [];
      for (var i = 0; i < pool.length; i++) {
        var m = /-(\d+)$/.exec(pool[i]);
        var w = 1 / ((m && +m[1]) || 1);         /* vo-xx-2 权重 1/2，-3 是 1/3 */
        ws.push(w); total += w;
      }
      var r = Math.random() * total;
      for (var j = 0; j < pool.length; j++) {
        r -= ws[j];
        if (r <= 0) return pool[j];
      }
      return pool[pool.length - 1];
    },
    vol: function (ch) { return VOL[ch]; },
    setVol: function (ch, p) {
      if (!(ch in VOL)) return;
      VOL[ch] = Math.max(0, Math.min(1, +p || 0));
      persist();
      if (ch === "bgm") syncBgmVol();
      if (ch === "vo" && voEl) voEl.volume = VOL.vo;
      restoreKnobs();
    },
    unlocked: function () { return unlocked; },
    /* 供自动化验证 */
    state: function () {
      return {
        map: Object.keys(MAP).length,
        vol: { sfx: VOL.sfx, bgm: VOL.bgm, vo: VOL.vo },
        bgm: bgmName,
        bgmPlaying: !!(bgmEl && !bgmEl.paused),
        pending: pendingBgm,
        unlocked: unlocked
      };
    }
  };
})();
