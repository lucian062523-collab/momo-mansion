/* 墨墨 · 剧情回放（过往对话）
   数据：存档里的 story.log —— director.js 每演一句就往里追加一笔
     { who: "momo" | "player" | "narr", text: 原始台词（可能带 {{name}}） }
   界面：不加一个像素。PSD 里「回放界面」那块面板本来就是给文字用的（原来写着
   「这是一个回放面板…」的占位说明），这里把它变成真的可滚列表：
   列表锁在面板的羊皮纸内区里，上下滑动看过往对话，打开就停在最新一句。

   只负责「把记录画出来」，记录怎么写是 director.js 的事；
   想改成按章节分组、加播放速度之类，从这里长出去就行。 */
(function () {
  "use strict";
  var STORE = window.MomoStore;
  if (!STORE) return;
  var scr = null, view = null, list = null, empty = null;

  function log() {
    var st = STORE.state.story || {};
    return st.log || [];
  }
  function whoLabel(e) {
    if (e.who === "player") return window.MomoName ? window.MomoName.fill("{{name}}") : "你";
    if (e.who && e.who !== "momo") return e.who;   /* NPC 群像台词（2026-10 茶会起）：名字直出 */
    return "墨 墨";
  }

  function bind() {
    scr = document.querySelector('[data-screen="回放界面"]');
    if (!scr) return false;
    view = scr.querySelector(".rp-viewport");
    if (!view) return false;
    list = view.querySelector(".rp-list");
    empty = view.querySelector(".rp-empty");
    if (!list || !empty) return false;
    return true;
  }

  function render() {
    if (!scr && !bind()) return;
    var rows = log();
    list.innerHTML = "";
    if (!rows.length) {
      empty.hidden = false;
      view.scrollTop = 0;
      return;
    }
    empty.hidden = true;
    var frag = document.createDocumentFragment();
    rows.forEach(function (e) {
      var row = document.createElement("div");
      var kind = e.who === "player" ? "player" : (e.who === "narr" ? "narr" : "momo");
      row.className = "rp-row rp-row--" + kind;
      if (kind !== "narr") {
        var w = document.createElement("div");
        w.className = "rp-who";
        w.textContent = whoLabel(e);
        row.appendChild(w);
      }
      var t = document.createElement("div");
      t.className = "rp-txt";
      t.textContent = window.MomoName ? window.MomoName.fill(e.text) : e.text;
      row.appendChild(t);
      frag.appendChild(row);
    });
    list.appendChild(frag);
    /* 打开就停在最新一句（往上滑才是回头看） */
    view.scrollTop = view.scrollHeight;
  }

  function onShow(e) {
    if (!e.detail || e.detail.screen !== "回放界面") return;
    if (!scr && !bind()) return;
    render();
  }
  document.addEventListener("momo:show", onShow);

  var s0 = document.querySelector('[data-screen="回放界面"]');
  if (s0 && s0.classList.contains("active")) onShow({ detail: { screen: "回放界面" } });

  window.MomoReplay = {
    render: render,
    /* 供自动化验证用 */
    state: function () {
      if (!scr && !bind()) return { bound: false };
      return {
        bound: true,
        entries: log().length,
        rendered: list.children.length,
        kinds: [].slice.call(list.children).map(function (r) {
          return r.className.replace("rp-row rp-row--", "");
        }),
        firstText: list.children.length
          ? list.children[0].querySelector(".rp-txt").textContent : "",
        lastText: list.children.length
          ? list.children[list.children.length - 1].querySelector(".rp-txt").textContent : "",
        emptyShown: !empty.hidden && getComputedStyle(empty).display !== "none",
        /* 空态那块的实占高度：只查 hidden 属性会被 CSS 骗过去（见 common.css 的注释） */
        emptyRectH: Math.round(empty.getBoundingClientRect().height),
        /* 滑动范围必须锁在面板里：列表比视口高才滚得动，且视口本身不越出面板内区 */
        viewport: (function () {
          var b = view.getBoundingClientRect();
          return { w: Math.round(b.width), h: Math.round(b.height) };
        })(),
        scrollHeight: view.scrollHeight,
        clientHeight: view.clientHeight,
        atBottom: Math.abs(view.scrollTop + view.clientHeight - view.scrollHeight) <= 2
      };
    }
  };
})();