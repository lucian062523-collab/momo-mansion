/* 墨墨 · SRS 记忆调度（方案 §5.5 的轻量 SM-2）
   唯一职责：把「三档自评」变成下一次到期日，并给出掌握判定。
   不碰 DOM，只吃数据吐数据 —— 记词本、错题集、练习组卷都从这里取事实。

   档位映射（方案 §5.5）：
     忘了(0) → interval=0，当天立即重来；ease 减 0.2（下限 1.3）
     模糊(1) → interval ×1.2
     记得(2) → interval ×ease；ease 加 0.1（上限 2.8）
   掌握判定：interval ≥ 7 天 → 记「已掌握」（周目开门与难度分档都用它）。

   due / 日期一律用 "YYYYMMDD" 字符串（零填充，字典序即时序），与方案 §9 的存档 schema 一致。 */
(function () {
  "use strict";
  var STORE = window.MomoStore;
  if (!STORE) return;

  var MASTER_DAYS = 7;          // interval ≥ 7 → 已掌握
  var EASE0 = 2.5, EASE_MIN = 1.3, EASE_MAX = 2.8;

  function table() {
    var L = STORE.state.learn;
    if (!L) {                       // 老存档兜底：补齐结构，避免升级后崩
      L = STORE.state.learn = { lang: "en", learned: {}, starred: { en: [], ja: [] },
                                wrong: { en: [], ja: [] }, grammar: { en: [], ja: [] } };
    }
    if (!L.learned) L.learned = {};
    return L.learned;
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function key(d) {
    d = d || new Date();
    return "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }
  function shift(k, n) {
    var y = +k.slice(0, 4), m = +k.slice(4, 6), d = +k.slice(6, 8);
    var t = new Date(y, m - 1, d);
    t.setDate(t.getDate() + n);
    return key(t);
  }

  function rec(id) {
    var t = table();
    if (!t[id]) t[id] = { ease: EASE0, interval: 0, due: key(), seen: 0, correct: 0, wrong: 0 };
    return t[id];
  }

  function grade(id, level) {
    var r = rec(id);
    var today = key();
    r.seen += 1;
    if (level >= 1) r.correct += 1; else r.wrong += 1;
    if (level === 0) {
      r.interval = 0;
      r.ease = Math.max(EASE_MIN, r.ease - 0.2);
    } else if (level === 1) {
      r.interval = r.interval ? Math.max(1, Math.round(r.interval * 1.2)) : 1;
    } else {
      r.interval = r.interval ? Math.max(1, Math.round(r.interval * r.ease)) : 1;
      r.ease = Math.min(EASE_MAX, r.ease + 0.1);
    }
    r.due = shift(today, r.interval);
    STORE.save();
    return r;
  }

  /* 三态：new 没练过 / wait 待复习 / done 已掌握 */
  function status(id) {
    var r = table()[id];
    if (!r) return "new";
    return r.interval >= MASTER_DAYS ? "done" : "wait";
  }
  function isMastered(id) { return status(id) === "done"; }
  function isDue(id) {
    var r = table()[id];
    return !r || r.due <= key();
  }

  /* 练习组卷的优先级：到期的旧词 → 没练过的新词 → 其余（按到期日最早） */
  function pick(ids, n) {
    var today = key(), t = table();
    var due = [], fresh = [], rest = [];
    ids.forEach(function (id) {
      var r = t[id];
      if (!r) fresh.push(id);
      else if (r.due <= today) due.push({ id: id, due: r.due, interval: r.interval });
      else rest.push({ id: id, due: r.due, interval: r.interval });
    });
    /* 到期词里，间隔短的先来（快忘的先复习） */
    due.sort(function (a, b) { return a.interval - b.interval || (a.due < b.due ? -1 : 1); });
    rest.sort(function (a, b) { return a.due < b.due ? -1 : 1; });
    return due.map(function (x) { return x.id; })
      .concat(fresh)
      .concat(rest.map(function (x) { return x.id; }))
      .slice(0, n);
  }

  function stats(ids) {
    var s = { total: ids.length, new: 0, wait: 0, done: 0 };
    ids.forEach(function (id) { s[status(id)] += 1; });
    return s;
  }

  window.MomoSRS = {
    MASTER_DAYS: MASTER_DAYS,
    today: key,
    grade: grade,
    status: status,
    isMastered: isMastered,
    isDue: isDue,
    pick: pick,
    stats: stats,
    raw: function (id) { return table()[id] || null; }
  };
})();