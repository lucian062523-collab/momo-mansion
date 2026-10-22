/* 墨墨 · 兑换码（redeem.js）
   背景：唯一的玩家就是作者本人，某天浏览器禁了控制台粘贴，连一行
   MomoStore.earn 都敲不进去，兜里只剩¥40 —— 于是有了这个正经系统。

   入口：商城界面的**钥匙卡**（shop.json kind=redeem，shop.js 点击后调 MomoRedeem.open）。
   钥匙本就是「口令」的意象；探索功能从主画面「地」键走，不占商城位。
   弹窗：与姓名录入同一套羊皮纸样式。校验成功 → 走 MomoStore 正门发钱/发物资
   → toast + 音效；一个码一个存档只能兑一次（store.state.redeemed 记账）。
   码表在 game/content/redeem.json —— 加码不用改这里。 */
(function () {
  "use strict";
  var D = (window.MOMO_DATA || {}).redeem;
  var STORE = window.MomoStore;
  if (!D || !STORE) return;
  var CODES = D.codes || {};

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

  /* ---------------- 弹窗（样式同姓名录入，id 独立） ---------------- */
  var mask = null, input = null;
  function open() {
    close();
    mask = document.createElement("div");
    mask.id = "momo-redeem-mask";
    mask.innerHTML =
      '<div id="momo-redeem-panel">' +
        '<div class="mn-title">兑 换 码</div>' +
        '<div class="mn-sub">输入兑换码，墨墨替你入账</div>' +
        '<input id="momo-redeem-input" type="text" maxlength="16" autocomplete="off" ' +
               'spellcheck="false" placeholder="在这里输入">' +
        '<div class="mn-btns">' +
          '<button class="mn-btn" id="momo-redeem-cancel" type="button">再想想</button>' +
          '<button class="mn-btn mn-btn--main" id="momo-redeem-ok" type="button">兑 换</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(mask);
    input = mask.querySelector("#momo-redeem-input");
    mask.querySelector("#momo-redeem-cancel").addEventListener("click", close);
    mask.querySelector("#momo-redeem-ok").addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submit();
    });
    /* 焦点要晚 30ms 才落（等弹窗挂稳）；捕获当次的 input —— submit 成功会立刻
       close() 把 input 置空，闭包里判存活，别让迟到的 focus 砸在 null 上 */
    var el = input;
    setTimeout(function () { if (el && el.parentNode) el.focus(); }, 30);
  }
  function close() {
    if (mask) { mask.remove(); mask = null; input = null; }
  }

  /* ---------------- 兑换 ---------------- */
  function used() {
    var S = STORE.state;
    if (!Array.isArray(S.redeemed)) S.redeemed = [];
    return S.redeemed;
  }
  function norm(s) { return String(s || "").toLowerCase().replace(/\s+/g, ""); }
  function submit() {
    if (!input) return;
    var raw = norm(input.value);
    if (!raw) { input.focus(); return; }
    var hit = null, hitKey = "";
    for (var k in CODES) {
      if (norm(k) === raw) { hit = CODES[k]; hitKey = k; break; }
    }
    if (!hit) {
      if (window.MomoAudio) MomoAudio.sfx("sfx-wrong");
      toast("兑换码不对哟。哼，想蒙我？", false);
      return;
    }
    var u = used();
    if (u.indexOf(hitKey) >= 0) {
      toast("「" + hitKey + "」已经兑过了。一个码只能一次，规矩。", false);
      return;
    }
    /* 到账：货币与物资都走正门（夹取 + 落盘 + 广播，商城/人物屏读数当场刷新） */
    if (hit.amount) MomoStore.earn(hit.amount, "redeem");
    if (hit.supplies) STORE.apply({ supplies: hit.supplies });
    u.push(hitKey);
    STORE.save();
    if (window.MomoAudio) MomoAudio.sfx("sfx-award");
    toast("兑换成功：" + (hit.amount ? ("货币 +" + hit.amount) : ("物资 +" + hit.supplies)) +
          (hit.note ? "　（" + hit.note + "）" : ""), true);
    close();
  }

  /* 供自动化验证用 */
  window.MomoRedeem = {
    open: open,
    enter: function (code) {
      open();
      if (input) input.value = code;
      submit();
    },
    used: function () { return used().slice(); },
    count: Object.keys(CODES).length
  };
})();
