/* 墨墨 · 姓名录入（开局之前的唯一一次）
   规则：**同一个用户只问一次**，之后（含多周目 / 墨墨死亡重开）都不再问。
   所以姓名不放在那一局存档里，而是单独存一份「用户档」：
     localStorage["momo.profile"] = { name: "..." }
   打开链接就弹（盖在开屏之上），确认后收起并落盘，之后永不再弹。

   同时提供一个极小的文本插值：把台词里的 {{name}} 换成玩家名字，
   将来剧本调度（director）统一走这里即可，不用各自实现。 */
(function () {
  "use strict";
  var KEY = "momo.profile";
  var FALLBACK = "你";          /* 没填就用「你」，避免台词里出现空 */
  var MAXLEN = 12;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function saveProfile(p) {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {}
  }
  var profile = load();

  function name() { return (profile.name || "").trim(); }
  function displayName() { return name() || FALLBACK; }
  /* 文本插值：全站唯一出口。
     {{name}} 一直都有；2026-10 起补上状态占位符（dialogues.json character.placeholders
     定义的 {{supply}}/{{rate}}/{{count}}/{{currency}}/{{streak}}），值从存档与日循环
     实时取 —— 墨墨「读过你的档案」，点她时说的每一句都和你当下有关。
     不认识的 {{...}} 原样保留，留给后续的剧本调度。 */
  function fill(str) {
    var s = String(str == null ? "" : str).replace(/\{\{\s*name\s*\}\}/g, displayName());
    var S = window.MomoStore && window.MomoStore.state ? window.MomoStore.state : null;
    var D = (window.MomoDaily && MomoDaily.state) ? MomoDaily.state() : null;
    var v = {
      supply: S ? Math.round(S.supplies || 0) : null,
      currency: S ? Math.round(S.currency || 0) : null,
      streak: D ? D.streak : null,
      count: D ? D.quiz_total : null,
      rate: (D && D.quiz_total) ? Math.round(D.quiz_right / D.quiz_total * 100) + "%" : null
    };
    return s.replace(/\{\{\s*(supply|currency|streak|count|rate)\s*\}\}/g,
                     function (all, k) { return v[k] == null ? all : String(v[k]); });
  }

  /* ---------- 弹窗 ---------- */
  var box = null;
  /* opts 只在「改名」时给：换标题、预填当前名字。
     首开不给 = 原来那套「你叫什么名字？」。
     点面板外面可以取消 —— 首开时取消也没关系：没名字就用「你」兜底，下次进游戏再问一遍。 */
  function build(opts) {
    opts = opts || {};
    if (box) close();
    box = document.createElement("div");
    box.id = "momo-name-mask";
    box.innerHTML =
      '<div id="momo-name-panel">' +
        '<div class="mn-title">' + (opts.title || "你叫什么名字？") + '</div>' +
        '<div class="mn-sub">' + (opts.sub || "墨墨会用这个名字称呼你") + '</div>' +
        '<input id="momo-name-input" type="text" maxlength="' + MAXLEN + '" ' +
               'placeholder="输入你的名字" autocomplete="off" spellcheck="false">' +
        '<button id="momo-name-ok" type="button">确 认</button>' +
      '</div>';
    document.body.appendChild(box);
    var input = box.querySelector("#momo-name-input");
    var ok = box.querySelector("#momo-name-ok");
    if (opts.value) input.value = opts.value;
    ok.addEventListener("click", commit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") commit();
    });
    box.addEventListener("click", function (e) { if (e.target === box) close(); });
    setTimeout(function () { input.focus(); input.select(); }, 30);
    function commit() { set(input.value); }
  }

  /* 改名：入口在设置界面的小字（下面 renameEntry） */
  function openRename() {
    build({ title: "改成什么名字？", sub: "墨墨会用这个名字称呼你", value: name() });
  }

  function set(v) {
    profile.name = String(v || "").trim().slice(0, MAXLEN);
    saveProfile(profile);
    close();
    document.dispatchEvent(new CustomEvent("momo:name", { detail: { name: name() } }));
    refresh();
  }
  function close() { if (box) { box.remove(); box = null; } }

  /* ---------- 把 {{name}} 填进现有文字（当前主画面的对话框是唯一带占位符的地方） ---------- */
  function refresh() {
    var scr = document.querySelector('[data-screen="主画面"]');
    if (!scr) return;
    [].slice.call(scr.querySelectorAll(".btn-label")).forEach(function (el) {
      if (el.dataset.mnTpl == null) {
        var t = el.textContent;
        if (t.indexOf("{{") < 0) return;      /* 只处理带占位符的，别动其他文字 */
        el.dataset.mnTpl = t;
      }
      el.textContent = fill(el.dataset.mnTpl);
    });
  }

  /* 打开链接：没名字就立刻弹（脚本在 body 末尾，DOM 与开屏都已就绪） */
  if (!name()) build();
  else refresh();

  /* ---------- 设置界面：改名字入口（与「关于作者」并排的小字，2026-10-12） ---------- */
  var setScr = document.querySelector('[data-screen="设置界面"]');
  if (setScr) {
    var renameEntry = document.createElement("div");
    renameEntry.className = "rename-entry";
    renameEntry.textContent = "改名字";
    renameEntry.addEventListener("click", function (e) {
      e.stopPropagation();
      openRename();
    });
    (setScr.querySelector(".stage") || setScr).appendChild(renameEntry);
  }

  document.addEventListener("momo:name", refresh);

  window.MomoName = {
    get: name,
    display: displayName,
    set: set,
    fill: fill,
    refresh: refresh,
    ask: openRename,          /* 改名弹窗（设置界面的小字走这里） */
    /* 供自动化验证用 */
    state: function () {
      return { name: name(), modalOpen: !!document.getElementById("momo-name-mask") };
    }
  };
})();