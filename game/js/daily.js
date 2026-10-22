/* 墨墨 · 日循环（daily.js）
   经济系统里所有「按天发生」的事情都收在这一个文件里，一次做完：

     ① 日切（以 05:00 为界）与进游戏结算
     ② 时段在线奖励 —— 监测到该时段玩家在线就发（当天每段只发一次）
     ③ 物资日耗（12/天）+ 死亡判定（物资归零 / 连续缺席超过宽限天数）
     ④ 日结算奖励（当天准确率 ≥90% → 货币 +50 · 心情 +8 · 好感 +3；三段全清 → 好感 +2）
     ⑤ 连勤（连续 7 天不缺席 → 货币 +1000 · 好感 +10）

   数值一个都不写死：全部从 game/content/lessons.json 的 economy / clock 读。
   死亡 → 多周目：好感与心情归零、开场重演；学习进度与已解锁的服装 / CG 保留（§8）。

   为什么不是「按在线时长」结算：学生不可能一直挂着页面。物资按真实自然日差一次性扣，
   日切点定在 05:00（凌晨 1 点还在「夜晚」里，不该被算成新的一天）。 */
(function () {
  "use strict";
  var STORE = window.MomoStore;
  var LESSONS = (window.MOMO_DATA || {}).lessons || {};
  var ECON = LESSONS.economy || {};
  var CLOCK = LESSONS.clock || {};
  var G = ECON.currency_gain || {};
  if (!STORE || !G.slot_online) return;

  var SUP = ECON.supply || {};
  var MOOD = ECON.mood || {};
  var AFF = ECON.affection || {};

  var SLOT_ONLINE = G.slot_online;
  var HIGH_ACC = G.daily_high_accuracy || 0;
  var WEEK_STREAK = G.week_streak || 0;
  var UPKEEP = SUP.daily_upkeep || 0;
  var START = SUP.start || 0;
  var DEATH_AT = SUP.death_threshold || 0;
  var GRACE = (ECON.absence && ECON.absence.grace_days) ||
              (CLOCK.absence && CLOCK.absence.grace_days) || 7;
  /* 「考好了」与「没考好」两条线都用夜晚时段声明的阈值：90% 是 bonus、70% 是 pass。
     中间那段（70~90%）无奖惩 —— 不要让「还行」也挨罚。 */
  var NIGHT_SETTLE = ((LESSONS.slots || {})["夜晚"] || {}).settle || {};
  var HIGH_RATE = NIGHT_SETTLE.bonus_accuracy || 0.9;
  var PASS_RATE = NIGHT_SETTLE.pass_accuracy || 0.7;
  var TICK = 60000;

  /* ---------------- 日期（05:00 日切） ---------------- */
  function hhmm(s) {
    var t = String(s || "").split(":");
    return (+t[0] || 0) * 60 + (+t[1] || 0);
  }
  var ROLL_MIN = hhmm(CLOCK.day_rollover || "05:00");
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function dayKey(d) {
    d = d || new Date();
    var t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (d.getHours() * 60 + d.getMinutes() < ROLL_MIN) t.setDate(t.getDate() - 1);
    return "" + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate());
  }
  function msOf(k) { return new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8)).getTime(); }
  function gapDays(a, b) { return Math.round((msOf(b) - msOf(a)) / 86400000); }

  /* ---------------- 当前时段 ---------------- */
  /* 区间从 lessons.json 读（清晨 05–11 / 午后 11–18 / 夜晚 18–05）。
     夜晚跨零点，所以 from > to 时按「或」判。 */
  var SLOTS = ["清晨", "午后", "夜晚"];
  function inRange(min, from, to) {
    var a = hhmm(from), b = hhmm(to);
    return a <= b ? (min >= a && min < b) : (min >= a || min < b);
  }
  function slotNow() {
    var cfg = CLOCK.slots || {};
    var d = new Date(), min = d.getHours() * 60 + d.getMinutes();
    for (var i = 0; i < SLOTS.length; i++) {
      var r = cfg[SLOTS[i]];
      if (r && inRange(min, r.from, r.to)) return SLOTS[i];
    }
    return SLOTS[SLOTS.length - 1];
  }

  /* ---------------- 存档里的日循环字段 ---------------- */
  function daily() {
    var d = STORE.state.daily;
    if (!d) d = STORE.state.daily = {};
    if (!d.slots) d.slots = {};
    SLOTS.forEach(function (k) { if (typeof d.slots[k] !== "boolean") d.slots[k] = false; });
    if (typeof d.day !== "string") d.day = "";
    if (typeof d.quiz_total !== "number") d.quiz_total = 0;
    if (typeof d.quiz_right !== "number") d.quiz_right = 0;
    if (typeof d.streak !== "number") d.streak = 0;
    return d;
  }
  /* 练习判分时由 learn.js 叫一下，累计「当天准确率」的分子分母 */
  function noteQuiz(ok) {
    var d = daily();
    d.quiz_total += 1;
    if (ok) d.quiz_right += 1;
    STORE.save();
  }
  /* 新的一天 / 新周目：把「按天算」的东西一次性归零 —— 三段在线奖励，以及地点小游戏的配额 */
  function clearSlots(d) {
    SLOTS.forEach(function (k) { d.slots[k] = false; });
    d.mini = { day: d.day || "", used: {}, total: 0 };
  }

  /* ---------------- 日切 + 上一次在线的结算 ----------------
     返回 null = 今天已经结过；否则返回一份「昨天发生了什么」的账单。 */
  function rollover() {
    var d = daily(), today = dayKey();
    /* 第一次进游戏：只把日子记下，没有「昨天」可结算 —— 否则开场就被弹一脸账单 */
    if (!d.day) { d.day = today; d.streak = 1; d.total_days = (d.total_days || 0) + 1; STORE.save(); return null; }
    if (d.day === today) return null;

    var gap = gapDays(d.day, today);
    var rep = { gap: gap, lines: [], death: "" };

    if (gap > GRACE) {
      rep.death = "absence";
      rep.lines.push("她已经 " + gap + " 天没有等到你了。");
    } else {
      /* ① 上次在线那天的准确率 */
      var right = d.quiz_right, total = d.quiz_total;
      if (total > 0) {
        var acc = right / total;
        var head = "准确率 " + Math.round(acc * 100) + "%（" + right + "/" + total + "）";
        if (acc >= HIGH_RATE) {
          STORE.earn(HIGH_ACC, "onetime");
          STORE.apply({ mood: MOOD.daily_high_accuracy || 0,
                        affection: AFF.daily_high_accuracy || 0 });
          rep.lines.push(head + "　货币 +" + HIGH_ACC +
                         " · 心情 +" + (MOOD.daily_high_accuracy || 0) +
                         " · 好感 +" + (AFF.daily_high_accuracy || 0));
        } else if (acc < PASS_RATE && MOOD.daily_low_accuracy) {
          STORE.apply({ mood: MOOD.daily_low_accuracy });
          rep.lines.push(head + "　心情 " + MOOD.daily_low_accuracy);
        } else {
          rep.lines.push(head + "　无奖惩");
        }
      }
      /* ② 三段全清 */
      if (d.slots["清晨"] && d.slots["午后"] && d.slots["夜晚"] && AFF.slot_clear_all) {
        STORE.apply({ affection: AFF.slot_clear_all });
        rep.lines.push("三段都在线　好感 +" + AFF.slot_clear_all);
      }
      /* ③ 连勤 */
      d.streak = (gap === 1) ? d.streak + 1 : 1;
      if (d.streak >= 7 && WEEK_STREAK) {
        STORE.earn(WEEK_STREAK, "onetime");
        if (AFF.week_streak) STORE.apply({ affection: AFF.week_streak });
        rep.lines.push("连续 7 天没缺席　货币 +" + WEEK_STREAK + " · 好感 +" + (AFF.week_streak || 0));
        d.streak = 0;
      }
      /* ④ 物资：按真实日差一次性扣，不是按在线时长 */
      var used = UPKEEP * gap;
      if (used) {
        var before = Math.round(STORE.state.supplies);
        STORE.apply({ supplies: -used });
        rep.lines.push("物资 −" + used + "（" + before + " → " +
                       Math.round(STORE.state.supplies) + "）　过了 " + gap + " 天");
        if (STORE.state.supplies <= DEATH_AT) {
          rep.death = "supplies";
          rep.lines.push("物资见底了。");
        }
      }
    }

    d.day = today;
    d.total_days = (d.total_days || 0) + 1;   /* 陪伴天数（章节门槛用）：只增不减，缺席/死亡都不清 */
    clearSlots(d);
    d.quiz_total = 0;
    d.quiz_right = 0;
    STORE.save();
    return rep;
  }

  /* ---------------- 时段在线奖励 ---------------- */
  function awardSlot() {
    var d = daily();
    /* 还没真的进过游戏（或跨日还没结算）就不发 —— 开屏挂一天不算「在线」 */
    if (!d.day || d.day !== dayKey()) return false;
    var s = slotNow();
    if (d.slots[s]) return false;
    d.slots[s] = true;
    STORE.save();
    STORE.earn(SLOT_ONLINE, "learn");
    /* 开场剧情正演着就不弹提示：那句旁白条也在屏幕下方，会撞在一起 */
    if (!(window.MomoDirector && window.MomoDirector.isPlaying())) {
      toast("「" + s + "」时段在线　货币 +" + SLOT_ONLINE, true);
      if (window.MomoAudio) MomoAudio.sfx("sfx-award");
    }
    document.dispatchEvent(new CustomEvent("momo:slot", { detail: { slot: s } }));
    return true;
  }

  /* 「在线」= 不在开屏。定时器是不认屏幕的，不加这道闸，把页面开在标题页挂一晚
     也会白拿三段在线奖励、还平白记一天出勤 —— 那就不是「上线学习」了。 */
  function inGame() {
    var a = document.querySelector(".screen.active");
    return !!a && a.dataset.screen !== "开屏";
  }

  function tick() {
    if (!inGame()) return;
    var rep = rollover();
    if (rep) {
      if (rep.death) { showDeath(rep); return; }
      if (rep.lines.length) showSettle(rep);
    }
    awardSlot();
  }

  /* ---------------- 多周目 ---------------- */
  function revive() {
    var st = STORE.state, d = daily();
    /* 数值一律走 apply（它负责夹取与广播），这里只送「差多少」 */
    STORE.apply({ supplies: START - st.supplies, mood: -st.mood, affection: -st.affection });
    st.cycle = (st.cycle || 1) + 1;
    st.story = { intro_done: false, log: [] };   /* 开场跟周目一起重来 */
    d.day = dayKey();
    clearSlots(d);
    d.quiz_total = 0;
    d.quiz_right = 0;
    d.streak = 1;
    STORE.save();
    document.dispatchEvent(new CustomEvent("momo:store", { detail: { death: true } }));
    /* 回主画面：story.intro_done 刚被清掉，所以开场会自动重演一遍（自动播没关的话） */
    if (window.MomoUI) window.MomoUI.show("主画面");
  }

  /* ---------------- 提示 / 账单面板 ----------------
     外观与开屏那句确认共用一套 cf-* 样式（见 common.css），这里只负责内容。 */
  function toast(msg, ok) {
    var t = document.getElementById("momo-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "momo-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = ok ? "toast-ok" : "toast-err";
    t.style.display = "block";
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.style.display = "none"; }, 1800);
  }

  function panel(title, sub, lines, btnText, onClose) {
    var m = document.createElement("div");
    m.id = "momo-daily-mask";
    var p = document.createElement("div");
    p.id = "momo-daily-panel";
    m.appendChild(p);
    var h = document.createElement("div");
    h.className = "cf-title";
    h.textContent = title;
    p.appendChild(h);
    if (sub) {
      var s = document.createElement("div");
      s.className = "cf-sub";
      s.textContent = sub;
      p.appendChild(s);
    }
    if (lines && lines.length) {
      var ul = document.createElement("ul");
      ul.className = "cf-list";
      lines.forEach(function (t) {
        var li = document.createElement("li");
        li.textContent = t;
        ul.appendChild(li);
      });
      p.appendChild(ul);
    }
    var btns = document.createElement("div");
    btns.className = "cf-btns";
    var b = document.createElement("button");
    b.type = "button";
    b.className = "cf-btn cf-btn--main";
    b.textContent = btnText;
    b.addEventListener("click", function () {
      m.remove();
      if (onClose) onClose();
    });
    btns.appendChild(b);
    p.appendChild(btns);
    document.body.appendChild(m);
    return m;
  }

  /* 开场剧情还在演就先别盖面板（演出是「点一下走一行」，盖上去就没法点了）。
     等她演完再弹；万一一直演不完（玩家挂着不理），60 秒后照弹不误。 */
  function whenIdle(fn, tries) {
    tries = tries || 0;
    if (window.MomoDirector && window.MomoDirector.isPlaying() && tries < 60) {
      setTimeout(function () { whenIdle(fn, tries + 1); }, 1000);
      return;
    }
    fn();
  }

  function showSettle(rep) {
    whenIdle(function () {
      if (window.MomoAudio) MomoAudio.sfx("sfx-settle");
      panel("新 的 一 天", "距离上次上线过了 " + rep.gap + " 天", rep.lines, "知 道 了");
    });
  }
  function showDeath(rep) {
    whenIdle(function () {
      if (window.MomoAudio) {
        MomoAudio.sfx("sfx-death");
        /* 告别台词走 pick（按当前学习语种挑变体，多录几条就轮换） */
        var line = MomoAudio.pick ? MomoAudio.pick("vo-death-") : "";
        if (line) MomoAudio.vo(line);
      }
      panel("墨 墨 不 在 了",
            "好感与心情归零，从开场重新演一遍。\n学习进度、已解锁的服装与 CG 都给你留着。",
            rep.lines, "开 启 下 一 周 目", revive);
    });
  }

  /* ---------------- 入口 ---------------- */
  document.addEventListener("momo:show", function (e) {
    if (!e.detail || e.detail.screen !== "主画面") return;
    whenIdle(tick);
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });
  setInterval(tick, TICK);

  /* 脚本在 body 末尾；若首屏直接落在主画面，上面那次 momo:show 早于本文件执行、收不到 */
  var main = document.querySelector('[data-screen="主画面"]');
  if (main && main.classList.contains("active")) tick();
  else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      var m = document.querySelector('[data-screen="主画面"]');
      if (m && m.classList.contains("active")) tick();
    });
  }

  window.MomoDaily = {
    /* 学习产出接线要用的数值（learn.js 从这里取，不许在业务里写死） */
    GIVE: {
      slot_online: SLOT_ONLINE,
      flashcard_remember: G.flashcard_remember || 0,
      flashcard_fuzzy: G.flashcard_fuzzy || 0,
      quiz_correct_srs: G.quiz_correct_srs || 0,
      quiz_correct_practice: G.quiz_correct_practice || 0,
      combo_bonus_per_item: G.combo_bonus_per_item || 0
    },
    noteQuiz: noteQuiz,
    tick: tick,
    rollover: rollover,
    revive: revive,
    day: dayKey,
    slot: slotNow,
    /* 供自动化验证用 */
    state: function () {
      var d = daily();
      return {
        day: d.day, today: dayKey(), slot: slotNow(), slots: {
          "清晨": d.slots["清晨"], "午后": d.slots["午后"], "夜晚": d.slots["夜晚"]
        },
        quiz_total: d.quiz_total, quiz_right: d.quiz_right, streak: d.streak,
        total_days: d.total_days || 0,
        supplies: Math.round(STORE.state.supplies),
        currency: Math.round(STORE.state.currency),
        cycle: STORE.state.cycle || 1,
        panel: !!document.getElementById("momo-daily-mask")
      };
    }
  };
})();