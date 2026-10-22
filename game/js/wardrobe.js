/* 墨墨 · 真实换装系统
   数据：game/content/wardrobe.json（19 套 / 4 分类 / 每页 3 套）
   接管服装屏的既有图层，不新建界面：
     大模特 .lL016    ← 预览中的整套立绘
     卡片立绘 .lL015 / .lL017 / .lL018   ← 当前页三套
     分类签 [data-glow=wcats]            ← 四个分类
     翻页 .lL022(next) / .lL023(prev)
     穿戴按钮 [data-role=wear] ×3        ← 每张卡片下方
     确认 / 撤销（按标签文字识别）
     已解锁标签 .stage > .btn-label ×3   ← 三张卡片的状态文字
   交互：点卡片或穿戴按钮 = 预览换装；确认 = 落盘；撤销 = 回退到进入本屏时的状态。 */
(function () {
  "use strict";
  var D = (window.MOMO_DATA || {}).wardrobe;
  var STORE = window.MomoStore;
  if (!D || !STORE) return;
  var U = window.ASSET_URI || {};
  function uri(img) { return U[img] || ""; }
  function bg(img) { return img ? 'url("' + uri(img) + '")' : ""; }

  var S = STORE.state;
  var L = D.labels || {};

  /* ---- 初始化解锁状态 ----
     两套模型由 unlock_all_initial 二选一：
       true  = 全解锁（演示 / 截图用），把套装「并入」已有解锁表；
       false = 真实解锁：每分类免费前 2 套（pricing.free_sets），其余按价购买。
     切到收费模型时按 D.version 做一次迁移 —— 全解锁时代攒下的存档 unlocked 里有全部
     19 套，不退回免费名单的话，那 11 套收费套装会永远是「已解锁」，购买流程形同虚设。
     迁移只做一次（lock_version 记下做过哪个版本），以后买过的套装不会被退回去。 */
  var PRICE = (D.pricing || {}).by_set || {};
  if (!S.wardrobe.unlocked) S.wardrobe.unlocked = [];
  if (D.unlock_all_initial) {
    D.sets.forEach(function (s) {
      if (S.wardrobe.unlocked.indexOf(s.id) < 0) S.wardrobe.unlocked.push(s.id);
    });
  } else if (S.wardrobe.lock_version !== (D.version || 1)) {
    S.wardrobe.unlocked = ((D.pricing || {}).free_sets || [D.default_worn]).slice();
    S.wardrobe.lock_version = D.version || 1;
  }
  /* 身上这套必须是自己拥有的：旧存档可能正穿着某件现在要花钱的 —— 退回默认套装 */
  if (!S.wardrobe.worn || !isUnlocked(S.wardrobe.worn)) {
    S.wardrobe.worn = isUnlocked(D.default_worn)
      ? D.default_worn : (S.wardrobe.unlocked[0] || D.default_worn);
  }
  STORE.save();

  function isUnlocked(id) { return S.wardrobe.unlocked.indexOf(id) >= 0; }
  function priceOf(id) { return PRICE[id] || 0; }
  function setById(id) {
    for (var i = 0; i < D.sets.length; i++) if (D.sets[i].id === id) return D.sets[i];
    return null;
  }
  /* 一个分类里要显示的套装，按「自己的」在「没买的」前面排。
     排序规则（用户要求）：
       · 已解锁的整批排在前面 —— 玩家最常做的是「换成我已经有的那套」，
         翻到第 3 页才能看到自己有的衣服是很别扭的；
       · 未解锁的接在后面，按价格从低到高 —— 一眼看出「下一个买得起的是谁」；
       · 两批内部都**保持 wardrobe.json 里的声明顺序**（那是美术排的，有意义），
         已解锁那批不再按价格排：免费送的与买来的混在一起按价格排，
         只会让「我有什么」看起来乱七八糟。

     注意依赖 `Array.prototype.sort` 的稳定性（ES2019 起是硬性规定，所有目标浏览器
     都满足）：比较器给不出高低时返回 0，原有的先后就得以保留。这里必须稳定 ——
     同价的套装如果每次 render 都可能换位，卡片会在玩家眼前莫名跳动。
     另外 list 是 filter 出来的新数组，就地排序不会动到 D.sets 本身。 */
  function setsOf(cat) {
    return D.sets.filter(function (s) { return s.cat === cat; }).sort(function (a, b) {
      var ua = isUnlocked(a.id) ? 0 : 1, ub = isUnlocked(b.id) ? 0 : 1;
      if (ua !== ub) return ua - ub;
      return ua ? priceOf(a.id) - priceOf(b.id) : 0;
    });
  }
  /* 某套在当前排序下落在第几页。买下之后要跟着它翻页用（见 buy）。 */
  function pageOf(id) {
    var list = setsOf(cat);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return Math.floor(i / D.per_page);
    }
    return page;
  }

  /* ---- 状态 ---- */
  var cat = D.categories[0].id;
  var page = 0;
  var preview = S.wardrobe.worn;  // 预览（未落盘）
  var revertTo = S.wardrobe.worn; // 撤销目标

  /* ---- DOM ---- */
  var scr = null, model = null, namePlate = null, prevBtn = null, nextBtn = null;
  var cards = [], wearBtns = [], tabs = [], statusLabels = [], confirmBtn = null, cancelBtn = null;
  var badges = [];        /* 三张卡片右上角的「多少钱」小牌（只有未解锁的才显示） */

  /* 分类签文字是「生 活」这种带字距空格的写法，比较前必须去掉所有空白，
     否则 categories[i].label === txt 永远不相等 —— 分类签会完全失灵。 */
  function labelText(el) {
    var l = el.querySelector(".btn-label");
    return l ? l.textContent.replace(/\s+/g, "") : "";
  }
  function bind() {
    scr = document.querySelector('[data-screen="服装"]');
    if (!scr) return false;
    var st = scr.querySelector(".stage");
    model = scr.querySelector(".lL016");
    cards = [".lL015", ".lL017", ".lL018"].map(function (c) { return scr.querySelector(c); });
    var frames = [].slice.call(scr.querySelectorAll('[data-glow="cards"]')); // 三张白框
    /* 分类签：必须排除外层分组。
     坑：分组 lL028 自己也带 data-glow="wcats"，而它是四个分类签的父元素。
     若不排除，点任何分类都会冒泡到分组，而分组的 labelText 会取到第一个子标签
     （生活），把分类覆盖回「生活」—— 表现为「按了切换不到对应服装池」。 */
    tabs = [].slice.call(scr.querySelectorAll('[data-glow="wcats"]')).filter(function (t) {
      return !t.classList.contains("group") && t.querySelector(".btn-label");
    });
    wearBtns = [].slice.call(scr.querySelectorAll('[data-role="wear"]'));
    prevBtn = scr.querySelector(".lL023");
    nextBtn = scr.querySelector(".lL022");
    namePlate = scr.querySelector(".lL021");
    statusLabels = [].slice.call(st.querySelectorAll(":scope > .btn-label"));

    /* 确认 / 撤销：PSD 里的 data-name 与文字是反的，按文字认最稳 */
    [].slice.call(scr.querySelectorAll('[data-variant]')).forEach(function (b) {
      var t = labelText(b).replace(/\s/g, "");
      if (t === "确认") confirmBtn = b;
      if (t === "撤销") cancelBtn = b;
    });

    /* 价格牌：未解锁的卡片右上角挂一枚小牌写着要花多少 —— 不写价格、
       点了才知道要掏钱，那是耍人。挂在白框上（卡片图的 background 动不得）。 */
    frames.forEach(function (f, i) {
      var p = document.createElement("div");
      p.className = "momo-price";
      p.style.display = "none";
      f.appendChild(p);
      badges[i] = p;
      /* 卡片白框点击 = 选中该卡片的套装（只预览，不落盘；未解锁也能试穿） */
      f.addEventListener("click", function (e) {
        e.stopPropagation();
        selectCard(i);
      });
    });
    /* 卡片下沿那块小牌既是状态牌、也是唯一的动作入口：
         已解锁 → 穿上并落盘；
         未解锁 → 按价购买（余额不足则拦截，什么都不改）。
       白框（卡片本身）只负责试穿预览，绝不落盘。 */
    wearBtns.forEach(function (b, i) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var s = pageSets()[i];
        if (!s) return;
        if (!isUnlocked(s.id)) { buy(s); return; }
        var prev = S.wardrobe.worn;
        preview = revertTo = S.wardrobe.worn = s.id;
        STORE.save();
        if (prev !== s.id) armTalk(s.id);
        render();
      });
    });
    tabs.forEach(function (t) {
      t.addEventListener("click", function (e) {
        e.stopPropagation();
        var txt = labelText(t);
        for (var i = 0; i < D.categories.length; i++) {
          if (D.categories[i].label === txt) { cat = D.categories[i].id; page = 0; render(); return; }
        }
      });
    });
    if (nextBtn) nextBtn.addEventListener("click", function () { turn(1); });
    if (prevBtn) prevBtn.addEventListener("click", function () { turn(-1); });
    if (confirmBtn) confirmBtn.addEventListener("click", function () { commit(); });
    if (cancelBtn) cancelBtn.addEventListener("click", function () { rollback(); });
    return true;
  }

  function pageSets() {
    var list = setsOf(cat);
    var start = page * D.per_page;
    return list.slice(start, start + D.per_page);
  }
  function pageTotal() {
    return Math.max(1, Math.ceil(setsOf(cat).length / D.per_page));
  }
  function turn(step) {
    var total = pageTotal();
    page = (page + step + total) % total;
    render();
  }
  /* 试穿 = 只改本屏的预览立绘，绝不写 wardrobe.worn。
     未解锁的套装也能试穿（用户要求），但一切到别的界面就自动还原成真正穿着的那套；
     要真的穿出去，得先在下方小牌上把它买下来。 */
  function selectCard(i) {
    var s = pageSets()[i];
    if (!s) return;
    preview = s.id;
    render();
  }
  function commit() {
    if (!isUnlocked(preview)) {
      toast(L.locked_tip || "未解锁 · 点卡片下方的小牌就能买下它", false);
      return;
    }
    var prev = S.wardrobe.worn;
    S.wardrobe.worn = preview;
    STORE.save();
    revertTo = preview;
    syncCostume();                      // 确认 = 立刻换到所有界面上的立绘
    if (prev !== preview) armTalk(preview);
    render();
  }
  function rollback() {
    preview = revertTo;
    render();
  }

  /* 购买：先过货币这关，再把它写进 wardrobe.unlocked —— 之后就是普通的「已解锁」。
     花钱统一走 STORE.spend（source=purchase），余额不足它直接返回 false，不扣也不改。 */
  function buy(s) {
    var price = priceOf(s.id);
    if (!STORE.spend(price, "purchase")) {
      toast((L.not_enough || "货币不足") + "：需 " + price + "，现有 " +
            Math.round(STORE.state.currency || 0), false);
      return;
    }
    var prev = S.wardrobe.worn;
    if (S.wardrobe.unlocked.indexOf(s.id) < 0) S.wardrobe.unlocked.push(s.id);
    S.wardrobe.worn = s.id;
    preview = revertTo = s.id;
    STORE.save();
    syncCostume();
    if (prev !== s.id) armTalk(s.id);
    toast("已解锁「" + (s.name || "") + "」　−" + price, true);
    /* 刚买下的这套立刻归入「已解锁」那批、按规则飘到前面去，所以得跟着它翻页 ——
       否则玩家会看到自己刚点的卡片凭空换成别的套装，还以为买错了。 */
    page = pageOf(s.id);
    render();
  }

  /* 提示条：跟送礼界面、日结算用同一个 #momo-toast，样式在 common.css */
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

  /* 换装回话（2026-10-06）：穿着真的变了（穿戴/确认/买下后自动穿上）就广播给
     wardrobe-talk.js —— 它存 pending，等回主画面、没有别的演出在跑时再演。
     只在这里派事件，台词与演出都不归本文件管（分层与 gift-talk 一致）。 */
  function armTalk(id) {
    document.dispatchEvent(new CustomEvent("momo:wear", { detail: { id: id } }));
  }

  function render() {
    if (!scr) return;
    var list = pageSets();
    var total = pageTotal();

    /* 大模特：预览中的整套 */
    var pv = setById(preview);
    if (model && pv) model.style.backgroundImage = bg(pv.img);

    /* 三张卡片 */
    for (var i = 0; i < 3; i++) {
      var s = list[i];
      var cardEl = cards[i];
      if (cardEl) cardEl.style.backgroundImage = s ? bg(s.img) : "none";
      var unlocked = s ? isUnlocked(s.id) : false;
      /* 未解锁的卡片压暗：一眼看出哪些还没买，不必逐个读小牌上的字 */
      if (cardEl) cardEl.style.opacity = s ? (unlocked ? "1" : "0.55") : "0";
      /* 状态文字：已穿戴 > 已解锁 > 未解锁 */
      var lab = statusLabels[i];
      if (lab) {
        if (!s) { lab.style.opacity = "0"; }
        else {
          lab.style.opacity = "1";
          lab.textContent = (s.id === S.wardrobe.worn) ? (L.worn || "已穿戴")
                          : unlocked ? (L.unlocked || "已解锁")
                                     : (L.locked || "未解锁");
        }
      }
      /* 卡片下沿那块小牌：空位也保留，卡片才完整。
         有套装就能点 —— 已解锁是「穿」，未解锁是「买」。 */
      var wb = wearBtns[i];
      if (wb) {
        wb.style.display = "";
        wb.style.pointerEvents = s ? "" : "none";
      }
      var bd = badges[i];
      if (bd) {
        var show = !!s && !unlocked && priceOf(s.id) > 0;
        bd.style.display = show ? "" : "none";
        if (show) bd.textContent = priceOf(s.id) + " 金";
      }
    }

    /* 卡片前板（白框）：空位也保留 —— 扣上它才不会只剩一个光秃秃的背板。
       只是把「发光高亮」限定在有套装的那张上，并让空位不可点。 */
    [].slice.call(scr.querySelectorAll('[data-glow="cards"]')).forEach(function (f, i) {
      var s = list[i];
      f.classList.toggle("glowing", !!(s && s.id === preview));
      f.style.pointerEvents = s ? "" : "none";
    });

    /* 分类签高亮（labelText 已去空白，能与 categories 的 label 对上） */
    tabs.forEach(function (t) {
      var txt = labelText(t);
      var c = null;
      for (var i = 0; i < D.categories.length; i++)
        if (D.categories[i].label === txt) c = D.categories[i];
      t.classList.toggle("glowing", !!c && c.id === cat);
    });
  }

  function onShow(e) {
    if (!e.detail || e.detail.screen !== "服装") return;
    if (!scr && !bind()) return;
    revertTo = preview = S.wardrobe.worn;  // 每次进入本屏重置撤销基线
    render();
  }
  document.addEventListener("momo:show", onShow);

  /* 直接以 #服装 打开时也要初始化 */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      if (document.querySelector('[data-screen="服装"]').classList.contains("active")) onShow({ detail: { screen: "服装" } });
    });
  } else {
    var s0 = document.querySelector('[data-screen="服装"]');
    if (s0 && s0.classList.contains("active")) onShow({ detail: { screen: "服装" } });
  }

  /* ---- 角色立绘同步：换装落盘后，所有标记了 data-costume 的墨墨立绘一起换 ----
     为什么单列一个出口：上面的 render() 只负责「服装屏」内的预览与卡片，
     换装结果（S.wardrobe.worn）在此之前没有任何人回写到别屏的角色图层，
     所以点了确认再回主界面，立绘纹丝不动。
     为什么用 data-costume 标记、而不是在 JS 里写死选择器：以后任何界面只要展示
     墨墨立绘，在 index.html 给该图层加 data-costume 即可自动纳入，无需改这里。 */
  /* setKey = 这套衣服的标识（套装底图名）。
     淡入**只在真的换了套装时**做 —— 表情变化走同一个出口，但必须立刻换图：
     原来是「只要底图变了就压暗到 0.5 再推回」，于是每换一次表情立绘都闪一下（作者报的 bug）。 */
  function applyCostume(el, url, setKey) {
    var cur = el.style.backgroundImage;
    var key = setKey || "";
    if (cur === url) return;
    /* 首次落图直接换，别让开场也多一次淡入 */
    if (!cur) { el.style.backgroundImage = url; el.dataset.costumeSet = key; return; }
    /* 同一套衣服、只是换表情：立刻换图，不加过渡（不然会闪） */
    if (el.dataset.costumeSet === key) { el.style.backgroundImage = url; return; }
    /* 真的换套装：瞬间先压暗到 0.5，再让 CSS 的 opacity 过渡把它推回 1 —— 一帧内完成，
       图是内存里的 data URI、不存在加载延迟，所以只会有平滑淡入、不会白屏闪烁 */
    el.dataset.costumeSet = key;
    el.style.transition = "none";
    el.style.opacity = "0.5";
    el.style.backgroundImage = url;
    requestAnimationFrame(function () {
      el.style.transition = "";
      el.style.opacity = "";
    });
  }
  /* 立绘图：套装默认图 → 该图层标了 data-expr（且不是「默认」）时换成这套的表情图。
     表情表 expressions.json 由 _tools/build_expr_map.py 扫素材生成；
     查不到就用默认图（例如某套还没画这个表情），保证角色永远有立绘。
     表情刻意不作为独立模块去抢 backgroundImage —— 归 wardrobe 一处渲染，
     「换套装」和「换表情」两个维度才不会互相盖掉。 */
  function spriteUrl(s, expr) {
    var EX = (window.MOMO_DATA || {}).expressions || {};
    var u = uri(s.img);
    if (!expr || expr === (EX.default || "默认")) return u;
    var m = (EX.sets || {})[s.img];
    var f = m && m[expr];
    return (f && U[f]) || u;
  }
  /* 表情图预热（2026-10-20，作者报「每换一个表情立绘会闪一下」）：
     拆分构建下表情是 assets/ 里的外链 webp，不是 data URI —— 换表情等于换 URL，
     新图要现下现解码，于是会有一帧空白。这里在首次落到这套衣服时就把它的
     全部表情图丢进浏览器缓存（一套约 8~10 张、1MB 出头），之后的切换是瞬时的。
     只预热**当前套装**：57 套全预热是 80MB，那是另一种灾难。 */
  var WARMED = {};
  function warmExpressions(s) {
    if (!s || WARMED[s.img]) return;
    var EX = (window.MOMO_DATA || {}).expressions || {};
    var m = (EX.sets || {})[s.img];
    if (!m) return;
    WARMED[s.img] = 1;
    Object.keys(m).forEach(function (k) {
      var u = U[m[k]];
      if (!u) return;
      var im = new Image();
      im.decoding = "async";
      im.src = u;
    });
  }

  function syncCostume(only) {
    /* worn 缺失或对应套装不存在时，回退到默认套装，保证角色永远有立绘 */
    var s = setById(S.wardrobe.worn) || setById(D.default_worn);
    if (!s) return;
    [].slice.call(document.querySelectorAll("[data-costume]")).forEach(function (el) {
      var scr = el.closest ? el.closest(".screen") : null;
      if (only && (!scr || scr.dataset.screen !== only)) return;
      var u = spriteUrl(s, el.dataset.expr);
      if (u) applyCostume(el, 'url("' + u + '")', s.img);
    });
    warmExpressions(s);
  }
  /* 读档 / 开新档会把 STORE.state 整份换成新对象（MomoStore.load），
     而本文件开头就把旧对象存进了 S —— 不重新取一次，之后所有解锁、穿戴都写进那份
     已经没人看的旧存档里，界面上看着正常、「确认」却永远不生效。 */
  document.addEventListener("momo:store", function (e) {
    if (!e.detail || !e.detail.loaded) return;
    S = STORE.state;
    revertTo = preview = S.wardrobe.worn;
    if (scr) render();
    syncCostume();
  });
  /* 表情由 expr.js 写在 data-expr 上，写完广播 momo:expr，这里重画 */
  document.addEventListener("momo:expr", function () { syncCostume(); });
  /* 进入某屏时同步（ui.js 的 show() 会派发 momo:show） */
  document.addEventListener("momo:show", function (e) {
    if (e.detail) syncCostume(e.detail.screen);
  });
  /* 首屏若直接落在主画面/人物屏，上面那次 momo:show 早于本文件执行、收不到，
     所以这里先把所有立绘渲染好；之后切屏不会再有多余动画。 */
  syncCostume();

  /* 供自动化验证用的只读句柄 */
  window.MomoWardrobe = {
    state: function () {
      var list = pageSets();
      return {
        cat: cat, page: page, total: pageTotal(),
        worn: S.wardrobe.worn,
        unlocked: S.wardrobe.unlocked.slice(),
        preview: preview, revertTo: revertTo,
        currency: Math.round(STORE.state.currency || 0),
        free: ((D.pricing || {}).free_sets || []).slice(),
        priceOf: (list[0] ? priceOf(list[0].id) : 0),
        cards: list.map(function (s) {
          return { id: s.id, price: priceOf(s.id), unlocked: isUnlocked(s.id) };
        }),
        /* 整个分类**当前的排序**（不只是这一页）。排序规则是对全量说的，
           只断言「第一页长什么样」验证不到它，所以把整串顺序也交出来。 */
        order: setsOf(cat).map(function (s) {
          return { id: s.id, price: priceOf(s.id), unlocked: isUnlocked(s.id) };
        }),
        labels: statusLabels.map(function (e) { return e.textContent; }),
        badges: [].slice.call(scr.querySelectorAll(".momo-price")).map(function (e) {
          return { text: e.textContent, shown: e.style.display !== "none" };
        }),
        /* 未解锁的卡片下沿小牌必须点得到（试穿/购买都从这儿走） */
        wearClickable: wearBtns.map(function (b) {
          var r = b.getBoundingClientRect();
          return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b;
        })
      };
    }
  };
})();