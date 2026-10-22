/* 墨墨 · 主画面「对话选择条」
   这两条（听墨墨的话 / 才不在意呢）是**分支选择控件**，不是常驻 UI：
   平时隐藏，只有对话走到需要玩家做选择时才弹出来。

   PSD 导出时它们默认是显示的，所以 index.html 上给整组挂了 is-hidden，
   弹出入口只留在这一个文件里 —— 将来剧本调度（director）走到选择节点时调 show()。

   用法：
     MomoChoice.show(["听墨墨的话", "才不在意呢"], function (i) {
       // i = 玩家点了第几条（0 起）
     });
     MomoChoice.hide();          // 手动收起
   点击某一条会自动收起并把下标回调出去；给几条就显示几条，多余的条隐藏。 */
(function () {
  "use strict";
  var box = null, bars = [];

  function bind() {
    var scr = document.querySelector('[data-screen="主画面"]');
    box = scr && scr.querySelector(".lL002");
    if (!box) return false;
    bars = [].slice.call(box.querySelectorAll('[data-glow="choice"]'));
    if (!bars.length) return false;
    bars.forEach(function (b, i) {
      if (b._wired) return;
      b._wired = 1;
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var cb = box._onPick;
        hide();
        if (typeof cb === "function") cb(i);
      });
    });
    return true;
  }

  function hide() {
    if (!box) return;
    box.classList.add("is-hidden");
    box._onPick = null;
    bars.forEach(function (b) { b.classList.remove("glowing"); });
  }

  function show(options, onPick) {
    if (!box && !bind()) return;
    if (!options || !options.length) return;
    /* 先弹出、再填字量宽 —— 原来是反的：整组还挂着 is-hidden（display:none）时
       clientWidth 恒为 0，fitLabel 每次都判定「超宽」一路缩到 20px 下限，
       于是选项字永远超级小。顺序换成：显示 → 填字 → 量宽。 */
    box.classList.remove("is-hidden");
    bars.forEach(function (b, i) {
      var opt = options[i];
      var label = b.querySelector(".btn-label");
      if (label && opt) {
        label.textContent = (typeof opt === "string") ? opt : (opt.text || "");
        /* 文字槽放宽到条幅中段的 76%：PSD 原来只给了 28%（按 5 字短句设计），
           长选项必然顶格。放宽后 6 字以内都用 PSD 原字号（38.3px）居中显示。 */
        label.style.left = "12%";
        label.style.width = "76%";
        label.style.justifyContent = "center";
        label.style.textAlign = "center";
        fitLabel(label);
      }
      b.style.display = opt ? "" : "none";       /* 项目少时多余的条一并隐藏 */
      b.classList.remove("glowing");
    });
    box._onPick = (typeof onPick === "function") ? onPick : null;
  }

  /* 选择条的基准字号（2026-10-12 调）。
     实测：选择条与旁白的 PSD 基准本来都是 38.3px，但这两条幅特别宽、选项又只有三五个字，
     38px 摆在正中看着就很小（作者原话：「字太小了，放大到跟旁白差不多」）。
     所以这里把基准抬到 48px；超长选项仍由下面按比例缩回去，不会顶到条幅金饰。 */
  var LABEL_PX = 48;
  /* 自动缩字：PSD 的文字槽位是按「5 字短选项」设计的（width 28%、38px、字距 7.7px），
     长选项必然顶到条幅右端的金饰上。填完字量一次实际宽度，超了就成比例缩
     字号与字距（最低缩到 24px），让字永远收进框里 —— 写多长都不会出格。 */
  function fitLabel(label) {
    if (!label) return;
    var t = label.textContent || "";
    var limit = 30;                                  /* 30 字以内都自动适配 */
    if (t.length > limit) label.textContent = t.slice(0, limit);
    label.style.fontSize = LABEL_PX + "px";          /* 先回到基准，再按需缩 */
    label.style.letterSpacing = "";
    var tries = 0;
    while (label.scrollWidth > label.clientWidth + 1 && tries < 8) {
      tries++;
      var fs = parseFloat(getComputedStyle(label).fontSize);
      var ls = parseFloat(getComputedStyle(label).letterSpacing) || 0;
      label.style.fontSize = Math.max(24, fs * 0.9) + "px";
      label.style.letterSpacing = Math.max(0, ls * 0.85) + "px";
    }
  }

  /* 脚本在 body 末尾，DOM 已解析，直接绑定；万一挪到 head 再兜底重试 */
  if (!bind()) document.addEventListener("DOMContentLoaded", bind);

  window.MomoChoice = {
    show: show,
    hide: hide,
    /* 供自动化验证用 */
    state: function () {
      return {
        visible: !!box && !box.classList.contains("is-hidden"),
        texts: bars.map(function (b) {
          var l = b.querySelector(".btn-label");
          return l ? l.textContent : "";
        })
      };
    }
  };
})();