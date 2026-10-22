/* 墨墨 · 存读档（把「存:读档界面」那 30 个存档条接上真数据）
   界面不加一个像素 —— 只给 PSD 已有的分层组件加功能：
     存档条 [data-glow=saves] ×6/页   ← 每档两个 dyn 文字位：存档名 + 日期（现在是真值）
     页码   [data-glow=pages] ×5      ← 5 页 = 30 档
     翻页   .lL017(next) / .lL018(prev)
   模式（存/读）从哪来：设置界面的「保存档案」「读取档案」都指向本屏，
   所以用**捕获阶段**监听抢先记下点的是哪个（界面本身不显示模式，不改 UI）。
   存档名默认取玩家姓名（name.js 写的用户档），这样档位名就是墨墨对你的称呼。 */
(function () {
  "use strict";
  var STORE = window.MomoStore;
  if (!STORE) return;
  var KEY = "momo.save.slot.";
  var PER = 6, PAGES = 5;
  var mode = "load";        /* load | save */
  var page = 0;
  var scr = null, slots = [], pageBtns = [], prevBtn = null, nextBtn = null;

  var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
  function stamp(d) {
    return d.getFullYear() + "/" + pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) +
           " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function read(i) {
    try { return JSON.parse(localStorage.getItem(KEY + i)) || null; } catch (e) { return null; }
  }
  function write(i, o) {
    try { localStorage.setItem(KEY + i, JSON.stringify(o)); } catch (e) {}
  }
  function playerName() {
    try { return (JSON.parse(localStorage.getItem("momo.profile")) || {}).name || ""; } catch (e) { return ""; }
  }
  function sn(i) { return page * PER + i; }
  function label(el) {
    var l = el.querySelector(".btn-label");
    return l ? l.textContent.replace(/\s+/g, "") : "";
  }

  /* 复用 items.js 那个提示条（同 id 同样式），不新造浮层样式 */
  function flash(msg, ok) {
    var t = document.getElementById("momo-toast");
    if (!t) { t = document.createElement("div"); t.id = "momo-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = (ok === false) ? "toast-err" : "toast-ok";
    t.style.display = "block";
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.style.display = "none"; }, 1700);
  }

  function bind() {
    scr = document.querySelector('[data-screen="存:读档界面"]');
    if (!scr) return false;
    slots = [].slice.call(scr.querySelectorAll('[data-glow="saves"]'));
    pageBtns = [].slice.call(scr.querySelectorAll('[data-glow="pages"]'));
    nextBtn = scr.querySelector(".lL017");
    prevBtn = scr.querySelector(".lL018");
    slots.forEach(function (s, i) {
      var ls = s.querySelectorAll(".btn-label");
      s._name = ls[0] || null;
      s._date = ls[1] || null;
      /* 日期位要同时放日期+时间，PSD 给的那点宽度不够，放宽并收小一号字号 */
      if (s._date) { s._date.style.width = "68%"; s._date.style.fontSize = "24px"; }
      s.addEventListener("click", function (e) { e.stopPropagation(); act(i); });
    });
    pageBtns.forEach(function (p, i) {
      p.addEventListener("click", function (e) { e.stopPropagation(); page = i; render(); });
    });
    if (nextBtn) nextBtn.addEventListener("click", function () {
      page = Math.min(PAGES - 1, page + 1); render();
    });
    if (prevBtn) prevBtn.addEventListener("click", function () {
      page = Math.max(0, page - 1); render();
    });
    return true;
  }

  function act(i) {
    var g = sn(i);
    if (mode === "save") {
      var old = read(g);
      /* 档位名优先沿用旧名；没有就用玩家姓名；再没有才用序号兜底 */
      var nm = (old && old.name) || playerName() || ("存档 " + (g + 1));
      write(g, {
        name: nm,
        savedAt: Date.now(),
        savedAtText: stamp(new Date()),
        data: JSON.parse(JSON.stringify(STORE.state))
      });
      flash("已保存到第 " + (g + 1) + " 档：" + nm);
    } else {
      var rec = read(g);
      if (!rec) { flash("第 " + (g + 1) + " 档是空的", false); render(); return; }
      STORE.load(rec.data);
      flash("已读取第 " + (g + 1) + " 档：" + (rec.savedAtText || ""));
      document.dispatchEvent(new CustomEvent("momo:show", { detail: { screen: "存:读档界面" } }));
    }
    render();
  }

  function render() {
    if (!scr) return;
    slots.forEach(function (s, i) {
      var rec = read(sn(i));
      if (s._name) s._name.textContent = rec ? (rec.name || "存档") : "空档位";
      if (s._date) s._date.textContent = rec
        ? (rec.savedAtText || stamp(new Date(rec.savedAt || Date.now())))
        : "";
      s.classList.remove("glowing");
    });
    pageBtns.forEach(function (p, i) { p.classList.toggle("glowing", i === page); });
  }

  /* 抢在 ui.js 的跳转之前记下模式（捕获阶段） */
  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest('[data-goto="存:读档界面"]') : null;
    if (!b) return;
    mode = /保存/.test(label(b)) ? "save" : "load";
  }, true);

  function onShow(e) {
    if (!e.detail || e.detail.screen !== "存:读档界面") return;
    if (!scr && !bind()) return;
    render();
  }
  document.addEventListener("momo:show", onShow);

  var s0 = document.querySelector('[data-screen="存:读档界面"]');
  if (s0 && s0.classList.contains("active")) onShow({ detail: { screen: "存:读档界面" } });

  window.MomoSave = {
    state: function () { return { mode: mode, page: page, slots: slots.length }; },
    /* 供自动化验证用 */
    setMode: function (m) { mode = m; },
    records: function () {
      var out = [];
      for (var i = 0; i < PER * PAGES; i++) if (read(i)) out.push(i);
      return out;
    }
  };
})();