/* 墨墨 · 前言「走神背单词」演出（prologue-daze.js）
   用户定（《月见茶会前言》）：书房背 30 个新词——真弹出单词卡，玩家背过 10 个
   左右后，卡片上的字样越来越模糊、减淡、摇晃；翻过 5 张之后卡片开始**自行飞速翻
   动**，模拟走神感。演完广播 momo:daze_end，director 续播前言剧本。

   设计要点：
     · 词是真的：从当前语种词库随机抽（学英语出英语、学日语出日语）；
     · 前 5 张是正经背词（点击翻面看释义，再点下一张）；
     · 从第 6 张起进入「走神态」：卡面模糊 + 轻微摇晃 + 自动飞速翻页，点不点都
       自己走 —— 走神是失控，不该由玩家控制；
     · 结束整层淡出，画面回到书房场景，剧本无缝接旁白。 */
(function () {
  "use strict";
  var D = window.MOMO_DATA || {};
  var STORE = window.MomoStore;
  if (!D || !STORE) return;

  var COUNT = 10, DAZE_AT = 5;

  document.addEventListener("momo:daze", function (e) {
    var n = (e.detail && e.detail.count) || COUNT;
    var lang = ((STORE.state.learn || {}).lang === "ja") ? "ja" : "en";
    var pool = (lang === "ja" ? D.words_ja : D.words_en) || [];
    var picks = [];
    var seen = {};
    var guard = 0;
    while (picks.length < n && guard < 400) {
      guard++;
      var w = pool[Math.floor(Math.random() * pool.length)];
      if (!w || seen[w.id]) continue;
      seen[w.id] = 1;
      picks.push(w);
    }
    if (!picks.length) {
      document.dispatchEvent(new CustomEvent("momo:daze_end"));
      return;
    }
    run(picks, lang);
  });

  function run(words, lang) {
    var scr = document.querySelector('[data-screen="主画面"]');
    var stage = scr && scr.querySelector(".stage");
    if (!stage) {
      document.dispatchEvent(new CustomEvent("momo:daze_end"));
      return;
    }
    var root = document.createElement("div");
    root.className = "daze-ui";
    root.innerHTML =
      '<div class="daze-shade"></div>' +
      '<div class="daze-stage">' +
        '<p class="daze-hint">单 词 卡 片 · 点 击 翻 面</p>' +
        '<div class="daze-card"><div class="dc-front"></div><div class="dc-back"></div></div>' +
        '<p class="daze-prog"></p>' +
      '</div>';
    stage.appendChild(root);

    var card = root.querySelector(".daze-card");
    var front = root.querySelector(".dc-front");
    var back = root.querySelector(".dc-back");
    var prog = root.querySelector(".daze-prog");
    var i = 0, flipped = false, dazed = false, over = false, autoT = null;

    function form(w) {
      return w.lang === "ja" ? (w.kanji || w.kana || w.lemma) : w.lemma;
    }
    function sub(w) {
      return w.lang === "ja" ? (w.kana || "") + "　" + (w.romaji || "") : (w.pron || "");
    }
    function paint() {
      var w = words[i];
      var sp = document.createElement("span");
      sp.textContent = sub(w);
      front.innerHTML = "";
      front.appendChild(document.createTextNode(form(w)));
      front.appendChild(sp);
      back.textContent = w.meaning_zh || "";
      prog.textContent = (i + 1) + " / " + words.length;
      card.classList.remove("flip");
    }
    function advance() {
      if (over) return;
      if (flipped) {
        i++;
        flipped = false;
        if (!dazed && i >= DAZE_AT) dazed = true;
        if (dazed) root.classList.add("daze-on");
        if (i >= words.length) { end(); return; }
        paint();
        if (dazed && !autoT) autoTick();
      } else {
        flipped = true;
        card.classList.add("flip");
      }
    }
    function autoTick() {
      if (autoT || over) return;
      autoT = setInterval(function () {
        if (over) return;
        advance();
      }, 620);
    }
    function end() {
      over = true;
      if (autoT) clearInterval(autoT);
      root.classList.add("daze-out");
      setTimeout(function () {
        if (root.parentNode) root.parentNode.removeChild(root);
        document.dispatchEvent(new CustomEvent("momo:daze_end"));
      }, 700);
    }

    card.addEventListener("click", function (e) {
      e.stopPropagation();
      if (dazed) return;              /* 走神态：卡片自己走，点了也不理你 */
      advance();
    });
    /* 2026-10-20 评测修复：前 5 张只有点卡片才走，点画面空白处完全没反应 ——
       评委习惯性点屏幕正中时就会以为卡死（story-critic 实测卡 1.7 分钟）。
       这里让空白处也算「翻面/下一张」，与卡片同一条推进逻辑。 */
    root.addEventListener("click", function (e) {
      if (dazed || over) return;
      if (e.target && e.target.closest && e.target.closest(".daze-card")) return;
      advance();
    });

    paint();
  }
})();
