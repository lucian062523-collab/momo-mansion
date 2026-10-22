/* 墨墨 · 待机演出（idle）
   管两件事，两件都是「不进剧本、演完不留痕」的临时演出：
   director.js 的「脚本」是主线剧情（有 flag、只演一次），这里的是随时随地都会重来的小演出。

   一、切场景的四拍 —— 顺序是用户定死的，一拍都不能乱：
     ① 在地图上点了房间 → 主画面只出场景图（立绘藏着）
     ② 旁白底条弹出这一间房的氛围文案（1~2 句）→ 点一下消失，还有下一句就再点一下
     ③ 立绘 0.22s 淡入登场
     ④ 有概率（45%）她说一句台词 → 点一下收起，画面只剩立绘 + 场景图
     ①②③④ 由 director.playNodes() 拼成临时脚本演；立绘的登场是脚本里的 reveal 节点，
     所以 player 点旁白那一下正好接上「立绘淡入」，不会抢在旁白前面冒出来。

   二、常态下点她本人（.momo-hit 那块热区）
     点一次出一句日常台词，再点一下收起。每次点击都在她周围迸一把小星星，连点就连着迸；
     连击计数（两次间隔 >4s 归零）决定她有多炸毛 —— 第 4 次起进「越点越炸毛」的分档台词。

   文案全在 game/content/dialogues.json 的「场景旁白」「日常」两节，这里只管挑句与拼节点。 */
(function () {
  "use strict";
  var SCR = "主画面";
  var D = (window.MOMO_DATA || {}).dialogues || {};
  var NAR_MAP = (D["场景旁白"] || {}).map || {};
  var DAILY = D["日常"] || {};

  var SCENE_SAY_CHANCE = 0.45;   /* 切完场景她说一句话的概率 */
  var EGG_CHANCE = 0.03;         /* 彩蛋级台词 */
  var SCENE_LINE_CHANCE = 0.30;  /* 场景专属台词 */
  var PERIOD_LINE_CHANCE = 0.30; /* 时段专属台词 */
  var COMBO_GAP = 4000;          /* 两次点击隔这么久以上，连击归零 */
  var REVEAL_BEAT = 300;         /* 立绘淡入 0.22s，留 300ms 再开口，别抢在她冒出来之前 */
  var SPARK_MIN = 4, SPARK_MAX = 7;

  /* 时段：scene.js 只判三档（早晨 05–11 / 傍晚 11–18 / 夜晚 18–05），
     文案却分了四档（早晨/午后/傍晚/夜晚）。11–18 这一段既算午后也算傍晚，
     所以系统判成「傍晚」时，午后与傍晚两组都拿来用 —— 这是文档与系统口径的对齐点。 */
  var PERIOD_KEYS = { "早晨": ["早晨"], "傍晚": ["午后", "傍晚"], "夜晚": ["夜晚"] };

  /* ---------- 房间名折算 ---------- */
  /* 存档里的 room 可能是别名（默认存档是「卧房」，而 map.json 的 label 是「卧室」），
     拿 map.json 的 scene 别名表折回 label，再去查文案。 */
  var ALIAS = null;
  function alias() {
    if (ALIAS) return ALIAS;
    ALIAS = {};
    var M = (window.MOMO_DATA || {}).map;
    if (!M) return ALIAS;
    (M.order || []).forEach(function (k) {
      var f = M.floors[k];
      if (!f) return;
      (f.rooms || []).forEach(function (r) {
        var names = (r.scene && r.scene.length) ? r.scene : [r.label];
        names.forEach(function (n) { ALIAS[n] = r.label; });
      });
    });
    return ALIAS;
  }
  function roomKey(room) { return alias()[room] || room; }

  /* ---------- 挑句 ---------- */
  var LAST = "";   /* 上一句说过的：同一个池子里别连着抽到同一句 */
  function one(list) {
    if (!list || !list.length) return "";
    for (var i = 0; i < 8; i++) {
      var s = list[Math.floor(Math.random() * list.length)];
      if (s !== LAST) { LAST = s; return s; }
    }
    return list[0];
  }
  function pool(list) { return (list && list.length) ? list : null; }

  /* 连击段位：第 4~6 / 7~9 / 10 次以上 落在哪一档（档位定义见 dialogues.json 的「日常.连击」） */
  function comboPool(count) {
    var segs = DAILY["连击"] || [];
    for (var i = 0; i < segs.length; i++) {
      if (count >= segs[i].min && count <= segs[i].max) return segs[i].lines;
    }
    return null;
  }

  var LIFE = DAILY["生活"] || {};

  /* 当前时段该用哪几句（生活池版） */
  function lifePeriodPool() {
    var per = window.MomoScene ? MomoScene.period() : "夜晚";
    var keys = PERIOD_KEYS[per] || [per];
    var out = [];
    keys.forEach(function (k) {
      var l = (LIFE["时段"] || {})[k];
      if (l) out = out.concat(l);
    });
    return out;
  }

  /* ---------- 状态感知：她读过你的档案 ----------
     触发条件成立才进池 —— 没发生的事她不会瞎说。阈值与换算见 lessons.json。 */
  function statePool() {
    var SP = DAILY["状态"] || {};
    var out = [];
    var S = window.MomoStore && window.MomoStore.state ? window.MomoStore.state : null;
    var D = (window.MomoDaily && MomoDaily.state) ? MomoDaily.state() : null;
    if (S && Math.round(S.supplies || 0) < 40) out = out.concat(SP["supply_low"] || []);
    if (D && D.quiz_total >= 5) {
      var acc = D.quiz_right / D.quiz_total;
      if (acc >= 0.9) out = out.concat(SP["accuracy_high"] || []);
      else if (acc < 0.7) out = out.concat(SP["accuracy_low"] || []);
    }
    if (D && D.streak >= 3) out = out.concat(SP["streak"] || []);
    /* 灯数状态源（2026-10 心之桥）：她攒了几分勇气，日常口吻就带几分远方——
       与好感分层正交的另一条长弧时间线。键 = lamp_<当前灯数>，没写的灯数自动无声。 */
    if (S && S.bridge && S.bridge.lit > 0) {
      var lp = SP["lamp_" + S.bridge.lit];
      if (lp) out = out.concat(lp);
    }
    return out;
  }

  /* ---------- 好感分层：同一只手，不同的她 ----------
     阈值就是 lessons.json economy.affection.levels（Lv1~10）：
     Lv1~3 毒舌全开（低）、Lv4~6 别扭（中）、Lv7+ 嘴硬心软（高）。
     兜底池也走这里 —— 好感不同，连日常牢骚的味道都不一样。 */
  function affectionTier() {
    var L = (window.MOMO_DATA || {}).lessons || {};
    var levels = (((L.economy || {}).affection || {}).levels) ||
                 [0, 20, 50, 100, 160, 240, 340, 460, 600, 760];
    var a = (window.MomoStore && window.MomoStore.state.affection) || 0;
    var lv = 0;
    for (var i = 0; i < levels.length; i++) if (a >= levels[i]) lv = i + 1;
    if (lv <= 3) return "低";
    if (lv <= 6) return "中";
    return "高";
  }
  function tierPool() {
    var T = DAILY["通用"] || {};
    if (T["低"] || T["中"] || T["高"]) return T[affectionTier()] || T["低"] || [];
    return Array.isArray(T) ? T : [];       /* 兼容：万一被改回数组形态 */
  }

  /* 挑一句。优先级（2026-10 换血后的《日常》）：
     连击段位 → 彩蛋(3%) → 状态感知(35%，有触发才有) → 生活·场景(30%)
     → 生活·时段(30%) → 旧台词(12%，新主旧兑) → 通用·好感分层兜底。
     台词里的 {{supply}}/{{rate}}/{{streak}} 等占位符由 MomoName.fill 实时填。 */
  function pickLine(room, combo) {
    var seg = comboPool(combo);                       /* 连击段位整档接管 */
    if (seg) return fill(one(seg));
    if (Math.random() < EGG_CHANCE) {
      var egg = pool(DAILY["彩蛋"]);
      if (egg) return fill(one(egg));
    }
    if (Math.random() < 0.35) {
      var sp = statePool();
      if (sp.length) return fill(one(sp));
    }
    if (Math.random() < SCENE_LINE_CHANCE) {
      var sc = pool((LIFE["场景"] || {})[room]);
      if (sc) return fill(one(sc));
    }
    if (Math.random() < PERIOD_LINE_CHANCE) {
      var pe = pool(lifePeriodPool());
      if (pe) return fill(one(pe));
    }
    if (Math.random() < 0.12) {                       /* 旧台词：低频怀旧/兜底 */
      var ol = pool(DAILY["旧"]);
      if (ol) return fill(one(ol));
    }
    return fill(one(tierPool()));
  }
  function fill(s) { return window.MomoName ? MomoName.fill(s) : s; }

  /* ---------- 一、切场景的四拍 ---------- */
  /* 在地图上点了房间时先只记下来：那一刻还在地图界面，主画面没激活，演不了。
     等 momo:show（主画面）再开演 —— ui.js 是先加 .active 再派发，所以那时一定演得成。 */
  var pending = null;
  document.addEventListener("momo:room", function (e) {
    if (e.detail && e.detail.room) pending = e.detail.room;
  });

  function sceneNodes(room) {
    var nodes = (NAR_MAP[room] || []).map(function (t) {
      return { type: "narration", text: t };
    });
    nodes.push({ type: "reveal" });                              /* ③ 立绘登场 */
    nodes.push({ type: "expr", name: "默认", hold: REVEAL_BEAT });
    if (Math.random() < SCENE_SAY_CHANCE) {                      /* ④ 有概率说一句 */
      var line = pickLine(room, 0);
      if (line) nodes.push({ type: "say", text: line });
    }
    nodes.push({ type: "end" });
    return nodes;
  }

  document.addEventListener("momo:show", function (e) {
    if (!e.detail || e.detail.screen !== SCR || !pending) return;
    var room = roomKey(pending);
    pending = null;
    if (!window.MomoDirector) return;
    /* 主线剧本正演着就别插队（开场时误点了地图就是这样）：那次 armSceneIn 也没生效，
       立绘本来就亮着，跳过这一段反而是对的。 */
    if (window.MomoDirector.isPlaying()) return;
    window.MomoDirector.playNodes(sceneNodes(room), { keepHidden: true });
  });

  /* ---------- 会话问候（每次打开游戏一句）----------
     不是剧本、不落存档：第一次进主画面、且开场剧情不在演的时候，放一句问候。
     台词走 MomoAudio.pick —— 学哪个语种就放哪个语种的问候（vo-en-greet-* /
     vo-ja-greet-*），没录变体回落中文（vo-greet-*）。新档的第一次问候由开场
     剧情本尊承担（isPlaying 检查兜住新档）。 */
  /* 时段问候（2026-10-20 作者要求：问候丰富一点、不要老是劝学）：
     前缀按现在的时间段分开 —— 清晨 vo-morning-* / 午后 vo-noon-* / 夜晚 vo-night-*，
     每段录几号就轮几号（编号仍按权重：-1 主、-2 减半…）。
     哪个时段一句都没录就退回通用池 vo-greet-*，不会突然变哑。 */
  function slotPrefix() {
    var per = (window.MomoScene && MomoScene.period) ? MomoScene.period() : "夜晚";
    if (per === "早晨") return "vo-morning-";
    if (per === "傍晚") return "vo-noon-";     /* 11–18 点：scene.js 把午后/傍晚都判成傍晚 */
    return "vo-night-";
  }
  function greetLine() {
    if (!window.MomoAudio || !MomoAudio.pick) return "";
    return MomoAudio.pick(slotPrefix()) || MomoAudio.pick("vo-greet-");
  }
  var greeted = false, greetedSlot = "";
  function greet(delay) {
    var line = greetLine();
    if (!line) return;
    setTimeout(function () {
      if (window.MomoDirector && window.MomoDirector.isPlaying()) return;
      MomoAudio.vo(line);
    }, delay || 0);
  }
  document.addEventListener("momo:show", function (e) {
    if (!e.detail || e.detail.screen !== SCR || greeted) return;
    greeted = true;
    greetedSlot = (window.MomoScene && MomoScene.period) ? MomoScene.period() : "";
    greet(1400);
  });
  /* 跨到下一个时段时也问候一句（同一次打开里每个时段只问候一次） */
  document.addEventListener("momo:slot", function (e) {
    var per = (window.MomoScene && MomoScene.period) ? MomoScene.period() : "";
    if (!greeted || per === greetedSlot) return;
    var scr = document.querySelector('[data-screen="' + SCR + '"]');
    if (!scr || !scr.classList.contains("active")) return;
    greetedSlot = per;
    greet(600);
  });

  /* ---------- 二、常态点她 ---------- */
  var combo = 0, comboAt = 0, lastLine = "", says = 0;

  function onHit(e) {
    burst();                                     /* 星星先放：演出中也可以有 */
    if (window.MomoDirector && window.MomoDirector.isPlaying()) return;   /* 演出中：这次点击留给「点一下推进」 */
    /* 常态：别让整屏的「点一下推进」把刚弹出的话又立刻收掉（同一次点击会先到这里、再冒泡到整屏） */
    e.stopPropagation();
    var now = Date.now();
    combo = (now - comboAt <= COMBO_GAP) ? combo + 1 : 1;
    comboAt = now;
    var st = window.MomoStore && window.MomoStore.state;
    var line = pickLine(roomKey((st && st.room) || ""), combo);
    if (!line) return;
    lastLine = line;
    says++;
    window.MomoDirector.playNodes([{ type: "say", text: line }, { type: "end" }]);
  }

  function hitEl() { return document.querySelector('[data-screen="' + SCR + '"] .momo-hit'); }
  function spriteEl() { return document.querySelector('[data-screen="' + SCR + '"] [data-costume]'); }
  var hit = null;
  function bind() {
    hit = hitEl();
    if (!hit) return false;
    hit.addEventListener("click", onHit);
    return true;
  }

  /* ---------- 小星星 ----------
     星星落在舞台坐标系（1920×1080）里，所以直接读立绘的 offset*：
     它不受呼吸动画那段 transform 影响，也不需要跟窗口缩放换算（.stage 整体 scale）。
     范围绕着她的身子撒，并避开左上角的时间条 —— 她那块矩形左边压在时间条右缘，
     所以圆心往右收、半径也别撒太开。 */
  var layer = null;
  function sparkLayer() {
    if (layer && layer.parentNode) return layer;
    var stage = document.querySelector('[data-screen="' + SCR + '"] .stage');
    if (!stage) return null;
    layer = document.createElement("div");
    layer.className = "spark-layer";
    stage.appendChild(layer);         /* 追加在最后 = 盖在最上层；pointer-events:none，不挡点击 */
    return layer;
  }
  /* 系统里开了「减少动态效果」就不撒星星了。必须在 JS 里拦 ——
     若只靠 CSS 停掉 animation，animationend 不触发，星星会永远堆在 DOM 里删不掉。 */
  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  /* 到时候就把这颗星星摘掉（动画结束 or 兜底超时，先到先摘） */
  function killOn(el, ms) {
    function kill() { if (el.parentNode) el.parentNode.removeChild(el); }
    el.addEventListener("animationend", kill);
    setTimeout(kill, ms);
  }
  function burst() {
    if (reduceMotion()) return;
    var box = sparkLayer(), el = spriteEl();
    if (!box || !el) return;
    var L = el.offsetLeft, T = el.offsetTop, W = el.offsetWidth, H = el.offsetHeight;
    var cx = L + W * (0.32 + Math.random() * 0.48);
    var cy = T + H * (0.05 + Math.random() * 0.55);
    var n = SPARK_MIN + Math.floor(Math.random() * (SPARK_MAX - SPARK_MIN + 1));
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var r = 25 + Math.random() * 95;
      var s = document.createElement("i");
      s.className = "spark";
      s.style.left = (cx + Math.cos(a) * r) + "px";
      s.style.top = (cy + Math.sin(a) * r * 0.72) + "px";
      s.style.width = s.style.height = (16 + Math.random() * 22).toFixed(0) + "px";
      s.style.animationDelay = (Math.random() * 90).toFixed(0) + "ms";
      /* 自删要留一条后路：只挂 animationend 是不够的 —— 星星还在飞的时候玩家切了屏，
         .screen 一 display:none，动画被中断、animationend 就永远不会来了，星星会烂在 DOM 里。
         所以再加一个定时兜底，谁先到算谁（两处都判 parentNode，重复调用是空操作）。 */
      killOn(s, 1100);
      box.appendChild(s);
    }
  }

  if (!bind()) document.addEventListener("DOMContentLoaded", bind);

  window.MomoIdle = {
    /* 切场景那四拍的节点表（房间名未折算也能传）。给验证脚本断顺序用 ——
       顺序是用户定死的硬要求，不能靠概率碰运气。 */
    sceneNodes: function (room) { return sceneNodes(roomKey(room)); },
    /* 同一套挑句逻辑对外开放：chat.js 在模型不可用时要拿它兜底，
       这样「断网时她说什么」跟她平时说的话是同一个味道。 */
    pick: function (room, combo) { return pickLine(roomKey(room || ""), combo || 0); },
    /* 供自动化验证用 */
    state: function () {
      var st = window.MomoStore && window.MomoStore.state;
      var key = roomKey((st && st.room) || "");
      return {
        room: key,
        hasSceneNar: !!(NAR_MAP[key] || []).length,
        narLines: (NAR_MAP[key] || []).length,
        pending: pending,
        combo: combo,
        says: says,
        lastLine: lastLine,
        sparks: layer ? layer.children.length : 0,
        hitOk: (function () {
          var el = hitEl();
          if (!el) return false;
          var b = el.getBoundingClientRect();
          var top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return top === el;
        })()
      };
    }
  };
})();