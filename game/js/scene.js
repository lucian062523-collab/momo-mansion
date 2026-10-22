/* 墨墨 · 场景与时段
   1) 时段按**真实系统时间**判定：早晨 05–11 / 傍晚 11–18 / 夜晚 18–05
   2) 房间 → 场景图：走 game/content/scenes.json，先按本时段取，
      取不到就按 夜→傍→早 逐级回退（新包有房间只画了一个时段）
   3) 主画面出图：双层交叉淡入淡出（新图先铺在"藏在底下"的那层再点亮），
      所以切换过程不会露出背景、不闪白
   房间名 → 场景基名候选 的别名表来自 map.json（卧室→卧房、游乐园→游乐场…） */
(function () {
  "use strict";
  var STORE = window.MomoStore;
  if (!STORE) return;
  var PERIODS = ["早晨", "傍晚", "夜晚"];
  /* 取不到本时段时，按这个顺序退而求其次 */
  var FALLBACK = {
    "早晨": ["早晨", "傍晚", "夜晚"],
    "傍晚": ["傍晚", "夜晚", "早晨"],
    "夜晚": ["夜晚", "傍晚", "早晨"],
    /* 室内夜里开着灯的版本 —— 美术只画了一部分房间（书房/卧房/客厅/杂货店），
       没有就退回普通夜晚。剧本里写 "period": "夜晚开灯" 即用（2026-10-12 作者要）。 */
    "夜晚开灯": ["夜晚开灯", "夜晚", "傍晚", "早晨"],
    /* 关灯的普通夜景（作者 2026-10-20 指定：卧房先用关灯版；走廊用走廊-夜）。 */
    "夜晚关灯": ["夜晚关灯", "夜晚", "傍晚", "早晨"],
    /* 门槛背景（作者指定：门槛 CG 放完后，墨墨说话时背景用「门槛-无墨墨」）。 */
    "门槛": ["门槛", "夜晚关灯", "夜晚", "傍晚", "早晨"]
  };
  var TICK = 30000;   /* 每 30s 复核一次时段；切回前台也立即复核 */

  var forced = null;   /* 剧本点名时段时的覆盖值（scene 节点的 period 字段，演完由 director 交还） */
  function period(d) {
    if (!d && forced) return forced;             /* 剧本写死了时段就用它（如「夜已经近深了」→ 夜晚） */
    var h = (d || new Date()).getHours();
    if (h >= 5 && h < 11) return "早晨";
    if (h >= 11 && h < 18) return "傍晚";
    return "夜晚";
  }
  /* 覆盖时段：传 FALLBACK 里认识的键（早晨/傍晚/夜晚/夜晚开灯）即刻生效；
     其余（null / "" / 写错的值）= 交还真实时钟。
     注意「不写 period 就沿用上一拍」是**导演层**的事 —— director 记着自己钉的时段，
     只在 scene 节点真的写了 period 时才改，然后每次把当前值传进来。
     这里只回答「此刻该用哪个时段」，不做继承。 */
  function setPeriod(name) {
    forced = (name && FALLBACK[name]) ? name : null;
    return forced;
  }
  function lib() { return (window.MOMO_DATA || {}).scenes || {}; }
  /* 单文件里 ASSET_URI 把「原文件名 → data URI」；源码模式下查不到就按原路径用 */
  var U = window.ASSET_URI || {};
  function uri(p) { return U[p] || p; }

  /* 房间名 → {scene:[候选基名], floor}，同名的取先出现的（卧房 → F1） */
  var idx = null;
  function index() {
    if (idx) return idx;
    idx = {};
    var M = (window.MOMO_DATA || {}).map;
    if (!M) return idx;
    (M.order || []).forEach(function (k) {
      var f = M.floors[k];
      if (!f) return;
      (f.rooms || []).forEach(function (r) {
        if (r.kind === "stair" || idx[r.label]) return;
        idx[r.label] = { scene: (r.scene && r.scene.length) ? r.scene : [r.label], floor: k };
      });
    });
    return idx;
  }
  function namesOf(label) {
    var e = index()[label];
    return e ? e.scene : [label];
  }
  function floorOf(label) {
    var e = index()[label];
    return e ? e.floor : "F1";
  }

  /* 候选基名 + 时段 → 图片路径（时段优先，其次候选顺序） */
  function resolve(names, per) {
    var S = lib().scenes || {};
    if (!names || !names.length) return null;
    var order = FALLBACK[per] || PERIODS;
    for (var i = 0; i < order.length; i++) {
      for (var j = 0; j < names.length; j++) {
        var by = S[names[j]];
        if (by && by[order[i]]) return by[order[i]];
      }
    }
    return null;
  }
  function has(label) { return !!resolve(namesOf(label), period()); }

  /* ---------- 主画面出图 ---------- */
  var cur = null;
  function els() {
    var scr = document.querySelector('[data-screen="主画面"]');
    return scr ? { a: scr.querySelector(".scene-a"), b: scr.querySelector(".scene-b") } : null;
  }
  function paint(url) {
    var g = els();
    if (!g || !g.a || !g.b || !url || url === cur) return false;
    cur = url;
    var top = g.a.classList.contains("on") ? g.b : g.a;   /* 拿藏在底下那层来铺新图 */
    top.style.backgroundImage = 'url("' + uri(url) + '")';
    top.classList.add("on");
    (top === g.a ? g.b : g.a).classList.remove("on");
    return true;
  }
  function refresh() {
    var st = STORE.state;
    return paint(resolve(namesOf(st.room), period()));
  }

  /* 时段可能在标签页后台悄悄变化，所以定时 + 回到前台各复核一次 */
  setInterval(refresh, TICK);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });
  document.addEventListener("momo:show", function (e) {
    if (e.detail && e.detail.screen === "主画面") refresh();
  });
  document.addEventListener("momo:store", function () { cur = null; refresh(); });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refresh);
  } else {
    refresh();
  }

  window.MomoScene = {
    period: period,
    periods: PERIODS,
    setPeriod: setPeriod,
    resolve: resolve,
    namesOf: namesOf,
    floorOf: floorOf,
    has: has,
    refresh: refresh,
    /* 场景图文件名 → 可用的 URL（单文件构建下要过 ASSET_URI 那张表）。
       地点小游戏要铺同一张场景图当底，别再抄一份查表逻辑。 */
    uri: uri,
    /* 供自动化验证用 */
    state: function () {
      return {
        period: period(),
        forced: forced,
        room: STORE.state.room,
        floor: STORE.state.floor,
        url: cur,
        layers: (function () {
          var g = els(); if (!g || !g.a) return null;
          return { a: g.a.classList.contains("on"), b: g.b.classList.contains("on") };
        })()
      };
    }
  };
})();