/* 墨墨 · 剧本调度（通用）
   吃 game/content/dialogues.json 里的「脚本」，把一段剧情演出来：
   台词一行点一下推进、旁白走底端渐变条、选项弹选择条、表情按句切换。

   节点格式见 dialogues.json 的 "_node_types"（expr / say / narration / choice / end）：
     expr       改立绘表情；带 hold 就等这么多毫秒再自动往下（不写＝立刻继续）
     say        墨墨说话 → 出对话框 + 姓名条；who:"player" 时姓名条改填玩家自己的名字
     narration  旁白 → 对话框与姓名条一起收起，出底端渐变条
     choice     弹选项条；选完落 apply 的数值，再把 then 里的节点接在后面播
     end        收尾：演出结束，对话框 / 姓名条 / 旁白条全部收起

   两条贯穿全局的演出规则（《文案指导》）：
   1) 文本框（+姓名条）只在墨墨说话时出现。她不说、或者轮到旁白说话时，
      画面里只有立绘 + 场景图 —— 所以剧本演完是「收起一切」而不是留一句常驻台词。
   2) 表情只对写了它的那一句生效；下一句没写「表情」，就自动回到默认立绘。

   为什么做成通用调度而不是一次性开场脚本：
   这份 docx 是主线剧情的第一段，后面还有大量剧情，数据结构化之后写剧情只改 JSON。

   触发（见下方 onShow）：进主画面时，若剧本声明的 flag 还是 false 就自动播。
   开场用 story.intro_done；多周目重置存档后自然重播。 */
(function () {
  "use strict";
  var SCR = "主画面";
  var DEFAULT_EXPR = "默认";
  var SCRIPTS = ((window.MOMO_DATA || {}).dialogues || {}).脚本 || {};

  var scr = null, dlg = null, dlgLabel = null,
      plate = null, plateLabel = null,
      nar = null, narLabel = null;
  var plateText = "墨 墨";   /* 姓名条上的常驻名字（bind 时从 PSD 原样读回来） */

  var frames = [];           /* 帧栈 [{list, i}]：choice 的 then 压栈，支持任意层嵌套 */
  var script = null;
  var playing = false;
  var state = "off";         /* off | expr | say | narration | choice | scene | idle */
  var timer = null;
  var curExpr = DEFAULT_EXPR;
  var curWho = "momo";
  var sceneIn = false;       /* 「切了场景：先只出场景图，点一下立绘才登场」那一拍 */
  var curPeriod = null;      /* 本场演出钉死的时段（scene 节点只在变化处写一次，之后沿用） */

  /* 自动播开关。ui.js 的截图模式（?shot=1）要看到「没在演出」的常态主画面，
     回归脚本也要先关掉它、再单独验开场，所以留成可写属性。 */
  var auto = !/[?&]shot=1/.test(location.search);

  function $(s) { return scr ? scr.querySelector(s) : null; }

  function bind() {
    scr = document.querySelector('[data-screen="' + SCR + '"]');
    if (!scr) return false;
    dlg = $(".lL006"); plate = $(".lL007"); nar = $(".narration");
    if (!dlg || !plate || !nar) return false;
    dlgLabel = dlg.querySelector(".btn-label");
    plateLabel = plate.querySelector(".btn-label");
    narLabel = nar.querySelector(".btn-label");
    if (!dlgLabel || !plateLabel || !narLabel) return false;
    plateText = plateLabel.textContent;
    /* 「点一下」统一挂在整屏上：台词、旁白、切场景那一拍都从这一个入口走。
       对话框与旁白条**不**各自再挂监听 —— 挂了就会「自己推进一次 + 冒泡到整屏再推进一次」，
       一次点击跳掉两行。 */
    scr.addEventListener("click", screenClick);
    /* 长按快进（2026-10-12，作者要的测试便利）：按住不放连续推进，松手就停。
       轻点仍然是「点一下推进一句」—— 按住 FF_HOLD 毫秒才启动，所以不会误触。
       快进只是把 advance() 连着调，走的是同一条推进逻辑：一句打完再推下一句，
       碰到选项 / 等玩家走位（choice、wait）自然停住，不会替你选。 */
    scr.addEventListener("pointerdown", ffStart);
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) {
      scr.addEventListener(t, ffStop);
    });
    window.addEventListener("blur", ffStop);
    return true;
  }

  /* ---- 长按快进 ---- */
  var FF_HOLD = 180;   /* 按住多久才启动（毫秒）：小于这个数算轻点 */
  var FF_MS = 40;      /* 推进间隔：一句「打完 + 翻页」两拍 ≈ 80ms ≈ 12 句/秒 */
  var ffDelay = null, ffLoop = null;
  function ffStart(e) {
    if (e && e.button) return;                 /* 只认左键 / 触摸 */
    if (!playing || ffDelay || ffLoop) return;
    ffDelay = setTimeout(function () {
      ffDelay = null;
      ffChip(true);
      ffLoop = setInterval(function () {
        if (!playing) { ffStop(); return; }    /* 演完了就自己收手 */
        advance();
      }, FF_MS);
    }, FF_HOLD);
  }
  function ffStop() {
    if (ffDelay) { clearTimeout(ffDelay); ffDelay = null; }
    if (ffLoop) { clearInterval(ffLoop); ffLoop = null; }
    ffChip(false);
  }
  /* 快进指示：只是让作者知道「正在快进」，免得以为卡住了 */
  function ffChip(on) {
    if (!scr) return;
    var el = scr.querySelector("#momo-ff");
    if (!el) {
      if (!on) return;
      el = document.createElement("div");
      el.id = "momo-ff";
      el.textContent = "▶▶ 快进中";
      (scr.querySelector(".stage") || scr).appendChild(el);
    }
    el.classList.toggle("on", !!on);
  }

  /* 整屏点击的唯一入口 */
  var chatLive = false;                   /* 对话条被 chat.js 当聊天窗用的时段（见 liveSay） */

  function screenClick() {
    if (chatLive) return;                 /* 聊天中：点屏幕不该把她说的话收掉，玩家在打字 */
    if (playing) { advance(); return; }   /* 演出中：推进当前这行（只有 say/narration 会被推进） */
    if (sceneIn) revealSprite();          /* 没在演、却还卡在「只有场景图」那一拍：点一下让立绘登场 */
  }

  /* 文字落进标签：带 {{}} 的把原始模板记下来，改名字时 name.js 会照着它重填 */
  function put(label, text) {
    var raw = String(text == null ? "" : text);
    if (raw.indexOf("{{") >= 0) label.dataset.mnTpl = raw;
    else delete label.dataset.mnTpl;
    label.textContent = window.MomoName ? window.MomoName.fill(raw) : raw;
  }

  /* .dlg-live 只干一件事：把对话框/旁白条从 .layer 的 pointer-events:none 里放出来，
     让「点一下推进」真的点得到。不演出时它们本来就是隐藏的。 */
  function live(on) { scr.classList.toggle("dlg-live", !!on); }

  function showBox() {
    dlg.classList.remove("is-hidden");
    plate.classList.remove("is-hidden");
    nar.classList.add("is-hidden");
    live(true);
  }
  function showNar() {
    dlg.classList.add("is-hidden");
    plate.classList.add("is-hidden");
    nar.classList.remove("is-hidden");
    live(true);
  }
  /* 收起一切：墨墨不说话时屏幕上只有立绘 + 场景图 */
  function hideAll() {
    dlg.classList.add("is-hidden");
    plate.classList.add("is-hidden");
    nar.classList.add("is-hidden");
    live(false);
  }

  function setExpr(name) {
    curExpr = name || DEFAULT_EXPR;
    if (window.MomoExpr) window.MomoExpr.set(curExpr);
  }

  /* ---- 切场景：先出场景图，点一下立绘才登场 ---- */
  function mainSprites() {
    return scr ? [].slice.call(scr.querySelectorAll("[data-costume]")) : [];
  }
  /* 立绘在场吗（.sprite-out = 不在场）—— persistScript 与自动化验证都读它 */
  function spriteHidden() {
    var el = mainSprites()[0];
    return !!el && el.classList.contains("sprite-out");
  }
  function armSceneIn() {
    if (playing) return;
    sceneIn = true;
    state = "scene";
    setExpr(DEFAULT_EXPR);
    hideAll();
    mainSprites().forEach(function (el) { el.classList.add("sprite-out"); });
  }
  function revealSprite() {
    if (!sceneIn) return;
    sceneIn = false;
    state = "idle";
    mainSprites().forEach(function (el) { el.classList.remove("sprite-out"); });
  }

  /* ---- 剧本 flag：剧本自己声明（如 "story.intro_done"），这里不写死任何剧情名 ----
     注意要读**剧本对象**上的 flag 而不是当前正在播的那份 —— 判断「要不要播」的时候
     还没开始播，script 是空的，照它读永远得到 false，就会每次进主画面都重播。 */
  function flagPath(s) { return (s && s.flag) || ""; }
  function readFlag(s) {
    var p = flagPath(s).split("."), o = window.MomoStore && window.MomoStore.state;
    if (!o || !p[0]) return false;
    for (var i = 0; i < p.length; i++) o = o[p[i]];
    return o === true;
  }
  function markDone() {
    var p = flagPath(script).split("."), o = window.MomoStore && window.MomoStore.state;
    if (!o || !p[0]) return;
    for (var i = 0; i < p.length - 1; i++) {
      if (!o[p[i]]) o[p[i]] = {};
      o = o[p[i]];
    }
    if (o[p[p.length - 1]] === true) return;
    o[p[p.length - 1]] = true;
    window.MomoStore.save();
  }

  /* ---- 剧情回放：每说一句就往存档的 story.log 里记一笔 ----
     回放界面（replay.js）读的就是这份记录。只记「真的说出来/写出来」的话，
     表情演出不记；存的是**原始模板**（可能带 {{name}}），回放时再填名字。 */
  var LOG_MAX = 400;         /* 上限：够翻很久，又不至于把 localStorage 撑爆 */
  function logAdd(who, text) {
    var st = window.MomoStore && window.MomoStore.state;
    if (!st || !st.story) return;
    if (!st.story.log) st.story.log = [];
    st.story.log.push({ who: who, text: String(text == null ? "" : text) });
    if (st.story.log.length > LOG_MAX) st.story.log.splice(0, st.story.log.length - LOG_MAX);
    window.MomoStore.save();
  }

  /* ---- 打字机（VN 标配，2026-10-12）----
     文字逐字显示；演出中点击的语义是「先把整句显示完」，再点一下才推进到下一句。
     系统开了「减少动态效果」就不打字，直接整句落。 */
  var typing = null, TYPE_MS = 26;
  function reduceMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }
  function stopTyping(complete) {
    if (!typing) return false;
    var t = typing;
    typing = null;
    clearInterval(t.timer);
    if (complete) put(t.label, t.full);        /* 收尾走 put：模板标记与 {{name}} 都按正规路径落 */
    return true;
  }
  function typeInto(label, text) {
    stopTyping(false);
    var full = String(text == null ? "" : text);
    if (reduceMotion() || full.length < 2) { put(label, full); return; }
    var shown = window.MomoName ? window.MomoName.fill(full) : full;
    if (full.indexOf("{{") >= 0) label.dataset.mnTpl = full;
    else delete label.dataset.mnTpl;
    label.textContent = "";
    var t = { label: label, full: full, timer: null };
    typing = t;
    var i = 0;
    t.timer = setInterval(function () {
      if (typing !== t) return;                /* 已被收尾（点击/换行）：别再写 */
      i += 1;
      label.textContent = shown.slice(0, i);
      if (i >= shown.length) stopTyping(true);
    }, TYPE_MS);
  }

  /* ---- 剧情进度实时存档（2026-10-12）----
     每走到一行台词/旁白，就把「哪个剧本、演到第几节点」写进存档：
     中途关掉页面，下次「继续旅程」能从这一句接着演，而不是从头再来。
     只记主线节点位（选择分支里不记）；演完整段脚本时清空。
     2026-10-12 补 stage 快照：只记台词位置的话，续演时立绘会「诈尸」、CG 会消失、
     剧本钉死的时段（如书房-夜晚开灯）会丢 —— 舞台得跟着一起回来。 */
  function persistScript() {
    var st = window.MomoStore && window.MomoStore.state;
    if (!st || !script || !script.id) return;
    if (frames.length !== 1) return;           /* 分支里不记，主线位保持即可 */
    if (!st.script) st.script = {};
    st.script.id = script.id;
    st.script.i = Math.max(0, frames[0].i - 1);/* 记「正在显示的这一句」，续演时重演一遍上下文 */
    st.script.stage = {
      sprite: !spriteHidden(),                 /* 立绘在不在场 */
      cg: cgName,                              /* 当前 CG 图（"" = 没有 CG） */
      cgprop: !!(cgEl && cgEl.classList.contains("prop")),
      period: (window.MomoScene && MomoScene.state) ? MomoScene.state().forced : null
    };
    window.MomoStore.save();
  }
  function clearPersist() {
    var st = window.MomoStore && window.MomoStore.state;
    if (!st || !st.script) return;
    st.script.id = "";
    st.script.i = 0;
    st.script.stage = null;
    window.MomoStore.save();
  }

  /* ---- 演出 ---- */
  /* 常态（剧本没在演）：收起对话框与姓名条，表情回默认 */
  function rest() {
    if (sceneIn) { state = "scene"; hideAll(); return; }
    state = "idle";
    setExpr(DEFAULT_EXPR);
    hideAll();
  }

  function doSay(n) {
    /* 没写表情 = 这一句回到默认立绘，而不是沿用上一句。
       2026-10 起群像剧本：who 还可以写 NPC 名（千春/月见…）——
       姓名条换成该角色，表情交给 party.js 的 NPC 立绘接管，墨墨的立绘不动。 */
    curWho = n.who === "player" ? "player"
           : (n.who && n.who !== "墨墨") ? String(n.who)
           : "momo";
    if (curWho === "momo" || curWho === "player") setExpr(n.expr || DEFAULT_EXPR);
    /* 剧本声明 solo_npc：NPC 说话时只显示当前说话人（同墨墨尺寸），
       墨墨说话时清掉 NPC、恢复主立绘。用于《茶会前》群像。 */
    if (script && script.solo_npc && window.MomoParty && MomoParty.stage) {
      if (curWho === "momo") {
        MomoParty.stage({ clear: true });
      } else if (curWho === "player") {
        /* 玩家说话时不保留上一位 NPC；也不要把墨墨顶出来，
           保持空镜，下一句谁说话再出谁的立绘。 */
        MomoParty.stage({ clear: true });
        var scrP = document.querySelector('[data-screen="主画面"]');
        var mmP = scrP && scrP.querySelector('[data-costume]');
        if (mmP) mmP.classList.add('sprite-out');
      } else {
        MomoParty.stage({ who: curWho, expr: n.expr, solo: true });
      }
    }
    showBox();
    /* 玩家说话 → 姓名条填玩家自己的名字；{{name}} 走模板，改名能自动重填 */
    if (curWho === "player") put(plateLabel, "{{name}}");
    else if (curWho === "momo") put(plateLabel, plateText);
    else put(plateLabel,
             (window.MomoParty && MomoParty.label) ? MomoParty.label(curWho) : curWho);
    typeInto(dlgLabel, n.text);
    logAdd(curWho, n.text);
    persistScript();
    /* 语音位：say 挂 vo= 前缀（如 "vo-ch1-answer-"）就按当前语种挑一句放。
       pick 自带 has 守卫——没录就静默，台词照常出。 */
    if (n.vo && window.MomoAudio && MomoAudio.pick) {
      var v = MomoAudio.pick(n.vo);
      if (v) MomoAudio.vo(v);
    }
    state = "say";
  }

  function doNar(n) {
    setExpr(n.expr || DEFAULT_EXPR);
    showNar();
    typeInto(narLabel, n.text);
    logAdd("narr", n.text);
    persistScript();
    state = "narration";
  }

  function doChoice(n) {
    var opts = n.options || [];
    if (!opts.length || !window.MomoChoice) { pump(); return; }
    state = "choice";
    window.MomoChoice.show(opts.map(function (o) { return o.label; }), function (i) {
      var o = opts[i] || {};
      if (o.apply && window.MomoStore) window.MomoStore.apply(o.apply);
      frames.push({ list: (o.then || []).slice(), i: 0 });   /* 分支接在玩家这句话之后 */
      if (o.say) doSay({ text: o.say, who: "player" });
      else pump();
    });
  }

  function doEnd() {
    frames.length = 0;
    cgHide();
    finish();
  }

  /* ---- 2026-10-08 新增节点：全屏 CG（前言《月见茶会》演出用）----
     cg     {type:"cg", img:"玄关信封特写镜头.png"} —— 黑场 + 图居中淡入；
            台词/旁白照常叠在上面（立绘被 CG 盖住 = 「放CG时不显示人物」）。
            连续多个 cg 节点 = 换图不收场（淡入淡出切换）。
     cgoff  收起 CG 层，回到正常立绘+场景。
     「点一下」推进在 cg 态同样成立（screenClick → advance → pump）。 */
  var cgEl = null, cgImg = null, cgName = "";   /* cgName = 当前 CG 的原文件名（进度快照要记它） */
  function cgLayer() {
    var root = scr.querySelector(".stage") || scr;
    if (!cgEl || !cgEl.parentNode) {
      cgEl = document.createElement("div");
      cgEl.className = "cg-scene";
      cgEl.innerHTML = '<img class="cg-img" alt="">';
      /* 插在对话框层前面：CG 盖住场景与立绘，但对话框/姓名条/旁白条浮在 CG 上 */
      if (dlg) root.insertBefore(cgEl, dlg); else root.appendChild(cgEl);
    }
    return cgEl;
  }
  function doCG(n) {
    var el = cgLayer();
    /* 竖版道具图（请柬）走 prop 模式：居中完整展示；
       其余全屏 CG 一律 object-fit:cover 铺满整个舞台（VN 惯例）。 */
    el.classList.toggle("prop", n.mode === "prop");
    if (scr) scr.classList.add("cg-mode");       /* CG 期间收起时间条等 HUD，画面只有 CG + 文字 */
    cgName = n.img || "";
    cgImg = el.querySelector(".cg-img");
    var src = (window.ASSET_URI || {})[n.img] || n.img;
    if (cgImg.getAttribute("src") !== src) {
      cgImg.style.opacity = "0";
      /* 捕获当次元素：cgHide 会把模块级的 cgImg 置空，迟到的定时器
         再去用 cgImg 就会砸在 null 上（TypeError）。 */
      var img = cgImg;
      setTimeout(function () {
        if (!img || !img.parentNode) return;
        img.setAttribute("src", src);
        img.style.opacity = "1";
      }, 200);
    }
    el.classList.add("show");
    state = "cg";
  }
  function cgHide() {
    if (scr) scr.classList.remove("cg-mode");
    cgName = "";
    if (!cgEl) return;
    var el = cgEl;
    el.classList.remove("show");
    setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 500);
    cgEl = null; cgImg = null;
  }

  /* ---- await_room：剧本挂起，等玩家把存档的 room 走到位再续播 ----
     （前言：地图上高亮「码头」，玩家点了码头才继续）
     注意：map.js 点房间走的是 STORE.save()，而 store 的 save() **不派发 momo:store**
     （只有 apply/earn/spend/load 派发）——所以必须同时听 map.js 的 momo:room，
     再加一条低频轮询兜底，防止将来又出现不派事件的走位路径。 */
  function doAwaitRoom(n) {
    var st = window.MomoStore && window.MomoStore.state;
    if (st && st.room === n.room) { pump(); return; }
    state = "wait";
    var iv = 0;
    function hit() {
      var s2 = window.MomoStore && window.MomoStore.state;
      if (!s2 || s2.room !== n.room) return false;
      document.removeEventListener("momo:store", hit);
      document.removeEventListener("momo:room", hit);
      clearInterval(iv);
      pump();
      return true;
    }
    document.addEventListener("momo:store", hit);
    document.addEventListener("momo:room", hit);
    iv = setInterval(hit, 600);
  }

  /* ---- map_hint：切到地图并高亮目标房间，引导玩家走位 ---- */
  function doMapHint(n) {
    if (window.MomoMap && MomoMap.hint) MomoMap.hint(n.room);
    /* 剧本当前是傍晚时，地图页也切成黄昏色，避免“剧情傍晚、地图白天” */
    var mapScr = document.querySelector('[data-screen="地图界面"]');
    if (mapScr) mapScr.classList.toggle("dusk", curPeriod === "傍晚");
    if (window.MomoUI) MomoUI.show("地图界面");
    doAwaitRoom(n);
  }

  /* ---- daze：走神背单词演出（prologue-daze.js 接管，演完广播 momo:daze_end）---- */
  function doDaze(n) {
    state = "wait";
    document.dispatchEvent(new CustomEvent("momo:daze",
      { detail: { count: (n && n.count) || 10 } }));
  }
  document.addEventListener("momo:daze_end", function () {
    if (playing && state === "wait") { state = "idle"; pump(); }
  });

  /* 立绘显隐节点（前言用：码头她「突然出现」、结尾她回房后主画面空场） */
  function doSprite(n) {
    [].slice.call(scr.querySelectorAll("[data-costume]")).forEach(function (el) {
      el.classList.toggle("sprite-out", !!n.hide);
    });
  }

  /* 演出锁：剧本在演时给主画面上 .story-lock —— CSS 把「地/学/玩」与头像入口收起来，
     玩家不能中途跑去別屏破坏沉浸感（剧情要走位时由剧本自己调 MomoUI.show）。
     演完上锁解除，入口原样回来。 */
  function storyLock(on) {
    if (scr) scr.classList.toggle("story-lock", !!on);
  }

  /* 收尾：停演出 → 收起一切 → 把剧本声明的 flag 落档。
     剧本可声明 then（如 "party:begin"）：演完广播 momo:script_end，由监听方接棒
     （茶会状态机 / 后续章节的事件模块）。临时脚本（playNodes）没有 script 对象，
     自然不广播——它本来演完就完。 */
  function finish() {
    clearTimeout(timer);
    stopTyping(false);
    playing = false;
    storyLock(false);
    cgHide();
    clearPersist();                              /* 整段演完：进度清空，不会再触发续演 */
    releasePeriod();                             /* 演出结束：时段交还真实时钟 */
    var s = script;
    rest();
    /* 剧终归位（2026-10-20 评测修复）：剧本里 sprite hide 过的立绘要在收场时恢复。
       否则读完前言回到主画面是空房间，点她只有姓名条、没有立绘 —— 玩家刚被
       点灯演出打动，下一秒发现「人没了」。 */
    if (scr) mainSprites().forEach(function (el) { el.classList.remove("sprite-out"); });
    sceneIn = false;
    markDone();
    /* 没声明 then 的剧本也要广播：剧情通道的「重看」链路（前言→开席）靠 id 接棒，
       不能再依赖 then 是否写了（2026-10-12）。then 为空时老监听方按原样忽略。 */
    if (s) {
      document.dispatchEvent(new CustomEvent("momo:script_end",
        { detail: { id: s.id || "", then: s.then || "" } }));
    }
  }

  /* 点灯演出（lamp 节点）：章节内点灯优先交给 party.js（它还会落档与配乐）；
     茶会章节已摘除、party 静默休眠时，导演自己放同一套光效 + 音 ——
     否则前言结尾的「灯缓缓亮起」会变成完全没反应。 */
  /* 演出结束（正常收尾或中途 stop）→ 把 scene 节点写死的时段交还真实时钟，
     否则剧本里的「夜晚」会一直粘在正常游玩上（房子本来是按真实时间变色的）。
     新一场演出开始时也走这里，保证每场都从真实时钟起步。 */
  function releasePeriod() {
    curPeriod = null;
    if (window.MomoScene && MomoScene.setPeriod) MomoScene.setPeriod(null);
  }
  function lampCeremony() {
    var root = scr ? (scr.querySelector(".stage") || scr) : null;
    if (!root) return;
    var d = document.createElement("div");
    d.className = "lamp-ceremony";
    d.innerHTML = '<i class="lc-glow"></i><i class="lc-core"></i>';
    root.appendChild(d);
    if (window.MomoAudio && MomoAudio.sfx) MomoAudio.sfx("sfx-perfect");
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2400);
  }

  /* 走到下一个「需要玩家动作」的节点就停住（say / narration / choice）；
     expr 这类不需要点的直接连播（要停顿就写 hold）。 */
  function doFx(n) {
    var root = scr ? (scr.querySelector(".stage") || scr) : null;
    if (!root) return;
    var ms = Number(n.ms) || 600;
    if (n.effect === "shake" || n.shake) {
      root.classList.remove("fx-shake");
      void root.offsetWidth;
      root.classList.add("fx-shake");
      setTimeout(function () { root.classList.remove("fx-shake"); }, ms);
    }
    if (n.effect === "flash" || n.flash) {
      var d = document.createElement("div");
      d.className = "momo-fx-flash";
      root.appendChild(d);
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, ms);
    }
  }

  function pump() {
    while (frames.length) {
      var f = frames[frames.length - 1];
      if (f.i >= f.list.length) { frames.pop(); continue; }
      var n = f.list[f.i++] || {};
      if (n.type === "expr") {
        setExpr(n.name);
        if (n.hold > 0) { state = "expr"; timer = setTimeout(pump, n.hold); return; }
        continue;
      }
      /* 立绘登场：先把上一条旁白收掉（「点一下消失」），再放她出来 */
      if (n.type === "reveal") { hideAll(); revealSprite(); continue; }
      if (n.type === "say") return doSay(n);
      if (n.type === "narration") return doNar(n);
      if (n.type === "choice") return doChoice(n);
      if (n.type === "end") return doEnd();
      /* ---- 2026-10 新增节点（群像剧本用，全部非阻塞：处理完直接下一帧）----
         stage  NPC 登场/退场：立绘层交给 party.js 管（who 进场；exit/clear 出场）
         scene  切场景：写存档的 room/floor（momo:store 广播后 scene.js 自己重绘）
         set    落存档字段：choice 的 apply 只会加数字，字符串/布尔值走这里
         lamp   点灯演出：party.js 放光效与音（写档在 party.finish 统一做，防回放重写） */
      if (n.type === "stage") {
        if (window.MomoParty && MomoParty.stage) MomoParty.stage(n);
        continue;
      }
      if (n.type === "scene") {
        var st = window.MomoStore && window.MomoStore.state;
        if (st && n.room) {
          st.room = n.room;
          if (n.floor) st.floor = n.floor;
          window.MomoStore.save();
          /* period 可选：只有 scene 节点**真的写了** period 才改当前时段；
             不写 = 沿用上一个 scene 节点的设定（剧本只在时段变化处写一次即可）。
             写 null / "" = 交还真实时钟。curPeriod 由导演记着，演出结束清空。 */
          if (n.period !== undefined) curPeriod = n.period || null;
          if (window.MomoScene && MomoScene.setPeriod) MomoScene.setPeriod(curPeriod);
          /* 立即重绘场景：store.save() 不派事件，scene.js 的兜底轮询是 30s 一次 ——
             不主动刷的话，剧本都演到下一个房间了，画面还停在原地（「场景固定」）。 */
          if (window.MomoScene && MomoScene.refresh) MomoScene.refresh();
        }
        continue;
      }
      if (n.type === "set") {
        var st2 = window.MomoStore && window.MomoStore.state;
        if (st2 && n.path) {
          var ks = String(n.path).split("."), t = st2;
          for (var k = 0; k < ks.length - 1; k++) {
            if (!t[ks[k]] || typeof t[ks[k]] !== "object") t[ks[k]] = {};
            t = t[ks[k]];
          }
          t[ks[ks.length - 1]] = (n.value === undefined) ? true : n.value;
          window.MomoStore.save();
        }
        continue;
      }
      if (n.type === "lamp") {
        if (window.MomoParty && MomoParty.light) MomoParty.light(n.n || 1);
        else lampCeremony();                      /* 章节未接线时导演自己点灯 */
        continue;
      }
      /* ---- 2026-10-08 前言《月见茶会》演出节点 ----
         cg/cgoff  全屏 CG 与收场（见 doCG 注释）
         await_room 剧本挂起，等玩家把 room 走到位（地图走位）
         map_hint   切地图 + 高亮目标房间
         daze       走神背单词演出（prologue-daze.js）
         sprite     立绘强制显/隐（{hide:true} 藏、{hide:false} 出） */
      if (n.type === "cg") return doCG(n);
      if (n.type === "cgoff") { cgHide(); continue; }
      if (n.type === "await_room") return doAwaitRoom(n);
      if (n.type === "map_hint") return doMapHint(n);
      if (n.type === "daze") return doDaze(n);
      if (n.type === "sprite") { doSprite(n); continue; }
      /* 2026-10-21：剧情音效 / 画面动效（非阻塞，处理完直接下一帧） */
      if (n.type === "sfx") {
        if (window.MomoAudio && MomoAudio.sfx && n.name) MomoAudio.sfx(n.name);
        continue;
      }
      if (n.type === "fx") { doFx(n); continue; }
      /* 认不出的节点跳过：一处笔误不该把整段剧本卡死 */
    }
    finish();
  }

  function advance() {
    if (!playing) return;
    if (stopTyping(true)) return;                /* 打字中：这一下先把整句显示出来 */
    if (state === "cg") { pump(); return; }          /* CG 态：点一下到下一节点（换图或台词） */
    if (state !== "say" && state !== "narration") return;
    pump();
  }

  function play(id) {
    var s = SCRIPTS[id];
    if (!s || !s.nodes || !s.nodes.length) return false;
    if (!scr && !bind()) return false;
    if (!scr.classList.contains("active")) return false;   /* 只在主画面上演 */
    clearTimeout(timer);
    chatLive = false;                     /* 剧本一开演，聊天窗让位 */
    revealSprite();
    script = s;
    frames = [{ list: s.nodes, i: 0 }];
    playing = true;
    state = "expr";
    storyLock(true);                                       /* 演出中：藏起地/学/玩与头像入口 */
    hideAll();                                             /* 演出前：对话框与姓名条都不出现 */
    setExpr(DEFAULT_EXPR);
    releasePeriod();                                       /* 新一场演出：时段从真实时钟起步 */
    pump();
    return true;
  }

  /* 播一段**临时脚本**：不在 dialogues.json 的「脚本」里、也没有 flag，演完不留痕迹。
     切场景的四拍（旁白 → 立绘登场 → 概率台词 → 收起）和常态点墨墨的一句日常台词，
     都由 idle.js 现拼节点数组交给它。
     opts.keepHidden = 开场时保持立绘藏着的状态（切场景专用：立绘要等 reveal 节点才出场）。 */
  function playNodes(nodes, opts) {
    if (!nodes || !nodes.length) return false;
    if (!scr && !bind()) return false;
    if (!scr.classList.contains("active")) return false;   /* 只在主画面上演 */
    opts = opts || {};
    clearTimeout(timer);
    if (!opts.keepHidden) revealSprite();
    script = null;                 /* 临时脚本无 flag：markDone 读不到路径会自行跳过 */
    frames = [{ list: nodes, i: 0 }];
    playing = true;
    state = "expr";
    storyLock(true);
    hideAll();
    setExpr(DEFAULT_EXPR);
    releasePeriod();               /* 新一场演出：时段从真实时钟起步 */
    pump();
    return true;
  }

  function stop() {
    clearTimeout(timer);
    stopTyping(false);
    frames = [];
    playing = false;
    storyLock(false);
    if (scr) { revealSprite(); state = "off"; hideAll(); }
    releasePeriod();                             /* 中途停演也把时段交还真实时钟 */
  }

  /* 从别屏折返时把当前这行的 UI 重新挂上（演出本身没停，文字也还在标签里） */
  function redraw() {
    if (state === "narration") showNar();
    else if (state === "say") showBox();
    else hideAll();
  }

  function onShow(e) {
    if (!e || !e.detail) return;
    if (e.detail.screen !== SCR) { if (playing) hideAll(); return; }
    if (!scr && !bind()) return;
    if (playing) { redraw(); return; }
    if (sceneIn) { state = "scene"; hideAll(); return; }   /* 等玩家点一下让立绘登场 */
    /* 进度接续优先于一切自动播放：上次演到一半关掉了 → 从那一句接着演 */
    if (auto && resumePending()) return;
    var s = SCRIPTS["开场"];
    if (auto && !readFlag(s) && play("开场")) return;
    rest();
  }

  /* ---- 续演：读存档里的 script.{id,i}，从「正在显示的那句」重新播 ---- */
  function resumePending() {
    var st = window.MomoStore && window.MomoStore.state;
    var sv = st && st.script;
    if (!sv || !sv.id) return false;
    var s = SCRIPTS[sv.id];
    if (!s || !s.nodes || !s.nodes.length) { clearPersist(); return false; }
    var i = Math.max(0, Math.min(sv.i | 0, s.nodes.length - 1));
    clearTimeout(timer);
    revealSprite();                              /* 默认立绘在场（老存档没有 stage 就是这行为） */
    script = s;
    frames = [{ list: s.nodes, i: i }];
    playing = true;
    state = "expr";
    storyLock(true);
    hideAll();
    setExpr(DEFAULT_EXPR);
    restoreStage(sv.stage);                      /* 有舞台快照就照它还原立绘 / CG / 时段 */
    pump();
    return true;
  }

  /* 舞台快照还原：只恢复台词位置的话，续演时会出三种岔子 ——
     该下场的立绘「诈尸」站在画面里、CG 段没了 CG、剧本钉死的时段（书房-夜晚开灯）退回真实时钟。
     快照由 persistScript 每句落档，这里的字段全部可选：缺哪个就保持默认。 */
  function restoreStage(stg) {
    if (!stg) return;
    curPeriod = stg.period || null;
    if (window.MomoScene && MomoScene.setPeriod) MomoScene.setPeriod(curPeriod);
    var on = !!stg.sprite;
    mainSprites().forEach(function (el) { el.classList.toggle("sprite-out", !on); });
    if (!stg.cg) { cgHide(); return; }
    var el = cgLayer();
    el.classList.toggle("prop", !!stg.cgprop);
    var im = el.querySelector(".cg-img");
    im.setAttribute("src", (window.ASSET_URI || {})[stg.cg] || stg.cg);
    im.style.opacity = "1";
    cgImg = im;
    cgName = stg.cg;
    el.classList.add("show");
    if (scr) scr.classList.add("cg-mode");
  }

  /* 脚本在 body 末尾，DOM 已解析，直接绑定；万一挪到 head 再兜底重试 */
  if (!bind()) document.addEventListener("DOMContentLoaded", bind);
  document.addEventListener("momo:show", onShow);
  /* 在地图上点了新房间 = 切了场景（map.js 派发），进主画面时先只出场景图 */
  document.addEventListener("momo:room", function () { armSceneIn(); });
  /* ui.js 在 body 末尾就切过一次屏（hash 可能直接落在主画面），
     那次 momo:show 早于本文件执行、收不到，所以这里补一次。 */
  if (scr && scr.classList.contains("active")) onShow({ detail: { screen: SCR } });

  /* ---- 对话条「活字」（2026-10-20，chat.js 用）----
     把对话框直接当聊天窗：她的话一段段 append 进来，玩家在条里打字。
     刻意不进剧本状态机（playing 保持 false）—— 否则 idle 的切场景、主线演出
     都会被它当成「正在演」，互相打架。 */
  function liveSay(exprName) {
    if (!scr && !bind()) return null;
    if (!scr.classList.contains("active")) return null;
    if (playing) return null;
    chatLive = true;
    showBox();
    put(plateLabel, plateText);
    put(dlgLabel, "");
    setExpr(exprName || DEFAULT_EXPR);
    state = "say";
    return {
      append: function (t) { put(dlgLabel, t); },
      expr: function (e) { setExpr(e); },
      clear: function () { put(dlgLabel, ""); },
      done: function () {}
    };
  }
  /* 收起：恢复「她不在说话」的样子（立绘回默认表情、对话框收掉） */
  function closeLive() {
    if (!chatLive) return;
    chatLive = false;
    if (playing) return;
    state = "idle";
    setExpr(DEFAULT_EXPR);
    hideAll();
  }

  window.MomoDirector = {
    play: play,
    liveSay: liveSay,
    closeLive: closeLive,
    isChatting: function () { return chatLive; },
    /* 当前演的是不是主线剧本（script 非空）。对话入口据此判断能不能打断：
       临时演出（切场景四拍、她的一句话）可以停掉让位；主线演出绝不能。 */
    isStory: function () { return !!(playing && script); },
    playNodes: playNodes,
    armSceneIn: armSceneIn,
    advance: advance,
    stop: stop,
    scripts: function () { return Object.keys(SCRIPTS); },
    setAuto: function (v) { auto = !!v; },
    isPlaying: function () { return playing; },
    /* 供自动化验证用 */
    state: function () {
      if (!scr && !bind()) return { bound: false };
      var el = $("[data-costume]");
      return {
        bound: true,
        playing: playing,
        state: state,
        expr: curExpr,
        who: curWho,
        dataExpr: el ? el.dataset.expr : null,
        sprite: $(".lL001") ? $(".lL001").style.backgroundImage : "",
        spriteHidden: !!el && el.classList.contains("sprite-out"),
        sceneIn: sceneIn,
        dlgVisible: !dlg.classList.contains("is-hidden"),
        plateVisible: !plate.classList.contains("is-hidden"),
        narVisible: !nar.classList.contains("is-hidden"),
        dlgText: dlgLabel.textContent,
        plateText: plateLabel.textContent,
        narText: narLabel.textContent,
        introDone: readFlag(script || SCRIPTS["开场"]),
        typing: !!typing,
        scriptId: script ? (script.id || "") : "",
        scriptIndex: frames.length ? frames[0].i : -1
      };
    }
  };
})();