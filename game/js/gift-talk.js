/* 墨墨 · 送礼回话
   用户定：把东西送出去、回到主画面，她就这件事说一段话（含末尾那段词源/历史科普）。

   文案在 game/content/dialogues.json 的「送礼回话」一节，key = items.json 的道具 id
   （由 _tools/merge_gift_lines.py 从 docx 生成）。一条的形状：
     { who:"momo", text:"…", expr:"惊讶" }   台词，expr 不写＝回默认立绘
     { who:"momo", text:"",   expr:"欲言又止" } 只有表情、没有说话 —— 做成一次表情停顿
     { who:"narr", text:"…" }                旁白

   机制跟 idle.js 的日常台词完全一样：组一份临时节点表交给 director.playNodes 演，
   不进剧本、不留 flag、演完画面只剩立绘 + 场景图。
   谁触发：items.js 赠送成功后派 momo:gift（告诉他这次送的是哪件）。 */
(function () {
  "use strict";
  var SCR = "主画面";
  var BOOK = (window.MOMO_DATA || {}).dialogues || {};
  var LINES = BOOK["送礼回话"] || {};
  var DEFAULT_EXPR = (window.MOMO_DATA || {}).expressions
    ? (window.MOMO_DATA.expressions.default || "默认") : "默认";

  var HOLD = 900;        /* 只有表情没台词的停顿 */
  var pending = null;    /* 待演的道具 id */

  /* 一条文案 → 一个 director 节点 */
  function nodeOf(l) {
    var expr = l.expr || DEFAULT_EXPR;
    if (l.who === "narr") return { type: "narration", text: l.text, expr: expr };
    /* 没有说话、只标了表情：给一次停顿，别弹一个空对话框 */
    if (!l.text) return { type: "expr", name: expr, hold: HOLD };
    return { type: "say", text: l.text, expr: expr };
  }

  function nodesFor(id) {
    var list = LINES[id] || [];
    var nodes = list.map(nodeOf);
    if (nodes.length) nodes.push({ type: "end" });
    return nodes;
  }

  document.addEventListener("momo:gift", function (e) {
    var id = e.detail && e.detail.id;
    if (!id || !LINES[id] || !LINES[id].length) return;
    pending = id;
  });

  document.addEventListener("momo:show", function (e) {
    if (!e.detail || e.detail.screen !== SCR || !pending) return;
    if (!window.MomoDirector) return;
    /* 正在演（开场、切场景那一拍…）就先留着：等下次回主画面再演，
       别把没播完的剧本截断，也别让两段演出叠在一起。 */
    if (window.MomoDirector.isPlaying()) return;
    var id = pending;
    pending = null;
    window.MomoDirector.playNodes(nodesFor(id));
  });

  /* 供自动化验证用：能只看不演，也能直接点播某件 */
  window.MomoGiftTalk = {
    pending: function () { return pending; },
    ids: function () { return Object.keys(LINES).filter(function (k) { return k !== "note"; }); },
    lines: function (id) { return (LINES[id] || []).length; },
    nodes: function (id) { return nodesFor(id); },
    play: function (id) {
      if (!LINES[id]) return false;
      pending = null;
      return window.MomoDirector.playNodes(nodesFor(id));
    }
  };
})();