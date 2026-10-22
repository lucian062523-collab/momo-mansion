/* 墨墨 · CG 鉴赏 + 沉浸欣赏模式
   数据：game/content/cg.json（20 张 / 每页 6 张，对应 CG界面 的六个框）
   复用既有图层：六个框 .lL022 .lL024 .lL025 .lL027 .lL028 .lL029
                六个按钮 .lL031 .lL032 .lL033 .lL035 .lL036 .lL037
   已解锁的框换成「挖空」底图，框内嵌一层 CG；点「查看」进入全屏欣赏模式。 */
(function () {
  "use strict";
  var D = (window.MOMO_DATA || {}).cg;
  var STORE = window.MomoStore;
  if (!D || !STORE) return;
  var U = window.ASSET_URI || {};
  function uri(img) { return U[img] || ""; }
  function bg(img) { return img ? 'url("' + uri(img) + '")' : "none"; }

  var S = STORE.state;
  var FRAME_LOCKED = "CG（无图）.png";
  var FRAME_OPEN = "CG小窗（挖空）.png";
  var INSET = { left: 61.08, top: 26, width: 341, height: 227 };

  /* unlock_all_initial 期间必须「并入」已有解锁表，而不是只在它为空时写一次。
     否则老存档里只躺着旧 id，后加的新 CG 永远补不进去 —— 鉴赏页会把它们
     渲染成「???」占位框，表现就是「新 CG 明明装进去了却显示不出来」。
     （等切到真实解锁 unlock_all_initial=false 时，这条并入逻辑自动失效。） */
  if (!S.cg.unlocked) S.cg.unlocked = [];
  if (D.unlock_all_initial) {
    D.cgs.forEach(function (c) {
      if (S.cg.unlocked.indexOf(c.id) < 0) S.cg.unlocked.push(c.id);
    });
  }
  STORE.save();
  function isUnlocked(id) { return S.cg.unlocked.indexOf(id) >= 0; }

  var page = 0;
  var FRAMES = [".lL022", ".lL024", ".lL025", ".lL027", ".lL028", ".lL029"];
  var BUTTONS = [".lL031", ".lL032", ".lL033", ".lL035", ".lL036", ".lL037"];
  var scr = null, frames = [], buttons = [];

  /* 页数取「界面上的页码按钮数」与「CG 所需的页数」的较大者。
     画廊格数固定（PSD 给了 5 个页码 = 5 页 × 6 框 = 30 格），
     没放 CG 的格子用未解锁纯白框占位，不做隐藏。 */
  function pageTotal() {
    var ui = scr ? scr.querySelectorAll('[data-glow="pages"]').length : 0;
    return Math.max(1, ui, Math.ceil(D.cgs.length / D.per_page));
  }
  function pageItems() {
    var start = page * D.per_page;
    return D.cgs.slice(start, start + D.per_page);
  }

  function bind() {
    scr = document.querySelector('[data-screen="CG界面"]');
    if (!scr) return false;
    frames = FRAMES.map(function (c) { return scr.querySelector(c); });
    buttons = BUTTONS.map(function (c) { return scr.querySelector(c); });
    return true;
  }

  /* 框内嵌入一层 CG（放在框元素内部，位于挖空窗口区域） */
  function artOf(frame) {
    var art = frame.querySelector(".cg-art");
    if (!art) {
      art = document.createElement("div");
      art.className = "cg-art";
      art.style.cssText = "position:absolute;left:" + INSET.left + "px;top:" + INSET.top +
        "px;width:" + INSET.width + "px;height:" + INSET.height + "px;" +
        "background-size:contain;background-position:center;background-repeat:no-repeat";
      frame.appendChild(art);
    }
    return art;
  }

  function render() {
    if (!scr) return;
    var items = pageItems();
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i], b = buttons[i], cg = items[i];
      var unlocked = cg ? isUnlocked(cg.id) : false;
      /* 锁着的格子（未解锁 / 空位）：不隐藏，用未解锁纯白框占位，
         并摘掉状态变体 —— 否则悬停会点亮，看着能点其实点不动（假按钮）。 */
        if (f) {
          f.style.backgroundImage = bg(unlocked ? FRAME_OPEN : FRAME_LOCKED);
          artOf(f).style.backgroundImage = unlocked ? bg(cg.img) : "none";
        }
        if (b) {
          var lab = b.querySelector(".btn-label");
          if (lab) lab.textContent = unlocked ? "查看" : "???";
          b.dataset.cgId = unlocked ? cg.id : "";
          if (unlocked) {
            if (b.dataset.variantSaved) {
              b.dataset.variant = b.dataset.variantSaved;
              delete b.dataset.variantSaved;
            }
          } else if (b.dataset.variant) {
            b.dataset.variantSaved = b.dataset.variant;
            delete b.dataset.variant;
            b.style.backgroundImage = "";
          }
        }
      }
      /* 页码全部保留（画廊格数固定），只切高亮 */
      [].slice.call(scr.querySelectorAll('[data-glow="pages"]')).forEach(function (p, i) {
        p.classList.toggle("glowing", i === page);
      });
    }

  /* ---------- 沉浸欣赏模式 ---------- */
  var viewer = null;
  function openViewer(list, idx) {
    if (!list.length) return;
    var cur = idx;
    if (!viewer) {
      viewer = document.createElement("div");
      viewer.id = "momo-cg-viewer";
      viewer.style.cssText = "position:fixed;inset:0;z-index:99999;display:none;" +
        "background:" + (D.viewer && D.viewer.backdrop ? D.viewer.backdrop : "rgba(18,14,11,0.94)") +
        ";align-items:center;justify-content:center;flex-direction:column;gap:18px";
      viewer.innerHTML =
        '<div class="cgv-stage" style="flex:1 1 auto;width:100%;display:flex;align-items:center;justify-content:center;padding:48px 96px 0"></div>' +
        '<div class="cgv-bar" style="display:flex;align-items:center;gap:28px;padding:0 0 34px;' +
        'font-family:\'FZXiaoBiaoSong-B05S\',\'方正小标宋简体\',serif;color:#f2e6cf;letter-spacing:.14em"></div>';
      document.body.appendChild(viewer);
      viewer.addEventListener("click", function (e) { if (e.target === viewer) closeViewer(); });
    }
    var stage = viewer.querySelector(".cgv-stage");
    var bar = viewer.querySelector(".cgv-bar");

    function draw() {
      var cg = list[cur];
      stage.innerHTML = "";
      var im = document.createElement("div");
      im.style.cssText = "max-width:100%;max-height:100%;width:100%;height:100%;" +
        "background-image:" + bg(cg.img) + ";background-size:contain;" +
        "background-position:center;background-repeat:no-repeat";
      stage.appendChild(im);
      bar.innerHTML =
        '<span class="cgv-btn" data-act="prev" style="cursor:pointer;font-size:38px;opacity:.85">‹</span>' +
        '<span style="font-size:30px">' + cg.name + '</span>' +
        '<span style="font-size:22px;opacity:.6">' + (cur + 1) + " / " + list.length + '</span>' +
        '<span class="cgv-btn" data-act="next" style="cursor:pointer;font-size:38px;opacity:.85">›</span>' +
        '<span class="cgv-btn" data-act="close" style="cursor:pointer;font-size:22px;opacity:.6;margin-left:24px">关 闭</span>';
      [].slice.call(bar.querySelectorAll(".cgv-btn")).forEach(function (b) {
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          var a = b.dataset.act;
          if (a === "prev") { cur = (cur - 1 + list.length) % list.length; draw(); }
          else if (a === "next") { cur = (cur + 1) % list.length; draw(); }
          else closeViewer();
        });
      });
      if (S.cg.viewed.indexOf(cg.id) < 0) { S.cg.viewed.push(cg.id); STORE.save(); }
    }
    viewer.style.display = "flex";
    document.body.style.overflow = "hidden";
    draw();
    viewer.dataset.cur = String(cur);
    viewer._nav = function (step) { cur = (cur + step + list.length) % list.length; draw(); };
  }
  function closeViewer() {
    if (viewer) viewer.style.display = "none";
    document.body.style.overflow = "";
  }
  function viewerOpen() { return viewer && viewer.style.display !== "none"; }

  document.addEventListener("keydown", function (e) {
    if (!viewerOpen()) return;
    var V = D.viewer || {};
    if (e.key === (V.exit_key || "Escape")) { closeViewer(); }
    else if (e.key === (V.prev_key || "ArrowLeft")) { viewer._nav(-1); }
    else if (e.key === (V.next_key || "ArrowRight")) { viewer._nav(1); }
  });

  /* ---------- 交互 ---------- */
  function wire() {
    buttons.forEach(function (b) {
      if (!b || b.dataset.wired) return;
      b.dataset.wired = "1";
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = b.dataset.cgId;
        if (!id || !isUnlocked(id)) return;
        var unlockeds = D.cgs.filter(function (c) { return isUnlocked(c.id); });
        var idx = -1;
        for (var i = 0; i < unlockeds.length; i++) if (unlockeds[i].id === id) idx = i;
        openViewer(unlockeds, Math.max(0, idx));
      });
    });
    [].slice.call(scr.querySelectorAll('[data-glow="pages"]')).forEach(function (p) {
      if (p.dataset.wired) return;
      p.dataset.wired = "1";
      p.addEventListener("click", function () {
        var n = parseInt(p.dataset.name, 10);
        if (!isNaN(n)) { page = Math.min(pageTotal() - 1, n - 1); render(); }
      });
    });
    [].slice.call(scr.querySelectorAll("[data-page]")).forEach(function (a) {
      if (a.dataset.wired) return;
      a.dataset.wired = "1";
      a.addEventListener("click", function () {
        page = a.dataset.page === "next"
          ? Math.min(pageTotal() - 1, page + 1)
          : Math.max(0, page - 1);
        render();
      });
    });
  }

  function onShow(e) {
    if (!e.detail || e.detail.screen !== "CG界面") return;
    if (!scr && !bind()) return;
    wire();
    render();
  }
  document.addEventListener("momo:show", onShow);

  var s0 = document.querySelector('[data-screen="CG界面"]');
  if (s0 && s0.classList.contains("active")) onShow({ detail: { screen: "CG界面" } });
})();