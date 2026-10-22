/* 墨墨 · 地点小游戏

   地图上每个房间都有自己的玩法：**内核只有几套，关卡参数全在
   game/content/minigames.json** —— 新增地点只改那个 JSON，不用碰这个文件。

   一局的流程：进屏 → 按关卡跑一局 → 结算发货币 → 回主画面，
   墨墨就这一局说两句（跟 gift-talk.js 同一套「存 pending + momo:show 时演」机制）。

   三条约束：
     1. **产出只走 STORE.earn(n, "minigame")** 这一个出口；不发物资、不动好感与心情，
        所以不会干扰「物资维持生存」那条主循环。
     2. **配额**：每个地点每天只结算一次，每天最多结算 3 个地点 —— 防刷，也让地点玩法
        比刷题慢一步（S 级 15 ≈ 两道到期题，但要花 20 秒）。
     3. **可选、不强制**：不进小游戏完全不影响学习和日程。

   内核家族（五套，全在 RUNNERS 注册）：
     skim 手感系 —— 打水漂，靠时间窗口与风险选择
     rush 忙乱系 —— 限时出餐
     wire 解谜系 —— 配对连线：词↔释义 / 汉字↔假名（P2，词对运行时从词库抽）
     order 语序系 —— 拼句：打乱的词块按正确语序拼回（P1，英语例句自动切词）
     hunt 沉浸系 —— 场景寻物：读目标语浮标，找出中文提示的物件（P3） */
(function () {
  "use strict";
  var SCR = "小游戏界面";
  var DATA = (window.MOMO_DATA || {}).minigames || {};
  var CORES = DATA.cores || {};
  var LEVELS = DATA.levels || {};
  var DEF = DATA.defaults || { earn: [15, 10, 6, 2], lines: {} };
  var MAX_PER_DAY = 3;                 // 每天最多结算几个地点
  var W = 1920, H = 1080;              // 舞台坐标（.stage 是 1920×1080）

  var scr = document.querySelector('[data-screen="' + SCR + '"]');
  if (!scr) return;
  var STORE = window.MomoStore;                    // 存档（货币出口与每日配额都走它）
  var bg = scr.querySelector(".mini-bg");
  var canvas = scr.querySelector(".mini-canvas");
  var box = scr.querySelector(".mini-play");       // 有玩法时显示
  var empty = scr.querySelector(".mini-empty");    // 这个地点还没做时显示
  var res = scr.querySelector(".mini-result");
  var run = null, raf = 0, pending = null;

  function slot(n) { return scr.querySelector('[data-f="' + n + '"]'); }
  function put(n, v) { var e = slot(n); if (e) e.textContent = v == null ? "" : String(v); }
  var FONT = "'FZXiaoBiaoSong-B05S', 'Noto Serif SC', serif";
  /* 圆角矩形路径：两个内核都要画卡片与格子 */
  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /* ---------------- 语言内核共用的三件小工具 ----------------
     ① 词库：wire / order / hunt 的词对、句子、浮标全部运行时从真实词库抽，
        不在 JSON 里写死词表 —— 换词库不用改关卡，重玩不重样。
     ② 火花粒子：配对成功 / 拼对 / 找到 时的庆祝效果，三个内核共用一份。
     ③ 音效钩子：存在才放（源码直开 / 单文件产物里 MomoAudio 不存在）。 */
  function wordPool(lang) {
    var D = window.MOMO_DATA || {};
    return lang === "ja" ? (D.words_ja || []) : (D.words_en || []);
  }
  function shuffled(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function sfx(name) { if (window.MomoAudio) MomoAudio.sfx(name); }

  function burst(st, x, y, n) {
    var colors = ["#ffe6ae", "#ffdc9e", "#fff6e4", "#e8b96f"];
    for (var i = 0; i < (n || 12); i++) {
      var a = Math.random() * Math.PI * 2, v = 90 + Math.random() * 240;
      st.parts.push({
        x: x, y: y,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80,
        life: 0.45 + Math.random() * 0.5, t: 0,
        c: colors[Math.floor(Math.random() * colors.length)],
        r: 1.8 + Math.random() * 3.2
      });
    }
  }
  function drawParts(ctx, st, dt) {
    for (var i = st.parts.length - 1; i >= 0; i--) {
      var p = st.parts[i];
      p.t += dt;
      if (p.t >= p.life) { st.parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 400 * dt;
      ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  /* 挑几条不重样的词（按 key 去重，避免两个词条同义造成连线歧义） */
  function pickWords(lang, n, ok) {
    var pool = wordPool(lang).filter(ok || function () { return true; });
    var seen = {}, out = [];
    pool = shuffled(pool);
    for (var i = 0; i < pool.length && out.length < n; i++) {
      var w = pool[i];
      var key = lang === "ja" ? (w.kana || w.lemma) : String(w.meaning_zh || "") + "|" + w.lemma;
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(w);
    }
    return out;
  }
  function wordForm(w) {
    return w.kanji || w.kana || w.lemma || "";
  }

  /* ---------------------------------------------------------- 关卡解析 */

  function curPlace() {
    var st = STORE.state;
    var room = st.room || "玄关";
    var floor = st.floor || (window.MomoScene ? MomoScene.floorOf(room) : "F1");
    return { key: floor + ":" + room, room: room, floor: floor };
  }
  /* 关卡键优先「楼层:房间」（有 3 个卧室、2 个储藏间重名），再退房间名 */
  function levelOf(p) {
    return LEVELS[p.key] || LEVELS[p.room] || null;
  }
  function playable(p) { return !!levelOf(p); }

  /* ---------------------------------------------------------- 配额 */

  function dayKey() {
    if (window.MomoDaily && MomoDaily.day) return MomoDaily.day();
    var d = new Date(); d.setHours(d.getHours() - 5);   // 与 daily.js 同口径：05:00 换日
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  function quota() {
    var d = STORE.state.daily || (STORE.state.daily = {});
    var today = dayKey();
    if (!d.mini || d.mini.day !== today) d.mini = { day: today, used: {}, total: 0 };
    return d.mini;
  }
  /* 发钱：同一地点当天只发一次，且当天最多 MAX_PER_DAY 个地点。返回实际到手的货币 */
  function award(key, coins) {
    var q = quota();
    if (q.used[key]) return 0;
    if (q.total >= MAX_PER_DAY) return 0;
    q.used[key] = 1;
    q.total += 1;
    if (coins > 0) STORE.earn(coins, "minigame");
    else STORE.save();
    return coins;
  }

  /* ---------------------------------------------------------- 结算 */

  /* 各内核只报一个 0~1 的完成度，评级阈值统一放这里 —— 免得每套玩法各写一份 */
  function gradeOf(ratio) {
    if (ratio >= 0.80) return "S";
    if (ratio >= 0.60) return "A";
    if (ratio >= 0.40) return "B";
    return "C";
  }
  function coinsOf(L, grade) {
    var e = L.earn || DEF.earn || [15, 10, 6, 2];
    return e[{ S: 0, A: 1, B: 2, C: 3 }[grade]] || 0;
  }
  function linesOf(L, kind) {
    var l = (L.lines || {})[kind] || [];
    return l.length ? l : ((DEF.lines || {})[kind] || []);
  }

  function settle(ratio, detail) {
    var p = curPlace(), L = levelOf(p);
    var grade = gradeOf(ratio);
    var coins = coinsOf(L, grade);
    var got = award(p.key, coins);                     // 配额内才真的到账
    var lines = linesOf(L, got > 0 ? "win" : "lose");
    if (got === 0 && coins > 0) {                      // 已经拿过 → 提示今天别刷了
      lines = [{ text: "今天在这个地方已经玩过了。……明天再来吧。", expr: "不悦" }];
    }
    res.hidden = false;
    put("grade", grade);
    put("coins", got > 0 ? ("货币 +" + got) : "今日已结算");
    put("detail", detail || "");
    /* 结算音：S 级放庆祝音 + 撒一圈星火，其余放平常的锣声 */
    if (grade === "S") {
      sfx("sfx-perfect");
      var card = res.querySelector(".mini-card");
      if (card) {
        card.classList.remove("s-burst");
        void card.offsetWidth;
        card.classList.add("s-burst");
      }
    } else {
      sfx("sfx-settle");
    }
    var again = scr.querySelector('[data-act="again"]');
    if (again) {
      again.disabled = got === 0 && coins > 0;
      again.textContent = again.disabled ? "今天已结算" : "再 来 一 局";
    }
    pending = { lines: lines, key: p.key, grade: grade, coins: got };
    return { grade: grade, coins: got };
  }

  /* ---------------------------------------------------------- 内核：skim 手感系 · 打水漂
     按住蓄力（条来回扫）→ 松开抛出 → 水面上扩散出一圈**向内收缩**的判定环 →
     在环收到中心那一刻点一下。蓄得越满圈收得越快（更难）、但每投的分数倍率越高 ——
     一按一放之间同时赌「风险」和「手感」。 */
  var skim = {
    start: function (L, done) {
      var C = CORES.skim || {}, P = L.params || {};
      var shots = P.shots || C.shots || 5;
      var win = C.window || [60, 120, 200];
      var slow = P.ringSlow || C.ringSlow || 1.15;
      var fast = P.ringFast || C.ringFast || 0.72;
      var pmin = C.powerMin || 0.35;
      var ctx = canvas.getContext("2d");
      var st = {
        i: 0, combo: 0, best: 0, score: 0,
        phase: "ready", power: 0, pdir: 1, shotPower: 0,
        ring: null, pop: null, wait: 0, last: 0, raf: 0
      };
      var CHARGE_SEC = 1.5;      /* 蓄力条来回一趟 */

      function landing(power) { return { x: 300 + power * 1220, y: 800 }; }

      function hud() {
        put("l1", "本局"); put("shot", Math.min(st.i + 1, shots) + " / " + shots);
        put("l2", "连击"); put("combo", st.combo > 1 ? ("×" + st.combo) : "—");
        put("l3", "得分"); put("score", st.score);
      }

      function judge(errMs) {
        var pts = errMs <= win[0] ? 3 : errMs <= win[1] ? 2 : errMs <= win[2] ? 1 : 0;
        var got = Math.round(pts * (1 + st.shotPower));
        st.score += got;
        st.combo = pts > 0 ? st.combo + 1 : 0;
        if (st.combo > st.best) st.best = st.combo;
        if (pts === 3) sfx("sfx-perfect");
        else if (pts > 0) sfx("sfx-hit");
        else sfx("sfx-wrong");
        st.pop = {
          text: pts === 3 ? "完美！" : pts === 2 ? "好" : pts === 1 ? "擦到了" : "脱靶",
          sub: got ? "+" + got : "",
          ok: pts >= 2, t: 0,
          x: st.ring ? st.ring.x : 960, y: st.ring ? st.ring.y : 800
        };
        st.ring = null;
        st.phase = "wait";
        st.wait = 0.75;
        hud();
      }

      function nextShot() {
        st.i += 1;
        if (st.i >= shots) {
          st.phase = "done";
          stop();
          /* 满分 = 每投 完美(3) × 满蓄力(2) = 6 */
          done(st.score / (shots * 6), "本局得分 " + st.score + " / " + (shots * 6));
          return;
        }
        st.phase = "ready";
        st.power = 0; st.pdir = 1;
        hud();
      }

      /* ---- 输入 ---- */
      /* 只实现「按下 / 松开」两个动作，监听由模块统一挂（见文件末尾）——
         内核自己挂监听的话，每开一局都会多留一对，旧局的处理器永远活着。 */
      function down() {
        if (st.phase === "ready") { st.phase = "charge"; return; }
        if (st.phase === "ring") {
          var over = (now() - st.ring.born) / st.ring.dur;          // 1 = 环收到中心
          judge(Math.abs(1 - over) * st.ring.dur * 1000);
        }
      }
      function up() {
        if (st.phase !== "charge") return;
        st.shotPower = Math.max(pmin, st.power);
        sfx("sfx-flip");                                   /* 出手那一声 */
        var p = landing(st.shotPower);
        var dur = slow + (fast - slow) * st.shotPower;               // 蓄得越满，环收得越快
        st.ring = { x: p.x, y: p.y, born: now(), dur: dur };
        st.phase = "ring";
      }

      /* ---- 绘制 ---- */
      function painter(dt) {
        ctx.clearRect(0, 0, W, H);

        /* 水面装饰线：只在有玩法时画 */
        if (!box.hidden) {
          ctx.save();
          ctx.globalAlpha = 0.20;
          ctx.strokeStyle = "#cfe4ef";
          ctx.lineWidth = 2;
          for (var k = 0; k < 4; k++) {
            ctx.beginPath();
            ctx.ellipse(960, 800 + k * 12, 700 - k * 130, 26 - k * 5, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }

        /* 判定环：向内收缩，越接近中心越亮 */
        if (st.phase === "ring" && st.ring) {
          var p = Math.min(1, (now() - st.ring.born) / st.ring.dur);
          var R = 260 * (1 - p);
          ctx.save();
          ctx.globalAlpha = 0.35 + 0.6 * p;
          /* 暗投影：金色的环压在同为暖色的落日水面上会糊掉，垫一层黑边才读得出 */
          ctx.shadowColor = "rgba(0,0,0,.92)";
          ctx.shadowBlur = 14;
          ctx.strokeStyle = "#ffdc9e";
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.ellipse(st.ring.x, st.ring.y, R, R * 0.42, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 0.22;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(st.ring.x, st.ring.y, R + 42, (R + 42) * 0.42, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }

        /* 蓄力条：底衬必须够沉 —— 它可能压在落日晚霞或雪面这种亮场景上 */
        if (st.phase === "charge" || st.phase === "ready") {
          var bw = 900, bh = 26, bx = (W - bw) / 2, by = 932;
          ctx.save();
          ctx.fillStyle = "rgba(12,8,6,.82)";
          rr(ctx, bx - 16, by - 16, bw + 32, bh + 32, 22); ctx.fill();
          ctx.strokeStyle = "rgba(201,168,106,.55)";
          ctx.lineWidth = 2;
          rr(ctx, bx - 16, by - 16, bw + 32, bh + 32, 22); ctx.stroke();
          ctx.fillStyle = "rgba(255,220,158,.18)";
          rr(ctx, bx, by, bw, bh, 13); ctx.fill();
          ctx.fillStyle = "#ddb284";
          rr(ctx, bx, by, Math.max(6, bw * st.power), bh, 13); ctx.fill();
          ctx.restore();
          ctx.save();
          ctx.fillStyle = "#fff6e4";
          ctx.font = "28px 'FZXiaoBiaoSong-B05S', 'Noto Serif SC', serif";
          ctx.textAlign = "center";
          ctx.shadowColor = "rgba(0,0,0,.95)";
          ctx.shadowBlur = 14;
          ctx.fillText(st.phase === "ready" ? "按住蓄力（空格或点击）" : "松开抛出 · 蓄满更难也更多分",
                       W / 2, by - 30);
          ctx.restore();
        }

        /* 命中飘字 */
        if (st.pop) {
          st.pop.t += dt;
          ctx.save();
          ctx.globalAlpha = Math.max(0, 1 - st.pop.t / 0.9);
          ctx.fillStyle = st.pop.ok ? "#ffe6ae" : "#ffb9a3";
          ctx.shadowColor = "rgba(0,0,0,.95)";
          ctx.shadowBlur = 16;
          ctx.font = "bold 54px 'FZXiaoBiaoSong-B05S', 'Noto Serif SC', serif";
          ctx.textAlign = "center";
          ctx.fillText(st.pop.text, st.pop.x, st.pop.y - 40 - st.pop.t * 60);
          if (st.pop.sub) {
            ctx.font = "bold 34px 'FZXiaoBiaoSong-B05S', 'Noto Serif SC', serif";
            ctx.fillText(st.pop.sub, st.pop.x, st.pop.y + 6 - st.pop.t * 60);
          }
          ctx.restore();
          if (st.pop.t > 0.9) st.pop = null;
        }
      }

      function now() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }

      function loop() {
        st.raf = requestAnimationFrame(loop);
        var t = now();
        var dt = st.last ? Math.min(0.05, t - st.last) : 0.016;
        st.last = t;

        if (st.phase === "charge") {
          st.power += st.pdir * dt / CHARGE_SEC;
          if (st.power >= 1) { st.power = 1; st.pdir = -1; }
          if (st.power <= 0) { st.power = 0; st.pdir = 1; }
        } else if (st.phase === "ring" && st.ring) {
          if (now() - st.ring.born >= st.ring.dur) {                 // 环收完了还没点 → 脱靶
            judge(1e9);
          }
        } else if (st.phase === "wait") {
          st.wait -= dt;
          if (st.wait <= 0) nextShot();
        }
        painter(dt);
      }

      hud();
      st.raf = requestAnimationFrame(loop);

      return {
        stop: function () {
          if (st.raf) cancelAnimationFrame(st.raf);
          st.raf = 0;
          ctx.clearRect(0, 0, W, H);
        },
        tap: down,
        release: up,
        state: function () {
          return { phase: st.phase, shot: st.i, shots: shots,
                   score: st.score, combo: st.best };
        }
      };
    }
  };

  /* ---------------------------------------------------------- 内核：rush 忙乱系 · 限时出餐
     压力是四层叠出来的：① 订单一张接一张地来，间隔还越来越短；② 每张卡有自己的倒计时；
     ③ 必须按配方顺序点料台；④ 时不时冒一张「！」干扰卡，不先点掉就让最急的一单直接作废。
     点错**不罚分**，只浪费时间 —— 忙乱是「来不及」，不是「答错了」，和项目「答错零惩罚」
     的口径一致。 */
  var rush = {
    start: function (L, done) {
      var C = CORES.rush || {}, P = L.params || {};
      var limit = P.limit || C.limit || 25;
      var spawn = P.spawn || C.spawn || 2.4;
      var cap = P.concurrent || C.concurrent || 4;
      var menu = (P.menu || []).slice();
      var recipes = P.recipes || [];
      var target = P.target || [6, 4, 2];
      var ctx = canvas.getContext("2d");
      /* 料台：底部一排格子，位置按格子数自动居中 */
      var cells = (function () {
        var n = menu.length, cw = 200, gap = 24;
        var total = n * cw + (n - 1) * gap, x0 = (W - total) / 2, out = [];
        for (var i = 0; i < n; i++) {
          out.push({ x: x0 + i * (cw + gap), y: 856, w: cw, h: 116, label: menu[i] });
        }
        return out;
      })();
      var st = {
        left: limit, n: 0, next: spawn, orders: [],
        doneCount: 0, missed: 0, combo: 0, best: 0,
        dis: null, disNext: 8, pop: null, last: 0, raf: 0
      };
      var shown = {};                       /* HUD 只在值变了才写 DOM（每帧都写很浪费） */
      function set(n, v) { if (shown[n] === v) return; shown[n] = v; put(n, v); }
      function hud() {
        set("l1", "剩余"); set("shot", Math.max(0, st.left).toFixed(1) + "s");
        set("l2", "完成"); set("combo", st.doneCount + " 单");
        set("l3", "错过"); set("score", st.missed + " 单");
      }

      function spawnOrder() {
        if (st.orders.length >= cap || !recipes.length) return;
        var r = recipes[Math.floor(Math.random() * recipes.length)];
        st.orders.push({
          steps: r.slice(), at: 0, age: 0,
          life: Math.max(3.8, 7.2 - 0.14 * st.n)      /* 越到后面给的时间越短 */
        });
        st.n += 1;
      }
      function miss() { st.missed += 1; st.combo = 0; sfx("sfx-wrong"); hud(); }
      function pop(x, y, text, ok) { st.pop = { x: x, y: y, text: text, ok: ok, t: 0 }; }

      /* 点料台：推进「最早那张、下一步正好是这个格子」的订单 */
      function hitCell(c) {
        for (var i = 0; i < st.orders.length; i++) {
          var o = st.orders[i];
          if (o.steps[o.at] !== c.label) continue;
          o.at += 1;
          st.combo += 1;
          if (st.combo > st.best) st.best = st.combo;
          if (o.at >= o.steps.length) {                 /* 出餐完成 */
            st.orders.splice(i, 1);
            st.doneCount += 1;
            sfx("sfx-hit");
            pop(c.x + c.w / 2, c.y - 20, "出餐！", true);
          }
          hud();
          return;
        }
        /* 没有订单要这一格 —— 不扣分，只给个「点空了」的反馈 */
        pop(c.x + c.w / 2, c.y - 20, "…", false);
      }
      function tap(pt) {
        if (st.dis) {                                   /* 干扰卡优先：半径内点掉它 */
          var dx = pt.x - st.dis.x, dy = pt.y - st.dis.y;
          if (dx * dx + dy * dy <= Math.pow(st.dis.r + 22, 2)) {
            pop(st.dis.x, st.dis.y - st.dis.r - 10, "搞定", true);
            sfx("sfx-click");
            st.dis = null;
            return;
          }
        }
        for (var i = 0; i < cells.length; i++) {
          var c = cells[i];
          if (pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + c.h) {
            hitCell(c); return;
          }
        }
      }

      function painter(dt) {
        ctx.clearRect(0, 0, W, H);
        /* 料台：当前有订单要用的格子高亮 —— 不然一眼扫不过来，只剩手忙脚乱 */
        var need = {};
        for (var i = 0; i < st.orders.length; i++) need[st.orders[i].steps[st.orders[i].at]] = 1;
        for (i = 0; i < cells.length; i++) {
          var c = cells[i], hot = !!need[c.label];
          ctx.save();
          ctx.fillStyle = hot ? "rgba(64,46,26,.94)" : "rgba(12,8,6,.74)";
          rr(ctx, c.x, c.y, c.w, c.h, 16); ctx.fill();
          ctx.strokeStyle = hot ? "#ffdc9e" : "rgba(201,168,106,.32)";
          ctx.lineWidth = hot ? 3 : 2;
          rr(ctx, c.x, c.y, c.w, c.h, 16); ctx.stroke();
          ctx.fillStyle = hot ? "#fff6e4" : "#bfa88c";
          ctx.font = (hot ? "bold " : "") + "34px " + FONT;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(c.label, c.x + c.w / 2, c.y + c.h / 2);
          ctx.restore();
        }
        /* 订单卡：一行排开，每张带配方进度与一条倒计时 */
        var n = st.orders.length, cw = 330, ch = 176, gap = 28;
        var total = n * cw + Math.max(0, n - 1) * gap, x0 = (W - total) / 2, y0 = 268;
        for (i = 0; i < n; i++) {
          var o = st.orders[i], x = x0 + i * (cw + gap);
          var left = Math.max(0, 1 - o.age / o.life);
          var urgent = left < 0.32;
          ctx.save();
          ctx.fillStyle = "rgba(14,9,6,.86)";
          rr(ctx, x, y0, cw, ch, 18); ctx.fill();
          ctx.strokeStyle = urgent ? "#ff8f77" : "rgba(201,168,106,.6)";
          ctx.lineWidth = urgent ? 3 : 2;
          rr(ctx, x, y0, cw, ch, 18); ctx.stroke();
          /* 倒计时：卡片底部一条，越短越红 */
          ctx.fillStyle = "rgba(255,255,255,.10)";
          rr(ctx, x + 20, y0 + ch - 26, cw - 40, 10, 5); ctx.fill();
          ctx.fillStyle = urgent ? "#ff8f77" : "#ddb284";
          rr(ctx, x + 20, y0 + ch - 26, (cw - 40) * left, 10, 5); ctx.fill();
          /* 配方：三步，做完的划掉 */
          var sw = 86, sgap = 8, sx = x + (cw - (3 * sw + 2 * sgap)) / 2;
          for (var k = 0; k < o.steps.length; k++) {
            var on = k < o.at;
            ctx.fillStyle = on ? "rgba(255,220,158,.16)" : "rgba(251,248,235,.92)";
            rr(ctx, sx, y0 + 44, sw, 62, 12); ctx.fill();
            ctx.fillStyle = on ? "rgba(255,220,158,.55)" : "#43331d";
            ctx.font = "26px " + FONT;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(o.steps[k], sx + sw / 2, y0 + 44 + 31);
            ctx.strokeStyle = on ? "rgba(255,220,158,.5)" : "rgba(138,106,66,.85)";
            ctx.lineWidth = 2;
            rr(ctx, sx, y0 + 44, sw, 62, 12); ctx.stroke();
            if (on) {                                   /* 划掉 = 这一步已经下过料 */
              ctx.beginPath();
              ctx.moveTo(sx + 12, y0 + 44 + 31);
              ctx.lineTo(sx + sw - 12, y0 + 44 + 31);
              ctx.stroke();
            }
            sx += sw + sgap;
          }
          ctx.restore();
        }
        /* 干扰卡：不点掉，最急的一单直接作废 */
        if (st.dis) {
          var d = st.dis, k2 = Math.max(0, 1 - d.age / d.life);
          ctx.save();
          ctx.fillStyle = "rgba(120,26,18,.92)";
          ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "#ffb9a3"; ctx.lineWidth = 4;
          ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = "#ffdc9e"; ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.arc(d.x, d.y, d.r + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k2);
          ctx.stroke();
          ctx.fillStyle = "#fff6e4"; ctx.font = "bold 58px " + FONT;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText("！", d.x, d.y + 2);
          ctx.restore();
        }
        if (st.pop) {
          st.pop.t += dt;
          ctx.save();
          ctx.globalAlpha = Math.max(0, 1 - st.pop.t / 0.8);
          ctx.fillStyle = st.pop.ok ? "#ffe6ae" : "#ffb9a3";
          ctx.shadowColor = "rgba(0,0,0,.95)"; ctx.shadowBlur = 14;
          ctx.font = "bold 34px " + FONT;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(st.pop.text, st.pop.x, st.pop.y - st.pop.t * 40);
          ctx.restore();
          if (st.pop.t > 0.8) st.pop = null;
        }
      }

      function now() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }

      function finish() {
        if (st.raf) cancelAnimationFrame(st.raf);
        st.raf = 0;
        done(Math.min(1, st.doneCount / (target[0] || 6)),
             "完成 " + st.doneCount + " 单 · 错过 " + st.missed + " 单");
      }

      function loop() {
        st.raf = requestAnimationFrame(loop);
        var t = now(), dt = st.last ? Math.min(0.05, t - st.last) : 0.016;
        st.last = t;
        st.left -= dt;
        if (st.left <= 0) { finish(); return; }
        st.next -= dt;
        if (st.next <= 0) { spawnOrder(); st.next = Math.max(1.3, spawn - 0.06 * st.n); }
        for (var i = st.orders.length - 1; i >= 0; i--) {
          st.orders[i].age += dt;
          if (st.orders[i].age >= st.orders[i].life) { st.orders.splice(i, 1); miss(); }
        }
        if (st.dis) {
          st.dis.age += dt;
          if (st.dis.age >= st.dis.life) {              /* 没点掉：最急的一单直接没了 */
            st.dis = null;
            if (st.orders.length) { st.orders.shift(); miss(); }
          }
        } else {
          st.disNext -= dt;
          if (st.disNext <= 0) {
            st.dis = { x: 380 + Math.random() * 1160, y: 560 + Math.random() * 150,
                       r: 54, age: 0, life: 2.6 };
            st.disNext = 8 + Math.random() * 5;
          }
        }
        if (st.pop) { st.pop.t += dt; if (st.pop.t > 0.8) st.pop = null; }
        hud();
        painter(dt);
      }

      /* 开局就摆一张单：一进来不该是空柜台，也让自动化能立刻断言「点得动」 */
      spawnOrder();
      hud();
      painter(0.016);
      st.raf = requestAnimationFrame(loop);

      return {
        stop: function () {
          if (st.raf) cancelAnimationFrame(st.raf);
          st.raf = 0;
          ctx.clearRect(0, 0, W, H);
        },
        tap: tap,
        release: function () {},                       /* 出餐是单击，没有「松开」这一步 */
        state: function () {
          var o = st.orders[0];
          return {
            phase: "play", left: Math.max(0, st.left),
            done: st.doneCount, missed: st.missed, combo: st.combo,
            orders: st.orders.length,
            need: o ? o.steps[o.at] : null,             /* 最早那单下一步要哪一格 */
            cells: cells.map(function (c) {
              return { label: c.label, x: c.x + c.w / 2, y: c.y + c.h / 2 };
            })
          };
        }
      };
    }
  };

  /* ---------------------------------------------------------- 内核：wire 解谜系 · 配对连线
     左列「词形」右列「释义」（JA 是 汉字↔假名），点左再点右：
     配上 → 一道金线把两张卡缝起来、双双落下；配错 → 两卡抖一下，不罚分。
     词对每次开局从真实词库里抽 —— 重玩不重样，玩它本身就是在背词。
     评级只看失误：全一次配对 = 1.0（S）；每错一次 −6%，托底 0.5。 */
  var wire = {
    start: function (L, done) {
      var P = L.params || {};
      var lang = P.lang === "ja" ? "ja" : "en";
      var N = Math.max(3, Math.min(6, P.pairs || 5));
      var words = pickWords(lang, N, lang === "ja"
        ? function (w) { return w.kanji && w.kana && w.kanji !== w.kana && w.kanji.indexOf("～") < 0; }
        : function (w) { return w.tier <= 2 && String(w.meaning_zh || "").length >= 2 && String(w.meaning_zh || "").length <= 14; });
      var ctx = canvas.getContext("2d");
      N = words.length;
      if (N < 3) {
        done(0, "词库凑不出足够的词对");
        return { stop: function () {}, tap: function () {}, release: function () {},
                 state: function () { return { phase: "done" }; } };
      }

      var CW = 430, CH = 96, GAP = 24;
      var totalH = N * CH + (N - 1) * GAP;
      var y0 = Math.max(330, 620 - totalH / 2);
      var LX = 330, RX = 1160;
      var left = words.map(function (w, i) {
        return { x: LX, y: y0 + i * (CH + GAP), w: CW, h: CH, word: w,
                 matched: false, shake: 0 };
      });
      var rightOrder = shuffled(words);
      var right = rightOrder.map(function (w, i) {
        return { x: RX, y: y0 + i * (CH + GAP), w: CW, h: CH, word: w,
                 matched: false, shake: 0 };
      });
      var st = { sel: -1, matched: 0, wrong: 0, combo: 0, best: 0,
                 parts: [], lines: [], over: 0, last: 0, raf: 0 };

      function hud() {
        put("l1", "配对"); put("shot", st.matched + " / " + N);
        put("l2", "连击"); put("combo", st.combo > 1 ? ("×" + st.combo) : "—");
        put("l3", "失误"); put("score", String(st.wrong));
      }

      function hitCard(list, pt) {
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          if (!c.matched && pt.x >= c.x && pt.x <= c.x + c.w &&
              pt.y >= c.y && pt.y <= c.y + c.h) return i;
        }
        return -1;
      }

      function tap(pt) {
        if (st.over) return;
        var li = hitCard(left, pt);
        if (li >= 0) { st.sel = (st.sel === li) ? -1 : li; return; }
        var ri = hitCard(right, pt);
        if (ri < 0) return;
        if (st.sel < 0) return;
        var lc = left[st.sel], rc = right[ri];
        st.sel = -1;
        if (lc.word.id === rc.word.id) {
          lc.matched = rc.matched = true;
          st.matched += 1;
          st.combo += 1;
          if (st.combo > st.best) st.best = st.combo;
          st.lines.push({ a: lc, b: rc, t: 0 });
          burst(st, rc.x + rc.w / 2, rc.y + rc.h / 2, 14);
          sfx("sfx-hit");
          if (st.matched >= N) {
            st.over = 1;
            setTimeout(function () {
              stop();
              done(Math.max(0.5, 1 - st.wrong * 0.06),
                   "配对 " + N + " 组 · 失误 " + st.wrong + " 次");
            }, 850);
          }
        } else {
          st.wrong += 1;
          st.combo = 0;
          lc.shake = rc.shake = 0.42;
          sfx("sfx-wrong");
        }
        hud();
      }

      function painter(dt) {
        ctx.clearRect(0, 0, W, H);
        /* 列头 */
        ctx.save();
        ctx.fillStyle = "rgba(255,246,228,.85)";
        ctx.font = "bold 30px " + FONT;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = 10;
        ctx.fillText(lang === "ja" ? "汉 字" : "单 词", LX + CW / 2, y0 - 44);
        ctx.fillText(lang === "ja" ? "假 名" : "释 义", RX + CW / 2, y0 - 44);
        ctx.restore();

        /* 已配对的连线：金色墨线，画出时 0.35s 长出来 */
        st.lines.forEach(function (ln) {
          if (ln.t < 1) ln.t = Math.min(1, ln.t + dt / 0.35);
          var ax = ln.a.x + ln.a.w, ay = ln.a.y + ln.a.h / 2;
          var bx = ln.b.x, by = ln.b.y + ln.b.h / 2;
          var mx = (ax + bx) / 2;
          ctx.save();
          ctx.globalAlpha = 0.9 * ln.t;
          ctx.strokeStyle = "#ffdc9e";
          ctx.lineWidth = 4;
          ctx.shadowColor = "rgba(255,200,120,.9)"; ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(ax + (mx - ax) * 2 * ln.t, ay, ax + (bx - ax) * ln.t, ay + (by - ay) * ln.t);
          ctx.stroke();
          ctx.restore();
        });

        function drawCard(c, side) {
          var sx = 0;
          if (c.shake > 0) { c.shake -= dt; sx = Math.sin(c.shake * 60) * 9 * (c.shake / 0.42); }
          var sel = side === "l" && left[st.sel] === c;
          ctx.save();
          ctx.translate(sx, 0);
          ctx.fillStyle = c.matched ? "rgba(30,22,14,.55)" : "rgba(16,10,7,.86)";
          rr(ctx, c.x, c.y, c.w, c.h, 16); ctx.fill();
          ctx.strokeStyle = c.matched ? "rgba(201,168,106,.30)"
                          : sel ? "#ffdc9e" : "rgba(201,168,106,.55)";
          ctx.lineWidth = sel ? 4 : 2;
          rr(ctx, c.x, c.y, c.w, c.h, 16); ctx.stroke();
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = c.matched ? "rgba(232,217,188,.35)" : "#fff6e4";
          var txt = side === "l" ? wordForm(c.word)
                  : (lang === "ja" ? c.word.kana : c.word.meaning_zh);
          ctx.font = (side === "l" ? "bold 40px " : "bold 34px ") + FONT;
          ctx.shadowColor = "rgba(0,0,0,.9)"; ctx.shadowBlur = 8;
          ctx.fillText(txt, c.x + c.w / 2, c.y + c.h / 2);
          if (c.matched) {
            ctx.shadowBlur = 0;
            ctx.fillStyle = "rgba(255,220,158,.75)";
            ctx.font = "bold 30px " + FONT;
            ctx.fillText("✓", c.x + c.w - 34, c.y + c.h / 2);
          }
          ctx.restore();
        }
        left.forEach(function (c) { drawCard(c, "l"); });
        right.forEach(function (c) { drawCard(c, "r"); });
        drawParts(ctx, st, dt);
      }

      function now() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }
      function loop() {
        st.raf = requestAnimationFrame(loop);
        var t = now();
        var dt = st.last ? Math.min(0.05, t - st.last) : 0.016;
        st.last = t;
        painter(dt);
      }
      hud();
      st.raf = requestAnimationFrame(loop);
      function stop() {
        if (st.raf) cancelAnimationFrame(st.raf);
        st.raf = 0;
        ctx.clearRect(0, 0, W, H);
      }
      return {
        stop: stop,
        tap: tap,
        release: function () {},
        state: function () {
          return { phase: st.over ? "done" : "play", pairs: N,
                   matched: st.matched, wrong: st.wrong, sel: st.sel };
        }
      };
    }
  };

  /* ---------------------------------------------------------- 内核：order 语序系 · 拼句
     一句目标语被拆成词块打乱铺开，点词块按正确语序拼回上方答案行；
     放错可以点答案行里的块退回重来（不罚分，只记一次失误影响评级）。
     JA 的句子由关卡 params.sentences 显式给 tokens（助词位置最能暴露语感）；
     EN 默认从词库例句自动切词 —— 例句本身就是配套写好的，切词零成本。 */
  var order = {
    start: function (L, done) {
      var P = L.params || {};
      var lang = P.lang === "ja" ? "ja" : "en";
      var COUNT = Math.max(2, Math.min(5, P.count || 3));
      var sentences;
      if (P.sentences && P.sentences.length) {
        sentences = shuffled(P.sentences).slice(0, COUNT).map(function (s) {
          return { tokens: s.tokens || String(s.t || "").split(" "),
                   zh: s.zh || "", hint: s.hint || "" };
        });
      } else {
        sentences = shuffled(wordPool("en").filter(function (w) {
          if (w.tier > 2 || !w.example || !w.example.t) return false;
          var n = w.example.t.split(" ").length;
          return n >= 4 && n <= 9;
        })).slice(0, COUNT).map(function (w) {
          return { tokens: w.example.t.split(" "), zh: w.example.zh, hint: "" };
        });
      }
      if (!sentences.length) {
        done(0, "没有可用的句子");
        return { stop: function () {}, tap: function () {}, release: function () {},
                 state: function () { return { phase: "done" }; } };
      }

      var ctx = canvas.getContext("2d");
      var st = { i: 0, right: 0, mistakes: 0, parts: [], shake: 0, over: 0,
                 cur: null, last: 0, raf: 0, sfxOk: 0 };

      function setupSentence() {
        var s = sentences[st.i];
        st.cur = { s: s, blocks: shuffled(s.tokens.map(function (t, k) { return { t: t, k: k }; })),
                   placed: [] };
      }
      /* 命中区域与绘制必须用同一把尺子：先把字体钉死再 measureText，
         否则点选判定用的是上一帧残留的字体宽度，块越宽偏得越远。 */
      function layoutRow(list, y) {
        ctx.font = "bold 34px " + FONT;
        /* 居中排一行词块，返回每块的矩形 */
        var ws = list.map(function (b) {
          return Math.max(96, Math.min(320, ctx.measureText(b.t).width + 56));
        });
        var total = ws.reduce(function (a, b) { return a + b; }, 0) + (list.length - 1) * 18;
        var x = (W - total) / 2, out = [];
        for (var i = 0; i < list.length; i++) {
          out.push({ t: list[i].t, k: list[i].k, x: x, y: y, w: ws[i], h: 76 });
          x += ws[i] + 18;
        }
        return out;
      }

      function hud() {
        put("l1", "句子"); put("shot", Math.min(st.i + 1, sentences.length) + " / " + sentences.length);
        put("l2", "已放"); put("combo", st.cur.placed.length + " / " + st.cur.s.tokens.length);
        put("l3", "失误"); put("score", String(st.mistakes));
      }

      function tap(pt) {
        if (st.over || !st.cur) return;
        /* 点词块池：放入答案行（从池里找最上面命中的） */
        var poolRow = layoutRow(st.cur.blocks, 760);
        for (var i = 0; i < poolRow.length; i++) {
          var r = poolRow[i];
          if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) {
            var b = st.cur.blocks.splice(i, 1)[0];
            st.cur.placed.push(b);
            sfx("sfx-click");
            hud();
            check();
            return;
          }
        }
        /* 点答案行：退回词块池（放错了随时反悔，反悔不记失误） */
        var ansRow = layoutRow(st.cur.placed, 470);
        for (i = 0; i < ansRow.length; i++) {
          r = ansRow[i];
          if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) {
            var k = st.cur.placed.splice(i, 1)[0];
            st.cur.blocks.push(k);
            sfx("sfx-click");
            hud();
            return;
          }
        }
      }

      function check() {
        var c = st.cur;
        if (c.placed.length !== c.s.tokens.length) return;
        var ok = true;
        for (var i = 0; i < c.s.tokens.length; i++) {
          if (c.placed[i].t !== c.s.tokens[i]) { ok = false; break; }
        }
        if (ok) {
          st.right += 1;
          sfx("sfx-right");
          var ansRow = layoutRow(c.placed, 470);
          ansRow.forEach(function (r) { burst(st, r.x + r.w / 2, r.y + r.h / 2, 7); });
          st.i += 1;
          if (st.i >= sentences.length) {
            st.over = 1;
            setTimeout(function () {
              stop();
              done(Math.max(0.5, st.right / sentences.length * (1 - st.mistakes * 0.08)),
                   "拼对 " + st.right + " / " + sentences.length + " 句 · 失误 " + st.mistakes + " 次");
            }, 900);
          } else {
            setupSentence();
          }
        } else {
          st.mistakes += 1;
          st.shake = 0.45;
          sfx("sfx-wrong");
        }
        hud();
      }

      function painter(dt) {
        ctx.clearRect(0, 0, W, H);
        var c = st.cur;
        if (!c) { drawParts(ctx, st, dt); return; }
        /* 题干：中文意思 + 语法提示 */
        ctx.save();
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff6e4";
        ctx.shadowColor = "rgba(0,0,0,.92)"; ctx.shadowBlur = 14;
        ctx.font = "bold 44px " + FONT;
        ctx.fillText("「 " + c.s.zh + " 」", W / 2, 288);
        if (c.s.hint) {
          ctx.font = "28px " + FONT;
          ctx.fillStyle = "rgba(232,217,188,.85)";
          ctx.fillText(c.s.hint, W / 2, 348);
        }
        ctx.restore();
        var shx = 0;
        if (st.shake > 0) { st.shake -= dt; shx = Math.sin(st.shake * 70) * 10 * (st.shake / 0.45); }
        /* 答案行：一排空槽位 + 已放的块（槽宽与块宽用同一把钉死的字体量） */
        ctx.save();
        ctx.translate(shx, 0);
        ctx.font = "bold 34px " + FONT;
        var ansRow = layoutRow(c.placed, 470);
        var slotW = Math.max.apply(null, c.s.tokens.map(function (t) {
          return Math.max(96, Math.min(320, ctx.measureText(t).width + 56));
        }));
        var n = c.s.tokens.length;
        var slotsTotal = n * slotW + (n - 1) * 18;
        var sx0 = (W - slotsTotal) / 2;
        for (var i = 0; i < n; i++) {
          var filled = ansRow[i];
          var x = sx0 + i * (slotW + 18);
          ctx.fillStyle = "rgba(255,220,158,.08)";
          rr(ctx, x, 432, slotW, 76, 14); ctx.fill();
          ctx.strokeStyle = "rgba(201,168,106,.4)";
          ctx.lineWidth = 2;
          rr(ctx, x, 432, slotW, 76, 14); ctx.stroke();
          if (filled) {
            ctx.fillStyle = "rgba(64,46,26,.94)";
            rr(ctx, filled.x, filled.y, filled.w, filled.h, 14); ctx.fill();
            ctx.strokeStyle = "#ffdc9e"; ctx.lineWidth = 3;
            rr(ctx, filled.x, filled.y, filled.w, filled.h, 14); ctx.stroke();
            ctx.fillStyle = "#fff6e4";
            ctx.font = "bold 34px " + FONT;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(filled.t, filled.x + filled.w / 2, filled.y + filled.h / 2);
          }
        }
        ctx.restore();
        /* 词块池 */
        var poolRow = layoutRow(c.blocks, 760);
        poolRow.forEach(function (r) {
          ctx.fillStyle = "rgba(16,10,7,.86)";
          rr(ctx, r.x, r.y, r.w, r.h, 14); ctx.fill();
          ctx.strokeStyle = "rgba(201,168,106,.6)";
          ctx.lineWidth = 2;
          rr(ctx, r.x, r.y, r.w, r.h, 14); ctx.stroke();
          ctx.fillStyle = "#f2e6cd";
          ctx.font = "bold 34px " + FONT;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(r.t, r.x + r.w / 2, r.y + r.h / 2);
        });
        if (!c.blocks.length && !st.over) {
          ctx.save();
          ctx.textAlign = "center";
          ctx.fillStyle = "rgba(232,217,188,.7)";
          ctx.font = "26px " + FONT;
          ctx.fillText("点答案行里的词块可以退回", W / 2, 566);
          ctx.restore();
        }
        drawParts(ctx, st, dt);
      }

      function now() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }
      function loop() {
        st.raf = requestAnimationFrame(loop);
        var t = now();
        var dt = st.last ? Math.min(0.05, t - st.last) : 0.016;
        st.last = t;
        painter(dt);
      }
      setupSentence();
      hud();
      st.raf = requestAnimationFrame(loop);
      function stop() {
        if (st.raf) cancelAnimationFrame(st.raf);
        st.raf = 0;
        ctx.clearRect(0, 0, W, H);
      }
      return {
        stop: stop,
        tap: tap,
        release: function () {},
        state: function () {
          return { phase: st.over ? "done" : "play", index: st.i, total: sentences.length,
                   placed: st.cur ? st.cur.placed.length : 0,
                   need: st.cur ? st.cur.s.tokens.length : 0,
                   right: st.right, wrong: st.mistakes };
        }
      };
    }
  };

  /* ---------------------------------------------------------- 内核：hunt 沉浸系 · 场景寻物
     房间场景图上飘着一圈目标语浮标（JA 汉字+假名、EN 单词），上方提示中文：
     「找出 —— 水」。玩家要**读**这些浮标才能找到对的那一个 —— 是在场景里
     做阅读题，也是方案里 p3_scene_hunt 的落地。找错抖一下不罚分，评级看认错次数。
     每换一个目标，浮标会轻声念一遍那个词（有 TTS 时）—— 听音也是练。 */
  var hunt = {
    start: function (L, done) {
      var P = L.params || {};
      var lang = P.lang === "ja" ? "ja" : "en";
      var N = Math.max(3, Math.min(8, P.count || 6));
      var words = pickWords(lang, N, function (w) {
        var f = wordForm(w);
        return f && f.length <= 8 && f.indexOf("～") < 0 &&
               String(w.meaning_zh || "").length >= 1 &&
               String(w.meaning_zh || "").length <= 12 &&
               (w.tier || 1) <= 3;
      });
      N = words.length;
      if (N < 3) {
        done(0, "词库凑不出足够的词");
        return { stop: function () {}, tap: function () {}, release: function () {},
                 state: function () { return { phase: "done" }; } };
      }
      var ctx = canvas.getContext("2d");
      var POS = (P.positions && P.positions.length >= N) ? P.positions : [
        [200, 440], [610, 500], [1010, 430], [1420, 480], [1720, 420],
        [320, 660], [760, 720], [1180, 680], [1600, 700],
        [500, 880], [980, 900], [1440, 860]
      ];
      var tags = words.map(function (w, i) {
        return { w: w, x: POS[i][0], y: POS[i][1], taken: false, shake: 0,
                 ph: Math.random() * Math.PI * 2 };
      });
      var st = { k: 0, wrong: 0, combo: 0, best: 0, parts: [], order: shuffled(tags.map(function (_, i) { return i; })),
                 over: 0, last: 0, raf: 0 };

      function target() { return tags[st.order[st.k]]; }
      function speakTarget() {
        var w = target().w;
        if (window.MomoQuiz && MomoQuiz.ttsOk()) MomoQuiz.speak(w.kana || w.lemma, lang);
      }

      function hud() {
        put("l1", "找到"); put("shot", st.k + " / " + N);
        put("l2", "连击"); put("combo", st.combo > 1 ? ("×" + st.combo) : "—");
        put("l3", "认错"); put("score", String(st.wrong));
      }

      function tagBox(t) {
        return { x: t.x - 130, y: t.y - 52, w: 260, h: 104 };
      }

      function tap(pt) {
        if (st.over) return;
        for (var i = 0; i < tags.length; i++) {
          var t = tags[i];
          if (t.taken) continue;
          var b = tagBox(t);
          if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) {
            if (t === target()) {
              t.taken = true;
              st.k += 1;
              st.combo += 1;
              if (st.combo > st.best) st.best = st.combo;
              burst(st, t.x, t.y, 16);
              sfx("sfx-right");
              if (st.k >= N) {
                st.over = 1;
                setTimeout(function () {
                  stop();
                  done(Math.max(0.5, 1 - st.wrong * 0.05),
                       "找到 " + N + " 个 · 认错 " + st.wrong + " 次");
                }, 800);
              } else {
                speakTarget();
              }
            } else {
              st.wrong += 1;
              st.combo = 0;
              t.shake = 0.42;
              sfx("sfx-wrong");
            }
            hud();
            return;
          }
        }
      }

      function painter(dt, t) {
        ctx.clearRect(0, 0, W, H);
        /* 提示卡：找 出 —— 中文（全部找完后的收尾帧里 target 为空，只画粒子） */
        var tg = target();
        if (tg) {
          ctx.save();
          ctx.fillStyle = "rgba(12,8,6,.88)";
          rr(ctx, W / 2 - 380, 224, 760, 118, 20); ctx.fill();
          ctx.strokeStyle = "#ffdc9e"; ctx.lineWidth = 3;
          rr(ctx, W / 2 - 380, 224, 760, 118, 20); ctx.stroke();
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = "#fff6e4";
          ctx.font = "bold 46px " + FONT;
          ctx.shadowColor = "rgba(0,0,0,.9)"; ctx.shadowBlur = 12;
          ctx.fillText("找 出 —— " + tg.w.meaning_zh, W / 2, 284);
          ctx.restore();
        }

        tags.forEach(function (t2) {
          if (t2.taken) return;
          var fy = Math.sin(t * 1.6 + t2.ph) * 7;
          var sx = 0;
          if (t2.shake > 0) { t2.shake -= dt; sx = Math.sin(t2.shake * 60) * 10 * (t2.shake / 0.42); }
          var b = tagBox(t2);
          ctx.save();
          ctx.translate(sx, fy);
          /* 所有浮标一律同款 —— 这是个阅读题：玩家必须逐个读浮标上的词才能
             找到对的那一个，谁也不许靠发光作弊。亮度只随呼吸微微起伏。 */
          var glow = 0.5 + 0.5 * Math.sin(t * 2.2 + t2.ph);
          ctx.fillStyle = "rgba(12,8,6," + (0.70 + glow * 0.08) + ")";
          rr(ctx, b.x, b.y, b.w, b.h, 18); ctx.fill();
          ctx.strokeStyle = "rgba(201,168,106," + (0.42 + glow * 0.22) + ")";
          ctx.lineWidth = 2.5;
          rr(ctx, b.x, b.y, b.w, b.h, 18); ctx.stroke();
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = "#fff6e4";
          ctx.shadowColor = "rgba(0,0,0,.9)"; ctx.shadowBlur = 10;
          ctx.font = "bold 42px " + FONT;
          ctx.fillText(wordForm(t2.w), b.x + b.w / 2, b.y + (lang === "ja" ? 38 : 52));
          if (lang === "ja" && t2.w.kana && t2.w.kana !== t2.w.kanji) {
            ctx.font = "24px " + FONT;
            ctx.fillStyle = "rgba(232,217,188,.9)";
            ctx.fillText(t2.w.kana, b.x + b.w / 2, b.y + 78);
          }
          ctx.restore();
        });
        drawParts(ctx, st, dt);
      }

      function now() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }
      function loop() {
        st.raf = requestAnimationFrame(loop);
        var t = now();
        var dt = st.last ? Math.min(0.05, t - st.last) : 0.016;
        st.last = t;
        painter(dt, t);
      }
      hud();
      speakTarget();
      st.raf = requestAnimationFrame(loop);
      function stop() {
        if (st.raf) cancelAnimationFrame(st.raf);
        st.raf = 0;
        ctx.clearRect(0, 0, W, H);
      }
      return {
        stop: stop,
        tap: tap,
        release: function () {},
        state: function () {
          return { phase: st.over ? "done" : "play", found: st.k, total: N,
                   wrong: st.wrong, need: target() ? target().w.meaning_zh : "" };
        }
      };
    }
  };

  var RUNNERS = { skim: skim, rush: rush, wire: wire, order: order, hunt: hunt };

  /* ---------------------------------------------------------- 进屏 / 退屏 */

  function paintBg(room) {
    var url = null;
    if (window.MomoScene) {
      var file = MomoScene.resolve(MomoScene.namesOf(room), MomoScene.period());
      url = file ? MomoScene.uri(file) : null;
    }
    bg.style.backgroundImage = url ? 'url("' + url + '")' : "none";
  }

  function open() {
    close();                       /* 上一局可能还在跑：先停掉，否则会留下一直画的孤儿 rAF */
    var p = curPlace(), L = levelOf(p);
    res.hidden = true;
    canvas.getContext("2d").clearRect(0, 0, W, H);
    paintBg(p.room);
    put("place", p.room);
    if (!L) {
      box.hidden = true;
      empty.hidden = false;
      put("empty-tip", "「" + p.room + "」的小游戏还在做，先回去学习吧。");
      return;
    }
    empty.hidden = true;
    box.hidden = false;
    var q = quota();
    put("title", L.title || p.room);
    put("hint", L.hint || "");
    put("quota", q.used[p.key] ? "今天已结算" : ("今天还剩 " + Math.max(0, MAX_PER_DAY - q.total) + " 次"));
    var runner = RUNNERS[L.core] || skim;
    run = runner.start(L, function (ratio, detail) {
      run = null;
      settle(ratio, detail);
    });
  }

  function close() {
    if (run) { run.stop(); run = null; }
  }

  function onShow(e) {
    if (!e.detail) return;
    if (e.detail.screen === SCR) open();
    else if (e.detail.screen === "主画面") {
      close();
      if (pending) {
        if (!window.MomoDirector || MomoDirector.isPlaying()) return;   // 忙就先留着
        var nodes = pending.lines.map(function (l) {
          return l.text ? { type: "say", text: l.text, expr: l.expr }
                        : { type: "expr", name: l.expr, hold: 900 };
        });
        nodes.push({ type: "end" });
        pending = null;
        MomoDirector.playNodes(nodes);
      }
    } else {
      close();
    }
  }
  document.addEventListener("momo:show", onShow);

  /* 重开一局 / 返回 */
  var again = scr.querySelector('[data-act="again"]');
  if (again) again.addEventListener("click", function (e) { e.stopPropagation(); open(); });

  /* 已经在小游戏屏（开发导航直接进来）时补一次 */
  if (scr.classList.contains("active")) open();

  /* ---------------------------------------------------------- 输入：统一挂一次，转发给当前这一局
     内核不自己挂监听 —— 那样每开一局就会多留一对，旧局的处理器会一直活着，
     甚至可能在已经结算过之后再结算一次。 */
  function toStage(e) {
    var r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
  }
  /* 「正在玩」＝这一局在跑、结算面板没开着、玩法区是显示的。
     注意 res.hidden===true 才是正常游戏中（面板关着），别写反。 */
  function playing() { return !!run && res.hidden && !box.hidden; }
  var taps = 0, lastTap = null;        /* 供自动化验证：输入确实穿过了这一层 */
  scr.addEventListener("pointerdown", function (e) {
    if (!playing()) return;
    /* 结算面板开着、或点在按钮/出口上，都不算「玩」的那一下 */
    if (e.target.closest(".layer.btn") || e.target.closest("button")) return;
    e.preventDefault();
    taps += 1;
    lastTap = toStage(e);
    run.tap(lastTap);
  });
  scr.addEventListener("pointerup", function () {
    if (playing() && run.release) run.release();
  });
  document.addEventListener("keydown", function (e) {
    /* 空格＝在任意位置按一下：打水漂用得上；出餐是点格子的，空格点不中任何东西 */
    if (e.code !== "Space" || e.repeat || !playing()) return;
    if (!scr.classList.contains("active")) return;
    e.preventDefault();
    run.tap({ x: -1, y: -1 });
  });
  document.addEventListener("keyup", function (e) {
    if (e.code !== "Space" || !playing()) return;
    if (run.release) run.release();
  });

  /* ---------------------------------------------------------- 供自动化验证 */
  window.MomoMinigame = {
    MAX_PER_DAY: MAX_PER_DAY,
    key: function () { return curPlace().key; },
    level: function () { return levelOf(curPlace()); },
    playable: function () { return playable(curPlace()); },
    /* 不发钱的那部分只给测试用：跳到指定地点、或直接结算一个评级 */
    debugGoto: function (floor, room) {
      STORE.state.floor = floor;
      STORE.state.room = room;
      STORE.save();
      return curPlace().key;
    },
    debugPlay: function (opt) {
      opt = opt || {};
      if (opt.floor && opt.room) this.debugGoto(opt.floor, opt.room);
      var p = curPlace(), L = levelOf(p);
      if (!L) return { ok: false, reason: "no-level", key: p.key };
      var grade = opt.grade || "S";
      var coins = coinsOf(L, grade);
      var got = award(p.key, coins);
      return { ok: true, key: p.key, core: L.core, grade: grade,
               coins: got, want: coins };
    },
    state: function () {
      var p = curPlace(), L = levelOf(p), q = quota();
      return {
        key: p.key, room: p.room, floor: p.floor,
        core: L ? L.core : null, title: L ? L.title : null,
        playable: !!L,
        playing: !!run,
        taps: taps, lastTap: lastTap,
        run: run && run.state ? run.state() : null,
        used: q.used[p.key] || 0, total: q.total,
        pending: !!pending
      };
    }
  };
})();