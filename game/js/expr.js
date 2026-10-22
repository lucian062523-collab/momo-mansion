/* 墨墨 · 立绘表情
   用法：  MomoExpr.set("不悦")   /   MomoExpr.reset()

   只说「现在是哪个表情」，具体换哪张图不归这里管 —— 换图在 wardrobe.js：
   它才知道当前穿的是哪一套、那一套的表情文件叫什么（表在 expressions.json）。
   这么分工的好处是「换套装」与「换表情」两个维度互不打架：
   换完套装再换表情、或者演到一半换了套装，立绘都还是对的。

   表情名见 game/content/expressions.json（欲言又止 / 不悦 / 害羞 / 惊讶 / 悲伤 …）；
   写「默认」或直接 reset() 就回到套装的默认立绘。 */
(function () {
  "use strict";
  var DEFAULT = "默认";

  function layers() {
    return [].slice.call(document.querySelectorAll("[data-costume]"));
  }

  function set(name) {
    var n = name || DEFAULT;
    layers().forEach(function (el) { el.dataset.expr = n; });
    /* wardrobe.js 监听这个事件重画立绘；广播出去，将来别的展示层也能跟上 */
    document.dispatchEvent(new CustomEvent("momo:expr", { detail: { expr: n } }));
    return n;
  }

  function reset() { return set(DEFAULT); }

  function current() {
    var el = layers()[0];
    return (el && el.dataset.expr) || DEFAULT;
  }

  window.MomoExpr = {
    DEFAULT: DEFAULT,
    set: set,
    reset: reset,
    current: current,
    /* 供自动化验证用 */
    state: function () { return { expr: current() }; }
  };
})();