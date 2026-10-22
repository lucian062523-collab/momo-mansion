/* 墨墨 · 商城（2026-10-06 从死界面改活）
   「商城界面」六张卡原先零交互。现在：
     左列三张 = 真消费（补给：大礼包 / 小额 / 大额 —— 唯一合法的物资补给通道，
                价格换算对齐 lessons.json economy 的物资区间 5~15 金/点）
     右列三张 = 导览卡（词库 / 洋馆 / 服装 —— 不花钱，跳到对应界面）
   商品全部在 game/content/shop.json，改商品不碰这个文件。
   界面复用 PSD 原有六张卡图层，只改写每张卡的两个文字位（商品名 + 副行），
   小名牌显示货币余额。买不起先压暗给视觉预警，点了弹红字 —— 与送礼界面同一套规矩。 */
(function () {
  "use strict";
  var D = (window.MOMO_DATA || {}).shop;
  var STORE = window.MomoStore;
  if (!D || !STORE) return;
  var CARDS = D.cards || {};
  var L = D.labels || {};
  var scr = document.querySelector('[data-screen="商城界面"]');
  if (!scr) return;
  var bound = false, cardEls = [], curEl = null;

  function toast(msg, ok) {
    var t = document.getElementById("momo-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "momo-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = ok ? "toast-ok" : "toast-err";
    t.style.display = "block";
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.style.display = "none"; }, 1800);
  }

  function bind() {
    Object.keys(CARDS).forEach(function (name) {
      var el = scr.querySelector('[data-name="' + name + '"]');
      if (!el) return;
      var cfg = CARDS[name];
      cardEls.push({ el: el, cfg: cfg });
      /* 不 stopPropagation：ui.js 的互斥发光（data-glow=shop）照常工作 */
      el.addEventListener("click", function () { act(cfg); });
    });
    /* 货币读数：与「送礼:物品界面」同一个位置、同一套样式 —— 右下角一行
       无底板的深棕字（items.js curEl 的坐标/字体原样照搬）。原先摆在画面
       中部的小名牌（lL022）上：那是 PSD 的装饰牌、下面压着指北针尖角，
       读数放那里会盖住美术元素（用户 2026-10-06 拍板改到这里）。 */
    var stage = scr.querySelector(".stage") || scr;
    curEl = document.createElement("div");
    curEl.className = "item-currency";
    curEl.style.cssText =
      "position:absolute;left:1396px;top:946px;width:424px;height:96px;" +
      "display:flex;align-items:center;justify-content:flex-end;pointer-events:none;" +
      "font-family:'FZXiaoBiaoSong-B05S','方正小标宋简体',serif;font-size:42px;" +
      "letter-spacing:4px;color:#3b2921;text-shadow:0 1px 2px rgba(255,248,238,.75)";
    stage.appendChild(curEl);
    bound = true;
  }

  function act(cfg) {
    if (!cfg) return;
    if (cfg.kind === "redeem") {
      /* 钥匙卡 = 兑换码入口（钥匙本就是口令的意象；探索走主画面「地」键） */
      if (window.MomoRedeem) MomoRedeem.open();
      return;
    }
    if (cfg.kind === "goto") {
      if (cfg.goto && window.MomoUI) MomoUI.show(cfg.goto);
      return;
    }
    var price = cfg.price || 0;
    if ((STORE.state.currency || 0) < price) {
      toast((L.insufficient || "货币不足") + "：需 " + price + "，现有 " +
            Math.round(STORE.state.currency || 0), false);
      if (window.MomoAudio) MomoAudio.sfx("sfx-wrong");
      return;
    }
    var d = { currency: -price };
    var fx = cfg.fx || {};
    if (fx.supplies) d.supplies = fx.supplies;
    if (fx.mood) d.mood = fx.mood;
    if (fx.affection) d.affection = fx.affection;
    STORE.apply(d);                       /* 夹取 + 落盘 + 派发 momo:store */
    if (window.MomoAudio) MomoAudio.sfx("sfx-coin");
    toast("已购买 " + (cfg.name || "商品") + "　" + (cfg.effect || "") + "　−" + price, true);
  }

  function render() {
    if (!bound) return;
    cardEls.forEach(function (c) {
      var labels = [].slice.call(c.el.querySelectorAll(".btn-label"));
      var cfg = c.cfg;
      if (!labels.length) return;
      /* 卡中间那块米色区有 ~55% 宽的空位（美术上没画死任何字），
         PSD 原文字位偏窄 —— 这里放宽两行文字的框 */
      var name = labels[0], sub = labels[1];
      if (name) {
        name.textContent = cfg.name || "";
        name.style.left = "33%";
        name.style.width = "44%";
        name.style.letterSpacing = "2px";
      }
      if (sub) {
        sub.textContent = cfg.kind === "goto"
          ? (L.goto || "前 往 查 看")
          : cfg.kind === "redeem"
          ? (L.redeem_sub || "点击输入兑换码")
          : ((cfg.price || 0) + " 金 · " + (L.buy || "点击购买"));
        sub.style.left = "33%";
        sub.style.width = "44%";
        sub.style.fontSize = "24px";
        sub.style.letterSpacing = "2px";
        sub.style.color = cfg.kind === "buy" ? "#8a5a1e" : "#6d5233";
      }
      /* 买不起：整卡压暗先给视觉预警（点了仍会弹红字） */
      c.el.style.opacity =
        (cfg.kind === "buy" && (STORE.state.currency || 0) < (cfg.price || 0)) ? "0.55" : "";
    });
    if (curEl) curEl.textContent = (L.currency || "货币") + " " + Math.round(STORE.state.currency || 0);
  }

  document.addEventListener("momo:show", function (e) {
    if (!e.detail || e.detail.screen !== "商城界面") return;
    if (!bound) bind();
    render();
  });
  document.addEventListener("momo:store", function () { if (bound) render(); });
  if (scr.classList.contains("active")) { bind(); render(); }

  /* 供自动化验证用 */
  window.MomoShop = {
    state: function () {
      return { bound: bound, cards: cardEls.length,
               currency: Math.round(STORE.state.currency || 0),
               supplies: Math.round(STORE.state.supplies || 0) };
    }
  };
})();
