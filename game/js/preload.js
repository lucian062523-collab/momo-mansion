/* 墨墨 · 首屏「把美术资产搬进本地」
 *
 * 问题：这个游戏 790 张图、约 125MB。以前全靠浏览器边走边下 —— 手机上一进
 * 主画面就是一段黑屏，转到哪个界面就卡哪个界面，网络一抖还会掉进浏览器
 * 自己的报错页。用户的原话是「每次开屏都黑很长一段时间」。
 *
 * 做法：第一次进来，先把全部插画一次性搬进 Cache Storage（配一条进度条，
 * 让玩家知道这段等待是在下美术资产，而不是坏了），搬完之后由 UI还原/sw.js
 * 从本地供给 —— 再进来就是秒开，断网也能玩。
 *
 * 几条要紧的规矩：
 *   · **绝不把游戏堵死**。file:// 直开、老浏览器、?nosw 调试、清单为空 —— 一律
 *     直接放行。产物验证（_tools/verify_items.py）就是 file:// 跑的，这条同时也是
 *     那套测试能继续用的前提。
 *   · 每张图自己 fetch + cache.put，不指望 SW 帮我们写：首次访问时新装的 SW 还
 *     没接管当前页面（clients.claim 生效有先后），靠它就会「进度条走完但缓存是空的」。
 *   · 重试但不纠缠：单张最多 3 次，失败先记下来继续搬别的 —— 一张 404 不该让整轮
 *     搬运白干。最后统一提示，点重试只补没下下来的（已下好的不会再来一遍）。
 *   · 配额兜底：iOS 给 Cache Storage 的额度是有限的，真撞上 QuotaExceededError 就
 *     停下来说清楚，而不是无声地无限重试。
 *
 * 下面 CACHE 这个常量必须与 UI还原/sw.js 里的同名常量一致（构建会核对）。
 */
(function () {
  "use strict";

  var CACHE = "momo-assets-v1";

  var CONCURRENCY = 6;   // 同时下 6 张。再多对手机没好处，反而容易整批超时
  var TRIES = 3;
  var QUIET_KEY = "momo.preload.quota";   // 上次因为存储配额不够而中断过
  /* 放行门槛：清单已经按 RANK 排过序（界面 0 → 场景 1 → 道具 2 …），所以取前 13MB
     就正好是「界面 + 音频 + 开场那几张场景」。这一小批到手就让玩家进去，剩下的
     继续在后台依次搬 —— 原来要等满 136.6MB 才准玩，手机上是几分钟的死等。 */
  var GATE_BYTES = 13 * 1048576;

  var box = document.getElementById("boot");
  if (!box) return;

  var LIST = window.MOMO_ASSETS || [];

  /* 能不能用这套。不能用就直接让游戏照常跑 —— 这是本模块最重要的一条分支。 */
  var usable = ("serviceWorker" in navigator) && ("caches" in window) &&
               location.protocol !== "file:" &&
               !/[?&]nosw(=|&|$)/.test(location.search);
  if (!usable || !LIST.length) {
    window.MomoPreload = { off: true, reason: !LIST.length ? "no-list" : (location.protocol === "file:" ? "file" : "unsupported") };
    drop();
    return;
  }

  var fill = document.getElementById("boot-fill");
  var numEl = document.getElementById("boot-num");
  var pctEl = document.getElementById("boot-pct");
  var totalEl = document.getElementById("boot-total");
  var errEl = document.getElementById("boot-err");
  var actsEl = document.getElementById("boot-acts");
  var retryEl = document.getElementById("boot-retry");
  var skipEl = document.getElementById("boot-skip");

  var TOTAL = 0;
  for (var i = 0; i < LIST.length; i++) TOTAL += LIST[i][1];

  /* 计数只在「本次打开」里累加（重试不重置）。
     GATE_* 是「放行前那一批」的口径：进度条与百分比只对首批负责，
     首批到手就撤掉遮挡，剩下的大部队在后台搬，不占玩家的时间。 */
  var done = 0, bytes = 0, failed = [], stopped = false, cache = null;
  var GATE_TOTAL = TOTAL, GATE_COUNT = LIST.length;
  var t0 = Date.now();

  function setGate(todo) {
    GATE_TOTAL = 0;
    for (var i = 0; i < todo.length; i++) GATE_TOTAL += todo[i][1];
    GATE_COUNT = todo.length;
    if (totalEl) totalEl.textContent = mb(GATE_TOTAL) + " MB";
  }

  function abs(u) { return new URL(u, document.baseURI).href; }
  function mb(n) { return (n / 1048576).toFixed(1); }

  function drop() { if (box.parentNode) box.parentNode.removeChild(box); }

  /* now=true 直接摘掉，不做淡出 —— 给「已经全在本地、无事可做」那一条用：
     那时候连 0.42 秒的淡出都嫌长，玩家看到的是「打开就闪一下 0 / 0 张」的鬼影。 */
  function hide(now) {
    if (now) { drop(); return; }
    box.classList.add("boot-out");
    setTimeout(drop, 420);
  }

  /* 上次已经撞过存储配额 —— 这次不再拦人，改成**后台静默**接着搬。
     拦着的代价是每次打开都被挡一次「正在搬运」，那不能接受；静默搬的好处是
     只要空间被腾出来，下一次就能自己把缺的补齐。 */
  var quiet = false;
  try { quiet = localStorage.getItem(QUIET_KEY) === "1"; } catch (e) {}
  if (quiet) hide(true);       // 立刻让开（不要淡出）：玩家不该再为搬运等一次

  /* 停下来说明情况。一定同时给出「先进去」—— 下不完就把人锁在外面是最坏的结果：
     图缺几张顶多是那几处空着（进游戏时会临时从网上取），进不去是彻底玩不了。 */
  function stop(msg) {
    stopped = true;
    if (quiet || silentPhase) return;   // 静默模式 / 后台批：一个字都不弹，游戏照常开始
    errEl.textContent = msg;
    errEl.hidden = false;
    actsEl.hidden = false;
  }

  function eta() {
    var secs = (Date.now() - t0) / 1000;
    if (bytes < 1048576 || secs < 3) return "";
    var left = (GATE_TOTAL - bytes) / (bytes / secs);
    if (!isFinite(left) || left <= 0) return "";
    return left > 90 ? " · 约剩 " + Math.round(left / 60) + " 分" : " · 约剩 " + Math.round(left) + " 秒";
  }

  function paint() {
    var pct = GATE_TOTAL ? Math.min(100, Math.round(bytes / GATE_TOTAL * 100)) : 0;
    fill.style.width = pct + "%";
    numEl.textContent = done + " / " + GATE_COUNT + " 张";
    pctEl.textContent = mb(bytes) + " MB · " + pct + "%" + eta();
  }

  function one(item) {
    return fetch(item[0], { credentials: "same-origin" }).then(function (res) {
      if (!res || !res.ok) throw new Error("HTTP " + (res && res.status));
      // put 会把 body 消费掉，后面不再用这个 res，所以不 clone
      return cache.put(abs(item[0]), res).then(function () { return item[1]; });
    });
  }

  function attempt(item, left) {
    return one(item).then(function (got) {
      done++; bytes += got || 0; paint();
    }, function (e) {
      if (e && e.name === "QuotaExceededError") {
        try { localStorage.setItem(QUIET_KEY, "1"); } catch (e2) {}
        stop("这台机器给网页的存储空间不够放下全部插画，先搬到这里。" +
             "已经存下来的照样能用，剩下的进游戏时临时从网上取。" +
             "下次打开不会再拦你，会在后台悄悄接着搬。");
        throw e;
      }
      if (left > 0) {
        return new Promise(function (r) { setTimeout(r, 400); }).then(function () { return attempt(item, left - 1); });
      }
      failed.push(item[0]);
      done++; paint();          // 算它走完了，进度条才不会永远差几格
    });
  }

  /* 把「还没缓存」的条目列出来。带内容哈希的 URL 一旦存下就永远有效，
     所以这里天然是增量的：改了哪张图，只有那张图的 URL 会变。 */
  function missing(cache) {
    return cache.keys().then(function (keys) {
      var have = Object.create(null);
      keys.forEach(function (r) { have[r.url] = 1; });
      var todo = [];
      for (var i = 0; i < LIST.length; i++) {
        if (!have[abs(LIST[i][0])]) todo.push(LIST[i]);
      }
      return { todo: todo, keys: keys };
    });
  }

  /* 陈旧产物清理：同名旧图换了内容 → 新 URL → 老 URL 就没人再引用了。
     离线时不删 —— 手上这份可能是缓存里的旧 index.html，还指着那些老图。 */
  function prune(cache, keys) {
    if (!navigator.onLine) return;
    var keep = Object.create(null);
    for (var i = 0; i < LIST.length; i++) keep[abs(LIST[i][0])] = 1;
    var drop = keys.filter(function (r) {
      return r.url.indexOf("/assets/") >= 0 && !keep[r.url];
    });
    if (drop.length) drop.forEach(function (r) { cache["delete"](r); });
  }

  function run(todo) {
    var next = 0;
    function worker() {
      if (stopped || next >= todo.length) return Promise.resolve();
      var item = todo[next++];
      return attempt(item, TRIES - 1).then(worker, function () { /* 见 stop() */ });
    }
    var pool = [];
    for (var k = 0; k < CONCURRENCY; k++) pool.push(worker());
    return Promise.all(pool);
  }

  /* 按累计体积切出「首批」：清单本身是排好序的，所以第一个达到门槛的位置就是刀口。
     至少放一张 —— 单张图再大也不能让门槛变成 0 张。 */
  function gateCut(todo) {
    var sum = 0;
    for (var i = 0; i < todo.length; i++) {
      sum += todo[i][1] || 0;
      if (sum >= GATE_BYTES) return i + 1;
    }
    return todo.length;
  }

  var silentPhase = false;    // 后台那批：出什么错都别再弹窗打扰人

  function sync() {
    failed = [];
    return caches.open(CACHE).then(function (c) {
      cache = c;
      return missing(c);
    }).then(function (r) {
      if (!r.todo.length) { hide(true); prune(cache, r.keys); return; }
      var cut = gateCut(r.todo);
      var gate = r.todo.slice(0, cut), rest = r.todo.slice(cut);
      setGate(gate);
      paint();
      return run(gate).then(function () {
        if (stopped) return;
        /* 首批到手就放行 —— 就算有几张失败（断网 / 404）也不该把人锁在外面：
           缺的图进游戏时会临时从网上取，比进不去强。 */
        hide(true);
        prune(cache, r.keys);
        if (!rest.length) return;
        /* 第二批：后台静默搬，搬完再清一次陈旧产物。 */
        silentPhase = true;
        failed = [];
        return run(rest).then(function () {
          if (!failed.length) prune(cache, r.keys);
          failed = [];
        });
      });
    })["catch"](function (e) {
      if (!stopped && !silentPhase) stop("搬运中断了：" + ((e && e.message) || e) + "。点重试接着搬。");
    });
  }

  retryEl.addEventListener("click", function () {
    errEl.hidden = true;
    actsEl.hidden = true;
    stopped = false;
    sync();
  });

  /* 先进去：不搬了，游戏照常开始。缺的图进游戏时会临时从网上取，下次打开继续补。 */
  skipEl.addEventListener("click", function () { stopped = true; hide(); });

  /* 先把 SW 注册上，让它尽早开始接管 assets/ 的请求（游戏初始化那边也会拉图，
     走了 SW 就能同一份只下一次）。注册失败不影响下面自己搬。 */
  if (navigator.serviceWorker) {
    try { navigator.serviceWorker.register("sw.js")["catch"](function () {}); } catch (e) {}
  }
  /* 申请持久化：iOS 对普通网页的存储有「一段时间不用就清掉」的策略，
     拿不到也不影响本次搬运（加主屏的独立应用本来就豁免）。 */
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  window.MomoPreload = {
    off: false,
    total: LIST.length,
    bytes: TOTAL,
    state: function () { return { done: done, bytes: bytes, failed: failed.length, stopped: stopped }; },
    cache: CACHE
  };

  sync();
})();