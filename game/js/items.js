/* 墨墨 · 送礼 / 道具系统（赠送 = 购买）
   数据：game/content/items.json（51 件 / 食·用·礼 三分类 / 每页 12 件 / 每件有 price）
   接管「送礼:物品界面」的既有图层：
     物品格子 [data-glow=items] ×12   ← 格内嵌一层道具图，格子下方文字位写道具名
     分类签   [data-glow=cats]  ×3    ← 食 / 用 / 礼
     页码     [data-glow=pages] ×5    ← 超出实际页数的页码保留显示但不可点
     翻页     .lL016(next) / .lL017(prev)
     物品卡   .lL039                   ← 详情面板
   物品卡.png 是一整幅美术：图像窗口、−／＋ 步进器、底部按钮都画死在图里、没有独立图层。
   所以这里在卡片上叠三层透明热区（.card-hit）来赋予它们真实功能：
     − / ＋  = 数量加减（1–9）     底部按钮 = 赠送（按 单价 × 数量 扣货币）
   赠送即购买：余额不足则拦截、红色提示、不扣费也不加效果。 */
(function () {
  "use strict";
  var D = (window.MOMO_DATA || {}).items;
  var STORE = window.MomoStore;
  if (!D || !STORE) return;
  var U = window.ASSET_URI || {};
  var L = D.labels || {};
  function uri(img) { return U[img] || ""; }
  function bg(img) { return img ? 'url("' + uri(img) + '")' : "none"; }

  var CATS = D.categories || [];
  var PER = D.per_page || 12;
  var MAX_QTY = 9;
  var cat = CATS.length ? CATS[0].id : null;
  var page = 0;
  var selected = null;
  var qty = 1;

  function itemsOf(c) { return D.items.filter(function (it) { return it.cat === c; }); }
  function pageItems() {
    var list = itemsOf(cat), start = page * PER;
    return list.slice(start, start + PER);
  }
  function pageTotal() { return Math.max(1, Math.ceil(itemsOf(cat).length / PER)); }
  function labelText(el) {
    var l = el.querySelector(".btn-label");
    return l ? l.textContent.replace(/\s+/g, "") : "";
  }
  function fxText(fx, n) {
    if (!fx) return "";
    var p = [];
    function add(v, name) { if (v) p.push(name + (v * n > 0 ? "+" : "") + v * n); }
    add(fx.mood, "心情");
    add(fx.affection, "好感");
    add(fx.supplies, "物资");
    return p.join(" ");
  }
  function unitCost() { return selected ? (selected.price || 0) : 0; }
  function totalCost() { return unitCost() * qty; }
  function affordable() { return STORE.state.currency >= totalCost(); }

  var scr = null, slots = [], tabs = [], pageBtns = [], prevBtn = null, nextBtn = null;
  var card = null, cardName = null, cardDesc = null, cardQty = null;
  var cardArt = null, giveHit = null, giveLabel = null, curEl = null;

  /* ---------- 卡片上的透明热区 / 遮板 ---------- */
  function hitArea(cls, l, t, w, h, label) {
    var d = document.createElement("div");
    d.className = "card-hit " + cls;
    d.style.cssText = "left:" + l + "%;top:" + t + "%;width:" + w + "%;height:" + h + "%";
    if (label) {
      var sp = document.createElement("span");
      sp.className = "btn-label";
      sp.textContent = label;      /* 字号/字距/居中全部交给 common.css，避免内联覆盖 */
      d.appendChild(sp);
    }
    card.appendChild(d);
    return d;
  }

  function bind() {
    scr = document.querySelector('[data-screen="送礼:物品界面"]');
    if (!scr) return false;
    slots = [].slice.call(scr.querySelectorAll('[data-glow="items"]'));
    /* 12 个格子在 PSD 里是按「先下排、再中排、后上排」的图层顺序导出的，
       DOM 顺序并不等于视觉顺序。这里按实际坐标（上→下、左→右）重排，
       让道具列表从左上角开始自然排布，而不是从最下面一排冒出来。 */
    slots.sort(function (a, b) {
      var ca = getComputedStyle(a), cb = getComputedStyle(b);
      var ta = parseFloat(ca.top) || 0, tb = parseFloat(cb.top) || 0;
      if (Math.abs(ta - tb) > 1) return ta - tb;
      return (parseFloat(ca.left) || 0) - (parseFloat(cb.left) || 0);
    });
    tabs = [].slice.call(scr.querySelectorAll('[data-glow="cats"]'));
    pageBtns = [].slice.call(scr.querySelectorAll('[data-glow="pages"]'));
    prevBtn = scr.querySelector(".lL017");
    nextBtn = scr.querySelector(".lL016");

    card = scr.querySelector(".lL039");
    if (card) {
      var ls = [].slice.call(card.querySelectorAll(".btn-label"));
      cardName = ls[0] || null; cardDesc = ls[1] || null; cardQty = ls[2] || null;

      /* 卡片顶部图像窗口内嵌一层道具图（不动卡片自身的 background） */
      cardArt = document.createElement("div");
      cardArt.className = "card-art";
      cardArt.style.cssText = "position:absolute;left:17%;top:6%;width:66%;height:35%;" +
        "background-size:contain;background-position:center;background-repeat:no-repeat;" +
        "pointer-events:none";
      card.appendChild(cardArt);

      /* 描述那一格放「描述 / 效果 / 单价·合计」三行。
         几何按实测的卡片横线来定：三条正文横线在卡片高度的 55.1% / 60.1% / 65.1%，
         行距 37px（正好是相邻横线的间距）。所以让文字块从 51.5% 起、行高 37px、
         顶对齐（不能用 .btn-label 默认的垂直居中，否则整块会被居中而离线），
         这样三行的基线刚好压在那三条横线上，末行也就落在线上了。
         左右各留 9% 边距，避免文字贴到或越过金色边框。 */
      if (cardDesc) {
        cardDesc.style.left = "9%";
        cardDesc.style.width = "82%";
        cardDesc.style.top = "51.5%";
        cardDesc.style.height = "15%";
        cardDesc.style.fontSize = "21px";
        cardDesc.style.lineHeight = "37px";
        cardDesc.style.alignItems = "flex-start";
        cardDesc.style.justifyContent = "flex-start";
        cardDesc.style.textAlign = "left";
      }

      /* −／＋ 的符号和圆钮「物品卡.png」里已经画好了，所以这里绝不能再叠文字
         （叠了就是两个符号错位重影）。只叠一层透明热区把点击补上：
         按钮外观保持美术原样，功能由热区提供，悬停给圆形高亮当反馈。 */
      hitArea("card-hit--minus", 15, 67, 15, 11).addEventListener("click", function (e) {
        e.stopPropagation();
        qty = Math.max(1, qty - 1);
        render();
      });
      hitArea("card-hit--plus", 70, 67, 15, 11).addEventListener("click", function (e) {
        e.stopPropagation();
        qty = Math.min(MAX_QTY, qty + 1);
        render();
      });
      /* 赠送按钮：热区对齐美术里那块深色牌（实测 y 80.3%~89.9%、x 19.6%~81.4%）。
         之前热区偏上（中心 84%），文字在牌里就显得偏高；对上后中心 85.1%，上下才居中。 */
      giveHit = hitArea("card-hit--give", 19.5, 80.3, 61, 9.6, L.give || "赠送");
      giveHit.addEventListener("click", function (e) { e.stopPropagation(); give(); });
      giveLabel = giveHit.querySelector(".btn-label");
    }

    slots.forEach(function (s, i) {
      /* 格内嵌一层道具图：不能写格子自身的 backgroundImage，那是它的边框底图 */
      var th = document.createElement("div");
      th.className = "item-thumb";
      th.style.cssText = "position:absolute;left:12%;top:6%;width:76%;height:68%;" +
        "background-size:contain;background-position:center;background-repeat:no-repeat;" +
        "pointer-events:none";
      s.appendChild(th);
      s._thumb = th;
      s.addEventListener("click", function (e) {
        e.stopPropagation();
        var it = pageItems()[i];
        if (it) { selected = it; qty = 1; render(); }
      });
    });
    tabs.forEach(function (t) {
      t.addEventListener("click", function (e) {
        e.stopPropagation();
        var txt = labelText(t);
        for (var i = 0; i < CATS.length; i++) {
          if (CATS[i].label === txt) {
            cat = CATS[i].id; page = 0; selected = null; qty = 1; render(); return;
          }
        }
      });
    });
    pageBtns.forEach(function (p, i) {
      p.addEventListener("click", function (e) {
        e.stopPropagation();
        if (i >= pageTotal()) return;
        page = i; render();
      });
    });
    if (nextBtn) nextBtn.addEventListener("click", function () { turn(1); });
    if (prevBtn) prevBtn.addEventListener("click", function () { turn(-1); });

    /* 货币余额实时读数（界面原本没有货币位，这里按需补一个右下角读数字） */
    var stage = scr.querySelector(".stage") || scr;
    curEl = document.createElement("div");
    curEl.className = "item-currency";
    curEl.style.cssText = "position:absolute;left:1396px;top:946px;width:424px;height:96px;" +
      "display:flex;align-items:center;justify-content:flex-end;pointer-events:none;" +
      "font-family:'FZXiaoBiaoSong-B05S','方正小标宋简体',serif;font-size:42px;" +
      "letter-spacing:4px;color:#3b2921;text-shadow:0 1px 2px rgba(255,248,238,.75)";
    stage.appendChild(curEl);
    return true;
  }

  function turn(step) {
    var total = pageTotal();
    page = (page + step + total) % total;
    render();
  }

  /* ---------- 成功 / 失败提示 ---------- */
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

  /* ---------- 赠送（= 购买）：先校验货币，再一次性扣费 + 结算效果 ---------- */
  function give() {
    if (!selected) return;
    var cost = totalCost();
    if (STORE.state.currency < cost) {
      toast((L.insufficient || "货币不足") + "：需 " + cost + "，现有 " +
            Math.round(STORE.state.currency), false);
      render();
      return;
    }
    var d = { currency: -cost };
    var fx = selected.fx || {};
    if (fx.mood) d.mood = fx.mood * qty;
    if (fx.affection) d.affection = fx.affection * qty;
    if (fx.supplies) d.supplies = fx.supplies * qty;
    STORE.apply(d);                       /* 夹取 + 落盘 + 派发 momo:store */
    /* 送出去这件事本身要留个话头：gift-talk.js 收到后，等你回主画面就演这段回话 */
    document.dispatchEvent(new CustomEvent("momo:gift",
      { detail: { id: selected.id, name: selected.name, qty: qty } }));
    toast("已赠送 " + selected.name + (qty > 1 ? " ×" + qty : "") +
          "　" + fxText(fx, qty).replace(/\s+/g, " ") + "　−" + cost, true);
    render();
  }

  function render() {
    if (!scr) return;
    var list = pageItems();
    var total = pageTotal();

    if (selected && list.indexOf(selected) < 0) selected = null;
    if (!selected && list.length) selected = list[0];
    if (qty > MAX_QTY) qty = MAX_QTY;

    for (var i = 0; i < slots.length; i++) {
      var s = slots[i], it = list[i];
      if (s._thumb) s._thumb.style.backgroundImage = it ? bg(it.img) : "none";
      var lab = s.querySelector(".btn-label");
      if (lab) lab.textContent = it ? it.name : (L.empty || "空");
      s.style.pointerEvents = it ? "" : "none";
      s.classList.toggle("glowing", !!(it && selected && it.id === selected.id));
    }

    tabs.forEach(function (t) {
      var txt = labelText(t), c = null;
      for (var i = 0; i < CATS.length; i++) if (CATS[i].label === txt) c = CATS[i];
      t.classList.toggle("glowing", !!c && c.id === cat);
    });

    pageBtns.forEach(function (p, i) {
      p.classList.toggle("glowing", i === page && i < total);
      p.style.pointerEvents = i < total ? "" : "none";
      p.style.opacity = i < total ? "" : "0.35";
    });

    if (card) {
      if (cardArt) cardArt.style.backgroundImage = selected ? bg(selected.img) : "none";
      if (cardName) cardName.textContent = selected ? selected.name : "—";
      if (cardDesc) {
        cardDesc.textContent = selected
          ? selected.desc + "\n效果 " + fxText(selected.fx, 1) +
            "\n" + (L.unit || "单价") + " " + unitCost() + " · " +
            (L.total || "合计") + " " + totalCost()
          : (L.pick || "点左侧道具，在这里查看详情与价格。");
      }
      if (cardQty) cardQty.textContent = selected ? String(qty) : "";
      if (giveLabel) {
        giveLabel.textContent = (L.give || "赠 送") + (selected ? " " + totalCost() : "");
      }
      /* 余额不足时把赠送按钮压暗，先给一层视觉预警（点了仍会弹红字） */
      if (giveHit) giveHit.style.opacity = (selected && !affordable()) ? "0.5" : "";
    }

    if (curEl) curEl.textContent = (L.currency || "货币") + " " + Math.round(STORE.state.currency);
  }

  function onShow(e) {
    if (!e.detail || e.detail.screen !== "送礼:物品界面") return;
    if (!scr && !bind()) return;
    render();
  }
  document.addEventListener("momo:show", onShow);

  /* 货币/心情/物资一经改动（赠送、加减），立刻刷新读数与可用性 */
  document.addEventListener("momo:store", function () { render(); syncAttrs(); });

  /* ── 人物屏同步 ──
     ① 属性条：心情 / 物资两行接存档实时刷（健康/？？？按设计保持神秘与成长线）。
        旁边的 +/− 步进按钮是 PSD 演示件 —— 2026-10-06 起废用（骨架里已摘掉
        data-step，样式压暗不可点）：数值只能由学习产出 / 商城补给 / 日结算改动，
        随手加减等于把经济系统整个旁路掉。
     ② 好感五星：槽底图是空心的，这里按好感点亮（一颗 = 20%）。 */
  var ATTR_ROWS = { "心情": "mood", "物资": "supplies" };
  function rowKey(row) {
    var lab = row && row.querySelector(".btn-label");
    return lab ? ATTR_ROWS[lab.textContent.replace(/\s+/g, "")] : null;
  }
  function syncAttrs() {
    var p = document.querySelector('[data-screen="人物"]');
    if (!p) return;
    [].slice.call(p.querySelectorAll("[data-value]")).forEach(function (val) {
      var key = rowKey(val.closest(".grp") || val.parentNode);
      if (!key) return;
      val.textContent = Math.round(STORE.state[key]);
    });
    affectionStars();
  }
  document.addEventListener("momo:show", function (e) {
    if (e.detail && e.detail.screen === "人物") syncAttrs();
  });

  /* ── 好感五星（2026-10-06 由死图改活）──
     按好感**等级**点亮：Lv2 亮第 1 颗、Lv4 第 2 颗、Lv6 第 3 颗、Lv8 第 4 颗、
     Lv10 满天星 —— 与 lessons.json economy.affection.levels 的 Lv1~10 阈值对齐。
     为什么不用纯百分比（一颗 = 152 好感）：那要 30 天才亮第一颗，前一个月
     玩家看不到任何成长反馈；按等级的话 20 好感（约 4 天）就有第一颗星。
     PSD 原先只摆了两颗永远亮着的死星（lL030/lL031，骨架里已移除）。 */
  var starEls = null, starLit = -1;
  function starThresholds() {
    /* 10 档取第 2/4/6/8/10 档的门槛 = [20, 100, 240, 460, 760] */
    var L = (window.MOMO_DATA || {}).lessons || {};
    var lv = (((L.economy || {}).affection || {}).levels) ||
             [0, 20, 50, 100, 160, 240, 340, 460, 600, 760];
    return [lv[1], lv[3], lv[5], lv[7], lv[9]].map(function (v) { return v || 0; });
  }
  function affectionStars() {
    var p = document.querySelector('[data-screen="人物"]');
    var bar = p && p.querySelector('.lL029');
    if (!bar) return;
    if (!starEls) {
      var u = (window.ASSET_URI || {})["进度星星.png"];
      if (!u) return;
      starEls = [];
      for (var k = 0; k < 5; k++) {
        var s = document.createElement("i");
        s.className = "aff-star";
        /* 孔位坐标按 PSD：第一颗星 (1355.85, 216.64)、间距 36.46px；
           槽本体在 (1054, 173.69) —— 折算成槽内相对像素 */
        s.style.left = (301.85 + 36.46 * k) + "px";
        s.style.top = "42.95px";
        s.style.backgroundImage = 'url("' + u + '")';
        bar.appendChild(s);
        starEls.push(s);
      }
    }
    var aff = Math.max(0, STORE.state.affection || 0);
    var th = starThresholds();
    var lit = 0;
    for (var i = th.length - 1; i >= 0; i--) {
      if (aff >= th[i]) { lit = i + 1; break; }
    }
    for (var j = 0; j < 5; j++) {
      var on = j < lit;
      starEls[j].classList.toggle("on", on);
      /* 刚点亮的星星弹一下（首刷不算，别在开屏就乱跳） */
      if (on && starLit >= 0 && j >= starLit) {
        starEls[j].classList.remove("pop");
        void starEls[j].offsetWidth;
        starEls[j].classList.add("pop");
      }
    }
    starLit = lit;
  }
  syncAttrs();

  var s0 = document.querySelector('[data-screen="送礼:物品界面"]');
  if (s0 && s0.classList.contains("active")) onShow({ detail: { screen: "送礼:物品界面" } });

  /* 供自动化验证用的只读句柄 */
  window.MomoItems = {
    state: function () {
      return { cat: cat, page: page, total: pageTotal(), qty: qty,
               selected: selected ? selected.id : null,
               price: unitCost(), cost: totalCost(), currency: Math.round(STORE.state.currency),
               affordable: affordable(),
               pageIds: pageItems().map(function (it) { return it.id; }) };
    }
  };
})();