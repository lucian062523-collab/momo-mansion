/* 墨墨 · 地图
   数据：game/content/map.json（4 张平面图 / 40 个可点区域，坐标已归一化成 0-1）
   打开时就落在**墨墨当前所在楼层**的地图：室内 → 那一层，室外 → 洋馆区大地图。
   换楼层两种方式：① 点地图上的「楼梯」灰块（F1→F2→F3→F1 循环）
                   ② 顶部的楼层标签页（含室外）
   点房间 → 记下房间与楼层 → 回主画面（场景按真实时段自动出图）。 */
(function () {
  "use strict";
  var STORE = window.MomoStore;
  var M = (window.MOMO_DATA || {}).map;
  if (!STORE || !M) return;
  var SHORT = { F1: "1F", F2: "2F", F3: "3F", OUT: "室外" };
  /* 单文件里 ASSET_URI 把「原文件名 → data URI」；源码模式下查不到就按原路径用 */
  var U = window.ASSET_URI || {};
  function uri(p) { return U[p] || p; }

  var scr = null, art = null, hits = null, tabs = null, shown = null, lamps = null;

  function toast(msg, ok) {
    var t = document.getElementById("momo-toast");
    if (!t) { t = document.createElement("div"); t.id = "momo-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = (ok === false) ? "toast-err" : "toast-ok";
    t.style.display = "block";
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.style.display = "none"; }, 1700);
  }

  function build() {
    scr = document.querySelector('[data-screen="地图界面"]');
    if (!scr) return false;
    art = scr.querySelector(".map-art");
    hits = scr.querySelector(".map-hits");
    tabs = scr.querySelector(".map-tabs");
    if (!art || !hits || !tabs) return false;
    tabs.innerHTML = M.order.map(function (k) {
      return '<div class="map-tab" data-floor="' + k + '">' + (SHORT[k] || k) + "</div>";
    }).join("");
    [].slice.call(tabs.children).forEach(function (t) {
      t.addEventListener("click", function (e) {
        e.stopPropagation();
        show(t.getAttribute("data-floor"));
      });
    });
    return true;
  }

  var hintRoom = null;   /* 剧情引导：待玩家前往的房间（码头）——导演 map_hint 节点设置 */
  var hintFloor = null;  /* 该房间所在楼层：地图打开时要自动切过去（码头在室外，不能让玩家自己找） */
  function floorOfRoom(label) {
    var out = null;
    M.order.forEach(function (k) {
      var f = M.floors[k];
      if (!f) return;
      (f.rooms || []).forEach(function (r) { if (r.label === label) out = k; });
    });
    return out;
  }
  function applyHint() {
    if (!hits || !hintRoom) return;
    [].slice.call(hits.querySelectorAll("[data-room]")).forEach(function (d) {
      d.classList.toggle("map-hint", d.getAttribute("data-room") === hintRoom);
    });
  }

  function show(key) {
    var f = M.floors[key];
    if (!f || shown === key) return;
    shown = key;
    art.style.backgroundImage = 'url("' + uri(f.art) + '")';
    hits.innerHTML = "";
    (f.rooms || []).forEach(function (r) {
      var d = document.createElement("div");
      d.className = "map-hit" + (r.kind === "stair" ? " map-hit--stair" : "");
      d.style.left = (r.x * 100) + "%";
      d.style.top = (r.y * 100) + "%";
      d.style.width = (r.w * 100) + "%";
      d.style.height = (r.h * 100) + "%";
      d.setAttribute("data-room", r.label);
      d.title = r.label;
      d.addEventListener("click", function (e) {
        e.stopPropagation();
        tap(r, key);
      });
      hits.appendChild(d);
    });
    [].slice.call(tabs.children).forEach(function (t) {
      t.classList.toggle("on", t.getAttribute("data-floor") === key);
    });
    renderLamps(key);
    applyHint();
  }

  /* ---------------- 心之桥 · 八盏灯（2026-10 主线）----------------
     只在室外大地图上显示：石拱桥的灯柱上八盏灯，按存档 bridge.lit 点亮。
     灯是她的勇气与记忆（死亡不清）——幽灵灯 → 金光星的视觉语言
     复用人物屏好感星那套（样式在 common.css 的 .map-lamp）。 */
  function lampLayer() {
    if (lamps && lamps.parentNode) return lamps;
    var wrap = scr ? scr.querySelector(".map-wrap") : null;
    if (!wrap) return null;
    lamps = document.createElement("div");
    lamps.className = "map-lamps";
    wrap.appendChild(lamps);
    lamps.addEventListener("click", function (e) {
      var p = e.target.closest ? e.target.closest(".map-lamp") : null;
      if (!p) return;
      e.stopPropagation();
      var n = +p.getAttribute("data-lamp") || 0;
      var lit = (STORE.state.bridge || {}).lit || 0;
      if (n && n <= lit) toast("心之桥 · 第" + n + "盏灯，已经点亮了。");
      else toast("心之桥 · 桥那头的灯，还没有亮。……陪她把日子过下去吧。");
    });
    return lamps;
  }
  function renderLamps(key) {
    var L = lampLayer();
    if (!L) return;
    if (key !== "OUT") { L.style.display = "none"; return; }
    var lit = (STORE.state.bridge || {}).lit || 0;
    var html = "";
    for (var i = 1; i <= 8; i++) {
      html += '<i class="map-lamp' + (i <= lit ? " on" : "") + '" data-lamp="' + i +
              '" style="left:' + (39.4 + (i - 1) * 3.05) + '%;top:' +
              (85.5 + Math.abs(i - 4.5) * 1.05) + '%"></i>';
    }
    L.innerHTML = html;
  }

  function tap(r, key) {
    /* 剧情引导的目的地走到即撤（码头 → 前言续播） */
    if (hintRoom === r.label) { hintRoom = null; hintFloor = null; }
    /* 楼梯：换楼层（只在内景三层之间循环） */
    if (r.kind === "stair") {
      var seq = M.interior || ["F1", "F2", "F3"];
      var i = seq.indexOf(key);
      show(seq[(i + 1) % seq.length]);
      return;
    }
    var label = r.label;
    if (!window.MomoScene.has(label)) {
      toast("「" + label + "」的场景图还没画好", false);
      return;
    }
    STORE.state.room = label;
    STORE.state.floor = key;
    STORE.save();
    window.MomoScene.refresh();
    document.dispatchEvent(new CustomEvent("momo:room", { detail: { room: label, floor: key } }));
    toast("已前往「" + label + "」");
    back();
  }
  function back() {
    var b = scr.querySelector('[data-goto="主画面"]');
    if (b) b.click();
  }

  function onShow(e) {
    if (!e.detail || e.detail.screen !== "地图界面") return;
    if (!scr && !build()) return;
    var st = STORE.state;
    /* 有剧情引导就切到目标房间所在楼层（码头在 OUT），否则落在玩家当前楼层 */
    var key = hintFloor
      || (M.floors[st.floor] ? st.floor : window.MomoScene.floorOf(st.room));
    shown = null;                        /* 每次打开都重建，房间/楼层可能变过 */
    show(key);
  }
  document.addEventListener("momo:show", onShow);

  var s0 = document.querySelector('[data-screen="地图界面"]');
  if (s0 && s0.classList.contains("active")) onShow({ detail: { screen: "地图界面" } });

  window.MomoMap = {
    /* 剧情引导：高亮一个房间（director 的 map_hint 节点调用） */
    hint: function (room) {
      hintRoom = room;
      hintFloor = floorOfRoom(room);
      applyHint();
    },
    clearHint: function () { hintRoom = null; hintFloor = null; applyHint(); },
    /* 供自动化验证用 */
    state: function () {
      return {
        shown: shown,
        hotspots: hits ? hits.children.length : 0,
        tabs: tabs ? [].slice.call(tabs.children).map(function (t) {
          return { floor: t.getAttribute("data-floor"), on: t.classList.contains("on") };
        }) : [],
        /* 命中测试：热区中心点上最上层的元素是不是它自己 */
        hitOk: (function () {
          if (!hits || !hits.children.length) return false;
          var el = hits.children[0], b = el.getBoundingClientRect();
          var top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return top === el || (top && top.parentNode === el);
        })()
      };
    }
  };
})();