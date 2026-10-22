/* 墨墨 · 开屏的两个入口
   这块是存档生命周期的分岔口，规则就一句话：

     新的故事 = 开一段全新的旅程：剧情、关系（心情/好感）、物资与金币、所在房间
                全部归零，从开场重新演一遍。玩家的积累留着 —— 学习进度、已解锁的
                服装与 CG 都不动（那是你自己挣来的，不是这一周目的剧情）。
     继续旅程 = 接着当前存档往下走。进度本来就一直在自动保存，所以直接回主画面，
                不用再绕一趟存档界面；想手动挑档位走「设置 → 读取档案」。

   新故事是不可逆的（剧情与数值整份抹掉），所以先弹一句确认。
   注意：原来「新的故事」只挂了个 data-goto=主画面，等于按了什么都不发生；
   「继续旅程」则指向存读档界面 —— 这两个都跟上面的语义对不上，所以在这里接管。 */
(function () {
  "use strict";
  var STORE = window.MomoStore;
  if (!STORE) return;
  var mask = null;

  function close() { if (mask) { mask.remove(); mask = null; } }

  /* 归零：只把「玩家积累」挑出来留下，其余交给 DEFAULT 补默认值 */
  function fresh() {
    var st = STORE.state;
    STORE.load({
      version: st.version,
      learn: st.learn,
      wardrobe: { unlocked: (st.wardrobe && st.wardrobe.unlocked) || [] },
      cg: { unlocked: (st.cg && st.cg.unlocked) || [] }
    });
  }

  function startNew() {
    if (window.MomoDirector) window.MomoDirector.stop();
    fresh();
    if (window.MomoUI) window.MomoUI.show("主画面");
  }

  function ask() {
    if (mask) return;
    mask = document.createElement("div");
    mask.id = "momo-confirm-mask";
    mask.innerHTML =
      '<div id="momo-confirm-panel">' +
        '<div class="cf-title">开一段新的故事？</div>' +
        '<div class="cf-sub">剧情进度、墨墨的心情与好感、物资与金币都会归零，' +
          '从开场重新演一遍。<br>' +
          '学习进度、已解锁的服装与 CG 会给你留着。</div>' +
        '<div class="cf-btns">' +
          '<button class="cf-btn" id="momo-confirm-no" type="button">再想想</button>' +
          '<button class="cf-btn cf-btn--main" id="momo-confirm-yes" type="button">' +
            '开始新的故事</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(mask);
    mask.querySelector("#momo-confirm-no").addEventListener("click", close);
    mask.querySelector("#momo-confirm-yes").addEventListener("click", function () {
      close();
      startNew();
    });
  }

  /* 「新的故事」要拦下来先问一句，所以用捕获阶段抢在 ui.js 的跳转之前。
     继续旅程不拦：它的 data-goto 已经改成主画面了。 */
  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest('#scr-开屏 [data-name="新的开始"]') : null;
    if (!b) return;
    e.stopPropagation();
    e.preventDefault();
    ask();
  }, true);

  window.MomoTitle = {
    state: function () { return { asking: !!mask }; },
    /* 供自动化验证用：不弹窗直接走一遍「开新档」 */
    startNew: startNew,
    reset: close
  };
})();