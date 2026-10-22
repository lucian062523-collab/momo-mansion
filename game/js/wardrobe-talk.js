/* 墨墨 · 换装回话
   用户定（2026-10-06）：给她换上一套新衣服、回到主画面，她就这身衣服说两句。
   文案在 game/content/dialogues.json「换装回话」一节，key = wardrobe.json 的套装 id。
   机制与 gift-talk.js 完全同款：wardrobe.js 在「穿着真的变了」时派 momo:wear，
   这里存 pending，等回主画面、且没有别的演出在跑，再交给 director.playNodes 演。
   两条按顺序点两下说完，演完画面只剩新衣服的立绘 + 场景图。 */
(function () {
  "use strict";
  var SCR = "主画面";
  var LINES = ((window.MOMO_DATA || {}).dialogues || {})["换装回话"] || {};
  var DEFAULT_EXPR = (window.MOMO_DATA || {}).expressions
    ? (window.MOMO_DATA.expressions.default || "默认") : "默认";

  var HOLD = 900;        /* 只有表情没台词的停顿（本桶暂没用到，留着对齐 gift-talk） */
  var pending = null;    /* 待演的套装 id */
  var lastSaid = "";     /* 上一套说过的：同套再穿不重复点评 */

  /* 一条文案 → 一个 director 节点（与送礼回话同一套解析） */
  function nodeOf(l) {
    var expr = l.expr || DEFAULT_EXPR;
    if (l.who === "narr") return { type: "narration", text: l.text, expr: expr };
    if (!l.text) return { type: "expr", name: expr, hold: HOLD };
    return { type: "say", text: l.text, expr: expr };
  }
  function nodesFor(id) {
    var list = LINES[id] || [];
    var nodes = list.map(nodeOf);
    if (nodes.length) nodes.push({ type: "end" });
    return nodes;
  }

  document.addEventListener("momo:wear", function (e) {
    var id = e.detail && e.detail.id;
    if (!id || !LINES[id] || !LINES[id].length) return;
    /* 穿回刚点评过的这套不再点评（脱了又穿回，不算「换装」） */
    if (id === lastSaid) return;
    pending = id;
  });

  document.addEventListener("momo:show", function (e) {
    if (!e.detail || e.detail.screen !== SCR || !pending) return;
    if (!window.MomoDirector) return;
    /* 正在演（开场、切场景那一拍、送礼回话…）就先留着：等下次回主画面再演，
       别把没播完的剧本截断，也别让两段演出叠在一起。 */
    if (window.MomoDirector.isPlaying()) return;
    var id = pending;
    pending = null;
    lastSaid = id;
    window.MomoDirector.playNodes(nodesFor(id));
  });

  /* 供自动化验证用 */
  window.MomoWearTalk = {
    pending: function () { return pending; },
    lastSaid: function () { return lastSaid; },
    count: function () { return Object.keys(LINES).filter(function (k) { return k !== "note"; }).length; },
    lines: function (id) { return (LINES[id] || []).length; },
    nodes: function (id) { return nodesFor(id); },
    play: function (id) {
      if (!LINES[id]) return false;
      pending = null;
      return window.MomoDirector.playNodes(nodesFor(id));
    }
  };
})();
