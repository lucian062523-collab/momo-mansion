/* 墨墨 · 月见茶会 · AI 夜（tea-ai.js）
   一个 LLM 驱动的茶会狼人杀：7 位 NPC 由模型扮演、每局随机 3 狼（1 狼王）+ 预言家/女巫/猎人/1 民；
   玩家固定为村民，身份在剧情 ch1_茶会前 抽到，进入本模块后只揭示玩家身份、直接从第一夜开始。

   设计纪律：
     1. 数据驱动 —— 人物、关系、说话禁忌、狐/客行为、规则全部读
        game/content/tea_personas.json（window.MOMO_DATA.tea_personas）；
        本文件里的 DEFAULT 只是「作者设定未到 / 缺字段」时的兜底。
        卡面图映射读 game/content/tea_cards.json（或 window.MOMO_TEA_CARDS），
        没有图就用内置 SVG 占位。
     2. 只有模型与 state() 看到身份；UI 永远不剧透存活者的狐/客。
     3. 一局调用：入席无 AI；白昼按 2 人一组（质量优先）+ 玩家接话 ≤2 + 结局 1，硬上限 15。
        每次都有 15s 超时与本地兜底（party_月见茶会.json 的 pools / 内置台词），
        断网也能把一局走完。
     4. 结局落 MomoStore.state.bridge.lit=1 / ch1_done=true；已亮不重复发奖。
     5. window.MOMO_TEA_DEBUG=true 时跳过所有等待，便于无头测试。 */
(function () {
  "use strict";

  var MD = window.MOMO_DATA || {};
  var PT = MD["party_月见茶会"] || {};
  var RAW = MD.tea_personas || window.MOMO_TEA_PERSONAS || {};
  var RAW_CARDS = window.MOMO_TEA_CARDS || MD.tea_cards || {};

  var ENDPOINT_FALLBACK = "https://momo-chat-api.pages.dev/chat";
  var AI_TOTAL_TIMEOUT = 15000;     /* 单次调用总预算：15s（首次 6.5s 无字即重连一次） */
  var AI_FIRST_WAIT = 6500;
  var AI_MAX_CALLS = 15;            /* 硬上限：3 昼 + 3 票 + 3 接话 + 1 结局 = 10，留 2 次余量 */
  var MAX_LOG = 120;

  /* ============================================================
     一、内置 DEFAULT 配置（作者正式设定未到 / 缺字段时的兜底）
     结构与 game/content/tea_personas.json 完全一致，逐字段合并。
     ============================================================ */
  var DEFAULT = {
    rules: {
      seat_order: ["千春", "池田", "茶终", "玩家", "墨墨", "樱井", "小野", "幸子"],
      host: "月见",
      player: "玩家",
      player_label: "你",
      player_role: "random",
      player_role_random: true,
      fox_count: 3,
      max_days: 4,
      role_pool: { wolf: 2, wolf_king: 1, seer: 1, witch: 1, hunter: 1, villager: 2 },
      role_labels: {
        wolf: "隐狼", wolf_king: "狼王", seer: "预言家",
        witch: "女巫", hunter: "猎人", villager: "村民", host: "主持"
      },
      wolf_king: {
        shot_on_vote: true, shot_on_knife: true,
        shot_on_poison: false, shot_on_shot: true
      },
      hunter: {
        shot_on_vote: true, shot_on_knife: true,
        shot_on_poison: false, shot_on_shot: true
      },
      death_shot: {
        chain: true, max_shots: 4, npc_choice: "weight",
        target_role_weight: { seer: 4, witch: 3, hunter: 2, villager: 1, wolf: 0.15, wolf_king: 0.1 },
        revenge_bonus: 2.2, protect_penalty: 0.08
      },
      seer: { check_each_night: true, result_truthful: true },
      witch: {
        antidote: 1, poison: 1, can_self_save: false,
        one_potion_per_night: true, poison_after_day: 2,
        save_base_chance: 0.55, save_protect_bonus: 0.35,
        poison_base_chance: 0.45, poison_protect_penalty: 0.08
      },
      night: {
        knife_base_weight: 1,
        knife_weight: { "樱井": 1.1, "小野": 1.1, "幸子": 1, "玩家": 0.6 },
        knife_role_weight: { seer: 1.6, witch: 1.4, hunter: 1.2, villager: 1, wolf: 0, wolf_king: 0 },
        knife_zero: { "千春": ["池田"], "茶终": ["樱井"], "墨墨": ["玩家"] }
      },
      vote: {
        "池田": { "千春": 6, "else": 1 },
        "千春": { "never": ["池田"] },
        "茶终": { "never": ["樱井"] },
        "小野": { "never": ["幸子"] },
        "幸子": { "follow": true },
        "樱井": { "trust_check": true },
        "墨墨": { "never": ["玩家", "墨墨"] }
      },
      win: {
        guest: "狼全出局 = 好人胜",
        fox: "狼数 ≥ 好人数 = 狼胜",
        judge: "第 max_days 天仍未分胜负 = 月见裁（开放结局）"
      },
      player_actions: {
        enabled: true, timeout_ms: 15000,
        wolf_default: "npc_suggestion", seer_default: "random_check",
        witch_default: "not_use", shot_default: "random"
      },
      ai: {
        calls_target: [8, 15],
        player_input_calls: 2,
        day_line_max: 90,
        ending_line_max: 70,
        day_group_size: 3
      }
    },
    host_lines: {
      night: "夜了。请诸位闭目——隐狐的茶，要斟满。",
      night_you: "（你也闭上了眼。黑暗里，有茶香在桌上传来传去。）",
      dawn_none: "天亮了。今晨，无人离席。",
      dawn_dead: "天亮了。{who}，昨夜离席。",
      dawn_knife: "天亮了。{who}，昨夜离席。",
      dawn_saved: "天亮了。今晨，无人离席。",
      dawn_poison: "天亮了。{who}，昨夜离席。",
      shot: "{who} 在离席前，带走了 {target}。",
      day_open: "茶续上。发言，开始。",
      vote_open: "举盏。今晨请离席的客人，由诸位的手决定。",
      vote_out: "{who}，请离席。茶盏，收走。",
      vote_none: "……平盏。今晨，无人离席。",
      finale: "终局。胜负已定——月见将给出最后的收束。"
    },
    endings: {
      guest_win: { label: "狼被找齐了", lines: [
        { who: "月见", text: "三只隐狼，都离席了。茶会，散。" },
        { who: "墨墨", text: "……哼。还算你有点用。茶凉了，回家。" }
      ] },
      fox_win: { label: "狼混过了这一夜", lines: [
        { who: "月见", text: "狼还在席上。今夜，算你们赢。" },
        { who: "墨墨", text: "……啧。别看了。走了。" }
      ] },
      judge: { label: "月见裁", lines: [
        { who: "月见", text: "四日已尽，狼未现形。今夜的裁，由我来下。" },
        { who: "月见", text: "茶会到此为止。剩下的，留给你们自己。" }
      ] },
      player_out: { label: "你在席上被请离", lines: [
        { who: "月见", text: "你，请离席。" },
        { who: "墨墨", text: "……喂。站住。谁准你走的。" }
      ] },
      player_night: { label: "你在夜里离席", lines: [
        { who: "月见", text: "你的盏，空了。茶会……继续。" },
        { who: "墨墨", text: "……笨蛋。谁让你闭眼的。" }
      ] },
      player_shot: { label: "你在席间被带走", lines: [
        { who: "月见", text: "枪响之前，茶已经凉了。" },
        { who: "墨墨", text: "……谁让你站那么近的。" }
      ] },
      player_knife: { label: "你的茶盏空了", lines: [
        { who: "月见", text: "你的盏，空了。茶会……继续。" },
        { who: "墨墨", text: "……笨蛋。谁让你闭眼的。" }
      ] }
    },
    /* 内置人物兜底：字段与 tea_personas.json 的 characters 一致。
       作者文件到了以后逐字段覆盖；作者删掉的字段仍能从这里取到安全值。 */
    characters: {
      "月见": {
        name: "月见", label: "月 见", tagline: "茶会开始，请诸位安静。",
        persona: "主持人。不投票、不站队，只在夜与昼之间报幕，在三日后裁决。看穿一切却从不说破。",
        relations: { "所有人": "一碗水端平；她主持，但不参与" },
        taboos: ["绝不参与投票", "绝不评价谁像狐"],
        fox_behavior: "她是主持，永远不会是狐。",
        guest_behavior: "主持。报幕、请离席、终局裁决。",
        voice: "克制、书面、留白；句子短。",
        color: "#c9a86a", accent: "#6d5733", emoji: "🌙", motif: "moon"
      },
      "千春": {
        name: "千春", label: "千 春", tagline: "池田哥哥只能看着我哦。",
        persona: "茶会里最会撒娇的妹妹。笑得越甜，心里越冷；把池田当成自己的所有物。",
        relations: { "池田": "病娇式的占有", "墨墨": "互相试探", "月见": "敬畏主持" },
        taboos: ["不直白说自己是狐或不是狐", "不在池田面前提「回不去」"],
        fox_behavior: "用可爱和撒娇带节奏，把怀疑往池田身边的人身上引。",
        guest_behavior: "真心在意池田，却用占有欲表达。",
        voice: "句尾常带「～」「哦」「呢」，被逼急时句子突然变短。",
        color: "#d98b9d", accent: "#7d3f4d", emoji: "🌸", motif: "twin"
      },
      "池田": {
        name: "池田", label: "池 田", tagline: "我不喝陌生人倒的茶！",
        persona: "想回到过去的男人。焦躁、容易激动，对千春既依赖又害怕。",
        relations: { "千春": "被偏执地依赖着", "茶终": "嘴硬顶撞，其实敬他", "墨墨": "互看不顺眼" },
        taboos: ["不说「我不在乎回去」", "不冷静地讲长篇道理"],
        fox_behavior: "用急躁和指责掩盖心虚，先大声怀疑别人。",
        guest_behavior: "真的害怕，也真的在找回去的线索。",
        voice: "短句，多用「！」，一紧张就重复自己。",
        color: "#c08a5e", accent: "#6b452c", emoji: "🕰️", motif: "short"
      },
      "茶终": {
        name: "茶终", label: "茶 终", tagline: "茶未凉，人别急。",
        persona: "茶会的老人。话少，听得多。对樱井有一种照看孙女般的温和。",
        relations: { "樱井": "长辈式的照看", "千春": "看穿她的笑", "月见": "沉默默契" },
        taboos: ["几乎不解释、不自辩", "不说长句"],
        fox_behavior: "用沉默制造压力，偶尔一句话把水搅浑。",
        guest_behavior: "护着樱井；凭直觉投最吵的人。",
        voice: "极短句，常见四字。",
        color: "#8a8f7d", accent: "#4e5246", emoji: "🍵", motif: "topknot"
      },
      "樱井": {
        name: "樱井", label: "樱 井", tagline: "照镜不撒谎，撒谎的是座位。",
        persona: "记录者。手里有镜子，也有本子。相信秩序与编号。",
        relations: { "茶终": "对长辈的敬重", "墨墨": "两个「镜子」天然对立", "月见": "服从秩序" },
        taboos: ["不承认没有编号的指认", "不说「直觉」"],
        fox_behavior: "假装查验链完整，用编号和细节压人。",
        guest_behavior: "真的查验，真的记录。",
        voice: "像档案：编号、顺序、结论。",
        color: "#8fa7c4", accent: "#41536b", emoji: "🪞", motif: "long"
      },
      "小野": {
        name: "小野", label: "小 野", tagline: "狐狸又不会咬人——大概。",
        persona: "药茶师。豪爽爱笑，胆大心细。把幸子当妹妹护着。",
        relations: { "幸子": "打心底护着", "樱井": "棋逢对手的欣赏", "千春": "不信任那份甜" },
        taboos: ["不在幸子面前说重话", "不承认自己下毒"],
        fox_behavior: "用玩笑和豪爽掩护，把怀疑引向沉默的人。",
        guest_behavior: "真的会护幸子，用试探和激将法找狐。",
        voice: "爽朗，爱用「哈哈哈」「喂喂」，笑点之后突然认真。",
        color: "#7fa77a", accent: "#3f5b3c", emoji: "🌿", motif: "ponytail"
      },
      "幸子": {
        name: "幸子", label: "幸 子", tagline: "我、我只是想把话记下来……",
        persona: "怯懦的记账人。带着小本子，记下每句话的时间与语气。",
        relations: { "小野": "依赖又不想拖累", "池田": "觉得他可怜", "墨墨": "怕她" },
        taboos: ["句首先道歉", "不主动指认"],
        fox_behavior: "装可怜、装糊涂，把票投给最不起眼的人。",
        guest_behavior: "怕母亲失望，越紧张越抠自己错；被逼急才小声说出关键一句。",
        voice: "句首「对、对不起」「那个……」；偶尔一句异常清晰。",
        color: "#b9a06e", accent: "#75603c", emoji: "📖", motif: "bob"
      },
      "墨墨": {
        name: "墨墨", label: "墨 墨", tagline: "哼，跟着我走就行。",
        persona: "洋馆的主人，玩家身边的人。嘴硬心软，护短到不讲理。",
        relations: { "玩家": "傲娇护短", "樱井": "同类相斥", "月见": "不服管，但给面子" },
        taboos: ["绝不向玩家说「我不在乎你」", "不解释自己的好意"],
        fox_behavior: "用刻薄和嘲讽带节奏；把玩家摘出去。",
        guest_behavior: "嘴硬地护着玩家；投票理由很敷衍，方向却常很准。",
        voice: "短促、反话、句尾「……哼」「啧」。",
        color: "#b57f8f", accent: "#6b3f4c", emoji: "🖤", motif: "ribbon"
      },
      "玩家": {
        name: "客人", label: "你", tagline: "墨墨之友；投票、参与逻辑盘算。",
        persona: "墨墨之友；投票、参与逻辑盘算。",
        relations: { "墨墨": "墨墨之友；嘴上不认，实际护短" },
        taboos: ["村民视角；不使用未公开信息", "不能替 NPC 发言"],
        fox_behavior: "玩家固定村民，不会拿到狼。",
        guest_behavior: "村民。可以自由发言、投票。",
        voice: "由玩家自由输入。",
        color: "#6f8296", accent: "#3c4b59", emoji: "🍃", motif: "hood"
      }
    }
  };

  /* ============================================================
     二、工具
     ============================================================ */
  function isObj(o) { return !!o && typeof o === "object" && !Array.isArray(o); }
  function clone(o) { return (o === undefined) ? undefined : JSON.parse(JSON.stringify(o)); }
  function merge(base, over) {
    if (over === undefined) return clone(base);
    if (isObj(base) && isObj(over)) {
      var out = {}, k;
      for (k in base) out[k] = merge(base[k], over[k]);
      for (k in over) if (!(k in base)) out[k] = clone(over[k]);
      return out;
    }
    return clone(over);
  }
  function rnd(n) { return Math.floor(Math.random() * n); }
  function pick(a) { return (a && a.length) ? a[rnd(a.length)] : null; }
  function shuffled(a) {
    a = (a || []).slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = rnd(i + 1), t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function isDebug() { return !!window.MOMO_TEA_DEBUG; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, isDebug() ? 0 : ms); }); }
  function sfx(n) { try { if (window.MomoAudio && MomoAudio.sfx) MomoAudio.sfx(n); } catch (e) {} }
  function endpoint() {
    return window.MOMO_TEA_URL || window.MOMO_CHAT_URL || ENDPOINT_FALLBACK;
  }
  function captureCorpus(who, text) {
    try {
      if (window.MomoCorpus && window.MomoCorpus.capture) window.MomoCorpus.capture(who, text);
      else document.dispatchEvent(new CustomEvent("momo:chatlog", { detail: { who: who, text: text } }));
    } catch (e) {}
  }
  function resolveAsset(v) {
    if (!v) return "";
    var U = window.ASSET_URI || {};
    if (U[v]) return U[v];
    try {
      var base = String(v).split("/").pop();
      if (U[base]) return U[base];
    } catch (e) {}
    return String(v);
  }

  /* ============================================================
     三、读配置（tea_personas.json ←→ DEFAULT 逐字段合并）
     ============================================================ */
  var C = merge(DEFAULT, RAW);
  var P = C.rules.player || "玩家";
  var HOST = C.rules.host || "月见";

  function normalizeSeats() {
    var r = C.rules;
    var seats = (r.seat_order || []).slice();
    /* 兼容旧数据/作者手写：'你' 视作玩家键 */
    seats = seats.map(function (n) { return (n === "你" || n === "末茶人") ? P : n; });
    if (seats.indexOf(P) < 0) seats.splice(Math.max(1, seats.length - 1), 0, P);
    /* 去重 */
    var seen = {};
    seats = seats.filter(function (n) { if (seen[n]) return false; seen[n] = 1; return true; });
    r.seat_order = seats;
    r.max_days = Math.max(1, Number(r.max_days) || 4);
    /* 角色池归一：按 config 计数展开，补齐/截断到席位数，保底 1 狼王/1 狼 */
    var pool = isObj(r.role_pool) ? r.role_pool : (DEFAULT.rules.role_pool || {});
    var list = [];
    Object.keys(pool).forEach(function (role) {
      var n = Math.max(0, Number(pool[role]) || 0);
      for (var i = 0; i < n; i++) list.push(role);
    });
    while (list.length < seats.length) list.push("villager");
    if (list.length > seats.length) {
      /* 截断时优先保狼王、狼、预言家、女巫、猎人 */
      var priority = ["wolf_king", "wolf", "seer", "witch", "hunter", "villager"];
      var keep = [];
      priority.forEach(function (role) {
        list.forEach(function (x, idx) {
          if (keep.length < seats.length && x === role && keep.indexOf(idx) < 0) keep.push(idx);
        });
      });
      list = keep.map(function (idx) { return list[idx]; });
    }
    if (!list.some(function (x) { return x === "wolf" || x === "wolf_king"; })) list[0] = "wolf_king";
    if (list.indexOf("wolf_king") < 0) list[list.indexOf("wolf")] = "wolf_king";
    var pool2 = {};
    list.forEach(function (role) { pool2[role] = (pool2[role] || 0) + 1; });
    r.role_pool = pool2;
    if (!r.role_labels) r.role_labels = (DEFAULT.rules.role_labels || {});
    r.player_role = (r.player_role_random || r.player_role === "random") ? "random" : (r.player_role || "random");
    if (!r.ai) r.ai = {};
    if (!r.night) r.night = {};
    if (!isObj(r.witch)) r.witch = {};
    if (!isObj(r.wolf_king)) r.wolf_king = {};
    if (!isObj(r.hunter)) r.hunter = {};
    if (!isObj(r.death_shot)) r.death_shot = {};
    if (!isObj(r.player_actions)) r.player_actions = {};
    return seats;
  }
  var SEATS = normalizeSeats();
  var NPCS = SEATS.filter(function (n) { return n !== P; });

  /* 补齐缺角色：只补一个安全骨架，避免作者配置写漏时整个模块崩掉 */
  function genericChar(name) {
    return {
      name: name, label: name, tagline: "",
      persona: "茶会的客人。",
      relations: {}, taboos: [],
      fox_behavior: "和客人一样说话，只是心里有鬼。",
      guest_behavior: "按自己的性格说话。",
      voice: "自然地说短句。",
      color: "#a08a6a", accent: "#5b4a34", emoji: "🍵", motif: "long"
    };
  }
  (function fillCharacters() {
    var names = SEATS.concat([HOST, P]);
    Object.keys(C.characters || {}).forEach(function (n) { names.push(n); });
    names.forEach(function (n) {
      var c = C.characters[n];
      if (!c) { C.characters[n] = merge(genericChar(n), PT.chars && PT.chars[n] ? { label: PT.chars[n].label } : {}); return; }
      /* 用 party 数据补 label（作者配置没写 label 时） */
      if ((!c.label || c.label === n) && PT.chars && PT.chars[n] && PT.chars[n].label) c.label = PT.chars[n].label;
      if (!c.color) c.color = "#a08a6a";
      if (!c.accent) c.accent = "#5b4a34";
      if (!c.emoji) c.emoji = "🍵";
      if (!c.motif) c.motif = "long";
      if (!c.persona) c.persona = "茶会的客人。";
    });
  })();

  function char(name) { return C.characters[name] || genericChar(name); }
  function labelOf(name) {
    if (name === P) return C.rules.player_label || "你";
    var c = char(name);
    return c.label || c.name || name;
  }
  function nameOf(name) { return name === P ? labelOf(P) : name; }
  function isFox(g, name) { return !!g && (g.wolves || []).indexOf(name) >= 0; }
  function foxCount() {
    var p = C.rules.role_pool || {};
    return (Number(p.wolf) || 0) + (Number(p.wolf_king) || 0) || 3;
  }
  function maxDays() { return C.rules.max_days || 4; }
  function roleLabel(role) {
    var L = C.rules.role_labels || {};
    return L[role] || ({ wolf: "隐狼", wolf_king: "狼王", seer: "预言家", witch: "女巫", hunter: "猎人", villager: "村民" })[role] || role;
  }
  function isWolfRole(role) { return role === "wolf" || role === "wolf_king"; }
  function roleOfName(g, name) { return (g && g.roles && g.roles[name]) || "villager"; }
  function findRole(g, role) {
    var list = (g && g.seats) || SEATS;
    for (var i = 0; i < list.length; i++) if (g.roles[list[i]] === role) return list[i];
    return null;
  }
  function wolvesOf(g) {
    var list = (g && g.seats) || SEATS;
    return list.filter(function (k) { return isWolfRole(g.roles[k]); });
  }
  function playerActionCfg() { return C.rules.player_actions || {}; }
  function actionTimeout() {
    var t = Number(playerActionCfg().timeout_ms) || 15000;
    return isDebug() ? Math.min(6000, t) : t;
  }
  function relationsText(c) {
    var r = c.relations || {};
    return Object.keys(r).map(function (k) { return k + "—" + r[k]; }).join("；");
  }
  function taboosText(c) { return (c.taboos || []).join("；") || "无"; }

  /* 卡面图映射：运行时 window.MOMO_TEA_CARDS 优先，其次 MOMO_DATA.tea_cards */
  var CARD_MAP = (function () {
    if (!RAW_CARDS) return {};
    if (isObj(RAW_CARDS.cards)) return RAW_CARDS.cards;
    if (Array.isArray(RAW_CARDS)) return {};
    return RAW_CARDS;
  })();
  function cardMap() {
    var m = window.MOMO_TEA_CARDS;
    if (m) {
      if (isObj(m.cards)) return m.cards;
      if (isObj(m)) return m;
    }
    return CARD_MAP;
  }
  function cardImage(name) {
    var map = cardMap();
    var v = map[name];
    if (!v && name === P) v = map["你"] || map["末茶人"];
    return v ? resolveAsset(v) : "";
  }

  /* ============================================================
     四、状态
     ============================================================ */
  var S = null;                  /* 当前对局 */
  var root = null, els = {};
  var api = { calls: 0, requests: 0, fails: 0, parseFails: 0, lastRaw: "", ms: [] };
  var genSeq = 0;

  /* ---------- VN 演出引擎（背景 / 立绘 / 羊皮纸对话框 / 打字机） ---------- */
  var VN = {
    queue: [], current: null, typing: false,
    full: "", shown: "", typeTimer: null, autoTimer: null,
    waiters: [], skipFast: false
  };
  function vnBusy() { return !!(VN.typing || VN.current || VN.queue.length); }
  function flushVN() {
    if (VN.typeTimer) clearTimeout(VN.typeTimer);
    if (VN.autoTimer) clearTimeout(VN.autoTimer);
    VN.queue = []; VN.current = null; VN.typing = false;
    VN.full = ""; VN.shown = ""; VN.skipFast = false;
    var ws = VN.waiters.splice(0);
    ws.forEach(function (fn) { try { fn(); } catch (e) {} });
  }
  function waitBeats(g) {
    return new Promise(function (resolve) {
      if (!vnBusy()) return resolve();
      if (S !== g) return resolve();
      VN.waiters.push(function () { resolve(); });
    });
  }


  function lampLit() {
    var st = window.MomoStore && window.MomoStore.state;
    return (st && st.bridge && Number(st.bridge.lit)) || 0;
  }
  function ch1Done() {
    var st = window.MomoStore && window.MomoStore.state;
    return !!(st && st.bridge && st.bridge.ch1_done);
  }
  function applyLamp() {
    var st = window.MomoStore && window.MomoStore.state;
    if (!st) return false;
    if (!isObj(st.bridge)) st.bridge = { lit: 0 };
    var first = !(Number(st.bridge.lit) > 0);
    st.bridge.lit = Math.max(Number(st.bridge.lit) || 0, 1);
    st.bridge.ch1_done = true;
    try { if (window.MomoStore.save) window.MomoStore.save(); } catch (e) {}
    return first;
  }
  function toast(msg) {
    var t = document.getElementById("momo-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "momo-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = "toast-ok";
    t.style.display = "block";
    t.style.zIndex = "2100000";   /* 要盖在茶会全屏浮层之上 */
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.style.display = "none"; }, 3400);
  }

  function assignRoles() {
    var pool = C.rules.role_pool || {};
    var list = [];
    Object.keys(pool).forEach(function (role) {
      var n = Math.max(0, Number(pool[role]) || 0);
      for (var i = 0; i < n; i++) list.push(role);
    });
    var roles = {};
    var fixedPlayer = C.rules.player_role && C.rules.player_role !== "random" ? C.rules.player_role : null;
    var rest = SEATS.slice();
    if (fixedPlayer) {
      roles[P] = fixedPlayer;
      var pi = list.indexOf(fixedPlayer);
      if (pi >= 0) list.splice(pi, 1);
      rest = NPCS.slice();
    }
    var forced = window.MOMO_TEA_FORCE_ROLES;
    if (isObj(forced)) {
      Object.keys(forced).forEach(function (name) {
        var role = forced[name];
        if (SEATS.indexOf(name) < 0 || !role) return;
        if (roles[name]) {
          /* 覆盖固定身份：把旧角色放回池子 */
          list.push(roles[name]);
        }
        var idx = list.indexOf(role);
        if (idx >= 0) list.splice(idx, 1);
        roles[name] = role;
        var ri = rest.indexOf(name);
        if (ri >= 0) rest.splice(ri, 1);
      });
    }
    while (list.length < rest.length) list.push("villager");
    if (list.length > rest.length) list = list.slice(0, rest.length);
    var sh = shuffled(list);
    rest.forEach(function (name, i) { roles[name] = sh[i] || "villager"; });
    /* 保底：狼王至少 1 只（除非玩家被强制为狼王） */
    var wantKing = (Number(pool.wolf_king) || 0) > 0;
    var kings = SEATS.filter(function (n) { return roles[n] === "wolf_king"; });
    var wolves = SEATS.filter(function (n) { return isWolfRole(roles[n]); });
    if (wantKing && !kings.length && wolves.length) {
      var promote = wolves.filter(function (n) { return n !== P; })[0] || wolves[0];
      roles[promote] = "wolf_king";
      wolves = SEATS.filter(function (n) { return isWolfRole(roles[n]); });
    }
    if (!wolves.length) {
      var cand = NPCS[rnd(NPCS.length)];
      roles[cand] = "wolf_king";
    }
    return roles;
  }

  function newGame() {
    var prev = S;
    if (prev && prev.lampTimers) prev.lampTimers.forEach(function (t) { clearTimeout(t); });
    var lit = lampLit() > 0;
    var roles = assignRoles();
    var wolves = SEATS.filter(function (n) { return isWolfRole(roles[n]); });
    var alive = {};
    SEATS.forEach(function (k) { alive[k] = true; });
    S = {
      gen: ++genSeq,
      day: 1,
      phase: "open",
      busy: false,
      busyLabel: "",
      spoke: false,
      seats: SEATS.slice(),
      roles: roles,
      wolves: wolves,
      foxes: wolves,                 /* 兼容旧 state 字段 */
      wolfKing: SEATS.filter(function (n) { return roles[n] === "wolf_king"; })[0] || null,
      seer: SEATS.filter(function (n) { return roles[n] === "seer"; })[0] || null,
      witch: SEATS.filter(function (n) { return roles[n] === "witch"; })[0] || null,
      hunter: SEATS.filter(function (n) { return roles[n] === "hunter"; })[0] || null,
      playerRole: roles[P],
      alive: alive,
      dead: {},
      playerAlive: true,
      witchPotions: {
        antidote: Number((C.rules.witch || {}).antidote) || 0,
        poison: Number((C.rules.witch || {}).poison) || 0
      },
      seerChecks: [],
      shots: [],
      deathShotsDone: {},
      lastVotesAgainst: {},
      checked: null,
      checkedAt: 0,
      lastNight: null,
      npcVotes: null,
      voteLines: null,
      voteDetail: null,
      tally: null,
      playerVote: null,
      expel: null,
      winner: null,
      gameWinner: null,
      pendingWinner: null,
      wasLit: lit,
      lampFirst: false,
      toasted: false,
      lamped: false,
      lampTimers: [],
      ended: false,
      aiCalls: 0,
      playerTalk: 0,
      wishesDone: false,
      transcript: [],
      targetHeat: {},
      lastPatterns: {},
      plans: {},
      wolfChat: null,
      playerStance: null,
      playerStanceApplied: null,
      plannedVotes: null,
      log: [],
      skip: false,
      typing: false,
      lastInputAt: 0,
      choice: null,
      ending: null
    };
    api = { calls: 0, requests: 0, fails: 0, parseFails: 0, lastRaw: "", ms: [] };
    if (els.log) els.log.innerHTML = "";
    if (els.endmask) { els.endmask.classList.add("hidden"); els.endmask.innerHTML = ""; }
    if (els.skip) els.skip.style.display = "none";
    if (els.input) { els.input.value = ""; }
    if (els.choicebar) { els.choicebar.innerHTML = ""; els.choicebar.classList.add("hidden"); }
    flushVN();
    S.stripShown = false;
    setScene("cg_enter1");
    renderCards();
    syncUI();
    opening();
  }

  function opening() {
    /* 剧情 ch1_茶会前 已完成 月见出场/规则/抽身份；这里只揭示玩家身份，直接进第一夜。
       不再重复「规则/发身份」；规则仍可从右上「规则」查看。 */
    setScene("bg_tea", "dawn");
    addLine(null, playerIdentityText(), "private");
    addLine(HOST, "茶会，开始了。请诸位，闭目。", "host");
    var g = S;
    if (g) g.wishesDone = true;
    syncUI();
  }

  /* 玩家自己的身份说明（只显示在玩家屏幕；NPC 身份不显示） */
  function playerIdentityText() {
    if (!S) return "";
    var role = S.roles[P];
    var wolves = S.wolves.filter(function (k) { return k !== P; });
    var tail = "";
    if (isWolfRole(role)) {
      tail = "狼同伴：" + (wolves.length ? wolves.map(nameOf).join("、") : "只剩你一个") +
        "。夜里点角色卡选刀；也可以跳过，交给同伴。" +
        (role === "wolf_king" ? "你离席时可带走一人。" : "");
    } else if (role === "seer") {
      tail = "每晚点一张角色卡查验，结果只有你看得见。";
    } else if (role === "witch") {
      tail = "解药 " + S.witchPotions.antidote + " / 毒药 " + S.witchPotions.poison +
        "；一晚只用一瓶；解药只救狼刀，毒药从第 2 夜起可用。";
    } else if (role === "hunter") {
      tail = "被狼刀或被放逐时，可开枪带走一人；被女巫毒死则不能。";
    } else {
      tail = "没有夜间行动。白天发言、投票。";
    }
    return "〔你的身份〕" + roleLabel(role) + "。" + tail;
  }

  /* ============================================================
     五、日志 / 舞台 / 卡片
     ============================================================ */
  function addLine(who, text, kind, expr, stance, target, goal, facts, respond, voteIntent) {
    if (!S) return;
    text = String(text == null ? "" : text).replace(/\s*\n+\s*/g, " ").trim();
    if (!text) return;
    if (text.length > 220) text = text.slice(0, 219) + "…";
    kind = kind || (who === HOST ? "host" : "line");
    var e = { who: who || "", text: text, kind: kind, expr: expr || "", stance: stance || "",
      target: target || "", goal: goal || "", facts: facts || [], respond: respond || "",
      voteIntent: voteIntent || "", day: S.day };
    S.log.push(e);
    if (S.log.length > MAX_LOG) S.log = S.log.slice(-MAX_LOG);
    /* 隐藏日志保留给自动化/兼容（旧测试会数 .tl）；玩家看到的走 VN */
    if (els.log) {
      var div = document.createElement("div");
      div.className = "tl tl-" + kind;
      div.innerHTML = '<span class="tl-name">' + esc(who ? labelOf(who) : "") +
        '</span><span class="tl-text">' + esc(text) + "</span>";
      els.log.appendChild(div);
    }
    if (e.who === "墨墨" && kind !== "sys" && kind !== "private") captureCorpus("momo", text);
    if (e.goal && e.who && e.who !== P) {
      if (S.lastPatterns) S.lastPatterns[e.who] = speechPattern(text);
      S.transcript.push({ day: S.day, who: e.who, text: text, stance: e.stance,
        target: e.target, goal: e.goal, facts: e.facts || [],
        respond: e.respond || "", voteIntent: e.voteIntent || "" });
    }
    flashTalk(who, kind);
    VN.queue.push(e);
    if (!VN.current && !VN.typing) showNextBeat();
  }

  function beatName(b) {
    if (b.kind === "private") return "（只有你听见）";
    if (b.kind === "narr" || b.kind === "sys" || b.kind === "reveal" || !b.who) return "茶会的角落";
    return labelOf(b.who);
  }
  function showNextBeat() {
    if (VN.current || VN.typing) return;
    var b = VN.queue.shift();
    if (!b) {
      VN.skipFast = false;
      if (S) syncUI();
      var ws = VN.waiters.splice(0);
      ws.forEach(function (fn) { try { fn(); } catch (e) {} });
      return;
    }
    VN.current = b;
    renderBeat(b);
  }
  function renderBeat(b) {
    if (!S || !els.dbox) return;
    els.dname.textContent = beatName(b);
    els.dname.className = "tea-name" +
      (b.who === P ? " you" : "") + (b.kind === "private" ? " private" : "") +
      ((b.kind === "narr" || b.kind === "sys" || b.kind === "reveal" || !b.who) ? " narr" : "");
    els.dname.style.borderColor = (b.who && b.who !== P) ? (char(b.who).color || "#c9a86a") : "";
    els.dtext.className = "tea-dtext" + (b.kind === "private" ? " private" : "") +
      ((b.kind === "narr" || b.kind === "sys" || b.kind === "reveal") ? " narr" : "");
    showPortraitForBeat(b);
    VN.full = b.text;
    VN.shown = "";
    VN.typing = true;
    els.dnext.classList.remove("on");
    els.dtext.textContent = "";
    if (els.skip) els.skip.style.display = "";
    if (isDebug() || VN.skipFast) { revealBeatAll(); return; }
    (function typeStep() {
      if (!S || VN.current !== b) return;
      if (!VN.typing) return;
      VN.shown = VN.full.slice(0, VN.shown.length + 1);
      els.dtext.textContent = VN.shown;
      if (VN.shown.length >= VN.full.length) {
        VN.typing = false;
        els.dnext.classList.add("on");
        scheduleAuto();
        return;
      }
      VN.typeTimer = setTimeout(typeStep, 20);
    })();
  }
  function revealBeatAll() {
    if (!VN.current) return;
    if (VN.typeTimer) clearTimeout(VN.typeTimer);
    VN.shown = VN.full;
    VN.typing = false;
    els.dtext.textContent = VN.full;
    els.dnext.classList.add("on");
    scheduleAuto();
  }
  function scheduleAuto() {
    if (VN.autoTimer) clearTimeout(VN.autoTimer);
    if (!S) return;
    if (window.MOMO_TEA_PAUSE) return;   /* 测试/暂停：不自动推进，等点击 */
    var delay = (isDebug() || VN.skipFast) ? 0 : Math.min(5200, 1500 + VN.full.length * 24);
    VN.autoTimer = setTimeout(function () {
      if (VN.current && !VN.typing) advanceBeat();
    }, delay);
  }
  function advanceBeat() {
    if (!S) return;
    if (VN.typing) { revealBeatAll(); return; }
    if (!VN.current) { showNextBeat(); return; }
    if (VN.autoTimer) clearTimeout(VN.autoTimer);
    VN.current = null;
    els.dnext.classList.remove("on");
    showNextBeat();
  }
  function setScene(key, mode) {
    if (!els.vnBg) return;
    var a = (C.assets || {})[key];
    var url = a ? resolveAsset(a) : "";
    if (url) els.vnBg.style.backgroundImage = 'url("' + url + '")';
    els.vnBg.classList.remove("night", "dawn");
    if (mode) els.vnBg.classList.add(mode);
    if (S) S.sceneCG = (key === "cg_enter1" || key === "cg_enter2" || key === "cg_tea");
    if (S && S.sceneCG && els.portrait) els.portrait.classList.remove("show", "dim");
  }
  function exprImage(who, expr) {
    if (!who || who === P) return "";
    var chars = PT.chars || {};
    var c = chars[who];
    if (c && c.exprs) {
      var f = c.exprs[expr] || c.exprs["默认"] || c.default;
      if (f) {
        var u = resolveAsset(f);
        if (u) return u;
      }
    }
    return cardImage(who);
  }
  function showPortraitForBeat(b) {
    if (!els.portrait) return;
    if (S && S.sceneCG) { els.portrait.classList.remove("show", "dim"); return; }
    var who = b.who;
    if (b.kind === "private") { els.portrait.classList.add("dim"); return; }
    if (b.kind === "narr" || b.kind === "sys" || b.kind === "reveal" || !who) {
      els.portrait.classList.remove("show", "dim");
      return;
    }
    if (who === P) { els.portrait.classList.add("dim"); return; }
    var url = exprImage(who, b.expr);
    if (!url) { els.portrait.classList.remove("show", "dim"); return; }
    els.portrait.innerHTML = '<img src="' + esc(url) + '" alt="' + esc(labelOf(who)) + '">';
    els.portrait.classList.remove("dim");
    els.portrait.classList.add("show");
  }

  function flashTalk(who, kind) {
    if (!els.cardEls || !els.cardEls[who]) return;
    var el = els.cardEls[who];
    el.classList.add("talk");
    clearTimeout(el._talkT);
    el._talkT = setTimeout(function () { el.classList.remove("talk"); }, isDebug() ? 400 : 2200);
  }
  function flashMood(who, expr) {
    var el = els.cardEls && els.cardEls[who];
    if (!el) return;
    var mood = el.querySelector("[data-mood]");
    var c = char(who);
    if (!mood) return;
    var sym = MOOD[expr] || "";
    if (sym) {
      mood.textContent = sym;
      clearTimeout(mood._t);
      mood._t = setTimeout(function () { mood.textContent = c.emoji || "🍵"; }, isDebug() ? 600 : 3200);
    }
  }
  var MOOD = {
    "眯眼笑": "😊", "不悦": "😠", "悲伤": "😢", "惊讶": "😮", "害羞": "😳",
    "疑惑": "🤔", "欲言又止": "😶", "低头落寞": "🥀", "默认": "😐", "温和": "🙂"
  };

  function showLines(g, lines, per) {
    if (!lines || !lines.length) return Promise.resolve();
    lines.forEach(function (L) {
      if (!L || !L.text) return;
      addLine(L.who, L.text, L.who === HOST ? "host" : "line",
        L.expr, L.stance, L.target, L.goal, L.facts, L.respond, L.voteIntent);
    });
    if (S === g) syncUI();
    return waitBeats(g);
  }

  /* ---- 头像 / 卡面 SVG（内置占位；作者给 PNG 后走 tea_cards.json 映射） ---- */
  var artSeq = 0;
  var HAIRS = {
    twin: {
      back: function (d) {
        return '<path d="M37 57Q15 77 21 118Q27 127 35 113Q33 89 45 72Z" fill="' + d + '"/>' +
               '<path d="M83 57Q105 77 99 118Q93 127 85 113Q87 89 75 72Z" fill="' + d + '"/>';
      },
      front: function (d) {
        return '<path d="M37 55Q46 38 60 39Q74 38 83 55Q74 44 60 46Q46 44 37 55Z" fill="' + d + '"/>' +
               '<path d="M36 55Q32 68 36 80L42 75Q38 65 43 58Z" fill="' + d + '"/>' +
               '<path d="M84 55Q88 68 84 80L78 75Q82 65 77 58Z" fill="' + d + '"/>';
      }
    },
    short: {
      back: function () { return ""; },
      front: function (d) {
        return '<path d="M36 56Q38 41 48 34L53 26L58 37L63 26L69 35Q82 41 84 56Q76 42 60 44Q44 42 36 56Z" fill="' + d + '"/>';
      }
    },
    topknot: {
      back: function () { return '<circle cx="60" cy="28" r="7" fill="#241a14"/>'; },
      front: function (d) {
        return '<path d="M38 54Q40 35 60 33Q80 35 82 54Q72 43 60 43Q48 43 38 54Z" fill="' + d + '"/>' +
               '<path d="M46 84Q60 103 74 84L74 89Q60 109 46 89Z" fill="' + d + '"/>';
      }
    },
    long: {
      back: function (d) {
        return '<path d="M34 55Q20 78 23 122L35 126Q32 90 46 70Z" fill="' + d + '"/>' +
               '<path d="M86 55Q100 78 97 122L85 126Q88 90 74 70Z" fill="' + d + '"/>';
      },
      front: function (d) {
        return '<path d="M37 54Q47 38 60 39Q73 38 83 54Q73 44 60 46Q47 44 37 54Z" fill="' + d + '"/>' +
               '<path d="M36 54Q32 72 38 88L44 82Q39 68 43 58Z" fill="' + d + '"/>' +
               '<path d="M84 54Q88 72 82 88L76 82Q81 68 77 58Z" fill="' + d + '"/>';
      }
    },
    ponytail: {
      back: function (d) {
        return '<path d="M80 50Q108 44 107 80Q105 103 90 102Q99 82 84 63Z" fill="' + d + '"/>' +
               '<path d="M78 52Q88 50 90 58Q84 62 78 58Z" fill="' + d + '"/>';
      },
      front: function (d) {
        return '<path d="M37 54Q47 38 60 39Q73 38 83 54Q73 44 60 46Q47 44 37 54Z" fill="' + d + '"/>' +
               '<path d="M83 54Q88 64 85 76L79 71Q83 62 78 57Z" fill="' + d + '"/>';
      }
    },
    bob: {
      back: function (d) {
        return '<path d="M35 58Q26 84 32 103Q44 112 50 99L48 70Z" fill="' + d + '"/>' +
               '<path d="M85 58Q94 84 88 103Q76 112 70 99L72 70Z" fill="' + d + '"/>';
      },
      front: function (d) {
        return '<path d="M37 54Q47 37 60 38Q73 37 83 54Q72 43 60 45Q48 43 37 54Z" fill="' + d + '"/>' +
               '<path d="M38 54Q34 68 38 82L44 78Q40 66 44 58Z" fill="' + d + '"/>' +
               '<path d="M82 54Q86 68 82 82L76 78Q80 66 76 58Z" fill="' + d + '"/>';
      }
    },
    ribbon: {
      back: function (d, m) {
        return '<path d="M34 55Q20 78 23 122L35 126Q32 90 46 70Z" fill="' + d + '"/>' +
               '<path d="M86 55Q100 78 97 122L85 126Q88 90 74 70Z" fill="' + d + '"/>';
      },
      front: function (d, m) {
        return '<path d="M37 54Q47 38 60 39Q73 38 83 54Q73 44 60 46Q47 44 37 54Z" fill="' + d + '"/>' +
               '<path d="M76 50L90 41L93 52L79 57Z" fill="' + m + '" opacity=".85"/>' +
               '<path d="M78 54L90 64L86 72L76 60Z" fill="' + m + '" opacity=".7"/>';
      }
    },
    hood: {
      back: function (d) {
        return '<path d="M30 78Q24 36 60 30Q96 36 90 78Q84 54 74 46Q60 56 46 46Q36 54 30 78Z" fill="' + d + '"/>';
      },
      front: function (d) {
        return '<path d="M32 70Q36 46 60 40Q84 46 88 70Q80 52 60 50Q40 52 32 70Z" fill="' + d + '"/>';
      }
    },
    moon: {
      back: function (d) {
        return '<path d="M34 55Q20 78 23 122L35 126Q32 90 46 70Z" fill="' + d + '"/>' +
               '<path d="M86 55Q100 78 97 122L85 126Q88 90 74 70Z" fill="' + d + '"/>' +
               '<path d="M92 24A13 13 0 1 0 104 47A11 11 0 1 1 92 24Z" fill="#c9a86a" opacity=".5"/>';
      },
      front: function (d) {
        return '<path d="M37 54Q47 38 60 39Q73 38 83 54Q73 44 60 46Q47 44 37 54Z" fill="' + d + '"/>' +
               '<path d="M84 54Q88 70 83 86L77 80Q81 66 77 58Z" fill="' + d + '"/>';
      }
    }
  };
  var MOTIFS = {
    twin: '<g transform="translate(12,14)" fill="none" stroke="#b98f5a" stroke-width="1" stroke-linecap="round" opacity=".9"><path d="M2 21Q10 14 21 9"/><circle cx="21" cy="7" r="2.4"/><circle cx="15" cy="11" r="1.9"/><circle cx="9" cy="16" r="1.6"/><circle cx="3" cy="20" r="1.2"/></g>',
    short: '<g transform="translate(13,14)" fill="none" stroke="#b98f5a" stroke-width="1" stroke-linecap="round" opacity=".9"><circle cx="10" cy="11" r="7"/><path d="M10 5v6l4 3"/><path d="M7 2h6"/></g>',
    topknot: '<g transform="translate(11,14)" fill="none" stroke="#b98f5a" stroke-width="1" stroke-linecap="round" opacity=".9"><path d="M3 8h14c0 8-3 12-7 12S3 16 3 8Z"/><path d="M8 2q2 3 0 5M13 2q-2 3 0 5"/></g>',
    long: '<g transform="translate(12,14)" fill="none" stroke="#b98f5a" stroke-width="1" stroke-linecap="round" opacity=".9"><ellipse cx="10" cy="7" rx="6.5" ry="6.5"/><path d="M10 13.5v8"/><path d="M7 21q3 2 6 0"/></g>',
    ponytail: '<g transform="translate(11,12)" fill="none" stroke="#b98f5a" stroke-width="1" stroke-linecap="round" opacity=".9"><path d="M11 21V9"/><path d="M11 16C6 14 4 10 6 6C10 7 11 10 11 13"/><path d="M11 16C16 14 18 10 16 6C12 7 11 10 11 13"/><path d="M11 9C8 7 6 4 7 2C10 3 11 5 11 7"/><path d="M11 9C14 7 16 4 15 2C12 3 11 5 11 7"/></g>',
    bob: '<g transform="translate(11,13)" fill="none" stroke="#b98f5a" stroke-width="1" stroke-linecap="round" opacity=".9"><rect x="3" y="3" width="15" height="18" rx="2"/><path d="M7 8h7M7 12h7M7 16h5"/></g>',
    ribbon: '<g transform="translate(11,13)" fill="none" stroke="#b98f5a" stroke-width="1" stroke-linecap="round" opacity=".9"><path d="M11 21V6"/><path d="M11 10C6 8 3 4 5 2C9 3 11 6 11 9"/><path d="M11 10C16 8 19 4 17 2C13 3 11 6 11 9"/><path d="M8 18q3-2 6 0"/></g>',
    hood: '<g transform="translate(11,12)" fill="none" stroke="#b98f5a" stroke-width="1" stroke-linecap="round" opacity=".9"><path d="M4 8h14c0 6-3 10-7 12C7 18 4 14 4 8Z"/><path d="M9 12q2 2 4 0"/><path d="M11 2v4"/></g>',
    moon: '<g transform="translate(10,12)" fill="none" stroke="#b98f5a" stroke-width="1" stroke-linecap="round" opacity=".9"><path d="M15 3A9 9 0 1 0 16 17A8 8 0 1 1 15 3Z"/><path d="M5 5l1.2 1.2M7 5l-1.2 1.2" stroke-width=".8"/></g>'
  };
  function corners() {
    return '<g fill="none" stroke="#c9a86a" stroke-opacity=".55" stroke-width="1">' +
      '<path d="M8 21V8h13"/><path d="M112 21V8H99"/>' +
      '<path d="M8 135v13h13"/><path d="M112 135v13H99"/></g>';
  }
  /* 玩家卡：不用通用剪影 —— 客人的意象：茶盏、半张狐面、金色月光。
     作者之后给 PNG 就在 tea_cards.json 里映射「玩家」，会自动覆盖这张 SVG。 */
  function playerArtSVG() {
    var id = "tp" + (++artSeq);
    return '<svg class="tea-art" viewBox="0 0 120 156" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
      '<defs>' +
      '<linearGradient id="' + id + 'bg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#fbf4e4"/><stop offset=".55" stop-color="#e8d6b6"/><stop offset="1" stop-color="#b99a6b"/></linearGradient>' +
      '<radialGradient id="' + id + 'm" cx="50%" cy="34%" r="48%">' +
      '<stop offset="0" stop-color="#fff6dc" stop-opacity=".95"/><stop offset="1" stop-color="#e7c987" stop-opacity="0"/></radialGradient>' +
      '<clipPath id="' + id + 'c"><rect width="120" height="156" rx="7"/></clipPath>' +
      '</defs>' +
      '<g clip-path="url(#' + id + 'c)">' +
      '<rect width="120" height="156" fill="url(#' + id + 'bg)"/>' +
      '<rect width="120" height="156" fill="url(#' + id + 'm)"/>' +
      '<circle cx="60" cy="48" r="30" fill="none" stroke="#c9a86a" stroke-opacity=".55" stroke-width="1"/>' +
      '<circle cx="60" cy="48" r="24" fill="#fff8e6" opacity=".55"/>' +
      /* 狐面：半张，浮在月亮前 */
      '<g transform="translate(60 48)" fill="none" stroke="#8a6436" stroke-width="1.2" stroke-linecap="round" opacity=".9">' +
      '<path d="M-17 -4C-15 -18 -6 -24 0 -24C6 -24 15 -18 17 -4C17 8 9 18 0 20C-9 18 -17 8 -17 -4Z" fill="#f7edd8" fill-opacity=".55"/>' +
      '<path d="M-13 -8l-3 -9M13 -8l3 -9"/>' +
      '<path d="M-8 0c2 2 5 2 7 0M8 0c-2 2 -5 2 -7 0"/>' +
      '<path d="M-5 8q5 3 10 0"/>' +
      '</g>' +
      /* 茶盏与热气 */
      '<g transform="translate(60 104)" fill="none" stroke="#6f5030" stroke-width="1.4" stroke-linecap="round" opacity=".9">' +
      '<path d="M-22 -2h44c0 12 -9 20 -22 20c-13 0 -22 -8 -22 -20Z" fill="#fdf7ea" fill-opacity=".9"/>' +
      '<path d="M22 2c7 0 8 8 1 10"/>' +
      '<path d="M-18 19h36" stroke-width="1"/>' +
      '<path d="M-6 -8c-4 -5 4 -7 0 -12M4 -8c-4 -5 4 -7 0 -12" stroke-opacity=".55" stroke-width="1"/>' +
      '</g>' +
      /* 肩膀剪影 */
      '<path d="M10 156C14 132 30 120 60 120C90 120 106 132 110 156Z" fill="#3e2f22" opacity=".92"/>' +
      '<path d="M10 156C14 132 30 120 60 120C90 120 106 132 110 156Z" fill="none" stroke="#c9a86a" stroke-opacity=".45"/>' +
      '<rect x="2.5" y="2.5" width="115" height="151" rx="7" fill="none" stroke="#c9a86a" stroke-opacity=".8" stroke-width="1.2"/>' +
      '<rect x="6.5" y="6.5" width="107" height="143" rx="5" fill="none" stroke="#c9a86a" stroke-opacity=".28" stroke-width=".6"/>' +
      corners() +
      '</g></svg>';
  }
  function artSVG(key) {
    if (key === P) return playerArtSVG();
    var meta = char(key);
    var id = "ta" + (++artSeq);
    var main = meta.color || "#c9a86a";
    var dark = meta.accent || "#5b4a34";
    var hair = HAIRS[meta.motif] || HAIRS.long;
    var motif = MOTIFS[meta.motif] || MOTIFS.long;
    return '<svg class="tea-art" viewBox="0 0 120 156" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
      '<defs>' +
      '<linearGradient id="' + id + 'bg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#fcf7ec"/><stop offset=".46" stop-color="' + main + '" stop-opacity=".30"/>' +
      '<stop offset="1" stop-color="' + dark + '" stop-opacity=".56"/></linearGradient>' +
      '<radialGradient id="' + id + 'g" cx="50%" cy="36%" r="62%">' +
      '<stop offset="0" stop-color="#fff8e6" stop-opacity=".92"/><stop offset=".52" stop-color="' + main + '" stop-opacity=".38"/>' +
      '<stop offset="1" stop-color="' + main + '" stop-opacity="0"/></radialGradient>' +
      '<pattern id="' + id + 'w" width="24" height="12" patternUnits="userSpaceOnUse">' +
      '<path d="M0 12A12 12 0 0 1 24 12" fill="none" stroke="' + dark + '" stroke-opacity=".18" stroke-width=".8"/>' +
      '<path d="M-12 12A12 12 0 0 1 12 12" fill="none" stroke="' + dark + '" stroke-opacity=".11" stroke-width=".8"/>' +
      '<path d="M12 12A12 12 0 0 1 36 12" fill="none" stroke="' + dark + '" stroke-opacity=".11" stroke-width=".8"/></pattern>' +
      '<clipPath id="' + id + 'c"><rect width="120" height="156" rx="7"/></clipPath>' +
      '</defs>' +
      '<g clip-path="url(#' + id + 'c)">' +
      '<rect width="120" height="156" fill="url(#' + id + 'bg)"/>' +
      '<rect width="120" height="156" fill="url(#' + id + 'w)"/>' +
      '<ellipse cx="60" cy="60" rx="50" ry="55" fill="url(#' + id + 'g)"/>' +
      '<circle cx="60" cy="54" r="37" fill="none" stroke="' + main + '" stroke-opacity=".34" stroke-width=".8"/>' +
      hair.back(dark, main) +
      '<path d="M17 156C19 124 36 110 60 110C84 110 101 124 103 156Z" fill="' + dark + '"/>' +
      '<path d="M17 156C19 124 36 110 60 110C84 110 101 124 103 156Z" fill="none" stroke="rgba(255,248,230,.26)" stroke-width=".8"/>' +
      '<path d="M38 114C46 128 53 141 60 150C67 141 74 128 82 114" fill="none" stroke="' + main + '" stroke-opacity=".55" stroke-width="4"/>' +
      '<rect x="46" y="127" width="28" height="4.5" rx="2.2" fill="' + main + '" opacity=".5"/>' +
      '<rect x="53" y="87" width="14" height="19" rx="6" fill="' + dark + '"/>' +
      '<ellipse cx="60" cy="67" rx="22" ry="25" fill="' + dark + '"/>' +
      '<ellipse cx="60" cy="67" rx="22" ry="25" fill="none" stroke="rgba(255,248,230,.2)" stroke-width=".7"/>' +
      '<path d="M48 112C52 127 56 136 60 146C64 136 68 127 72 112" fill="none" stroke="rgba(255,248,230,.32)" stroke-width="1"/>' +
      hair.front(dark, main) +
      motif +
      '<rect x="2.5" y="2.5" width="115" height="151" rx="7" fill="none" stroke="#c9a86a" stroke-opacity=".8" stroke-width="1.2"/>' +
      '<rect x="6.5" y="6.5" width="107" height="143" rx="5" fill="none" stroke="#c9a86a" stroke-opacity=".28" stroke-width=".6"/>' +
      corners() +
      '</g></svg>';
  }

  /* ============================================================
     六、DOM 构建 + 样式（全屏浮层，不动 UI还原/ 原文件）
     ============================================================ */
  var CSS = `
#tea-ai-root{position:fixed;inset:0;z-index:2000000;overflow:hidden;color:#f7f3ee;background:#120d0a;font-family:"FZXiaoBiaoSong-B05S","方正小标宋简体","Noto Serif SC","Songti SC",serif;-webkit-font-smoothing:antialiased;user-select:none}
#tea-ai-root .tea-shell{position:absolute;inset:0;overflow:hidden}
/* ---- 背景（茶室/CG），夜相压暗 ---- */
#tea-ai-root .tea-vn-bg{position:absolute;inset:0;background-size:cover;background-position:50% 50%;background-repeat:no-repeat;background-color:#1a120c;transition:opacity .5s ease,filter .6s ease;z-index:0}
#tea-ai-root .tea-vn-bg.night{filter:brightness(.5) saturate(.75) blur(.4px)}
#tea-ai-root .tea-vn-bg.dawn{filter:brightness(.78) saturate(.9)}
#tea-ai-root .tea-vn-shade{position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(180deg,rgba(10,7,5,.62) 0%,rgba(10,7,5,.08) 30%,rgba(10,7,5,.12) 58%,rgba(10,7,5,.78) 100%)}
/* ---- 顶栏 ---- */
#tea-ai-root .tea-head{position:absolute;left:0;right:0;top:0;z-index:7;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:clamp(8px,1.4vh,18px) clamp(12px,2.4vw,34px);background:linear-gradient(180deg,rgba(18,13,9,.88),rgba(18,13,9,.35) 70%,transparent);pointer-events:none}
#tea-ai-root .tea-head > *{pointer-events:auto}
#tea-ai-root .tea-brand{display:flex;align-items:center;gap:10px;min-width:0}
#tea-ai-root .tea-hostface{width:clamp(28px,3vw,46px);height:clamp(28px,3vw,46px);border-radius:50%;overflow:hidden;border:1px solid rgba(201,168,106,.65);box-shadow:0 0 14px rgba(201,168,106,.28);flex:0 0 auto;background:#2a1d14}
#tea-ai-root .tea-hostface svg,#tea-ai-root .tea-hostface img{width:100%;height:100%;display:block;object-fit:cover}
#tea-ai-root .tea-title{font-size:clamp(16px,1.9vw,28px);letter-spacing:clamp(2px,.35vw,7px);white-space:nowrap;color:#f3e6c9;text-shadow:0 2px 12px rgba(0,0,0,.85);line-height:1.1}
#tea-ai-root .tea-title b{color:#e7c37a;font-weight:400}
#tea-ai-root .tea-sub{font-size:clamp(10px,.92vw,14px);color:rgba(247,243,238,.72);letter-spacing:2px;margin-top:2px;white-space:nowrap;text-shadow:0 1px 6px rgba(0,0,0,.9)}
#tea-ai-root .tea-sub b{color:#ffdf9e;font-weight:400}
#tea-ai-root .tea-tools{display:flex;gap:7px;align-items:center;flex:0 0 auto}
#tea-ai-root .tea-chip{font-size:clamp(9px,.82vw,12px);letter-spacing:1px;color:#f0d9a8;background:rgba(24,17,11,.62);border:1px solid rgba(201,168,106,.38);border-radius:999px;padding:3px 10px;white-space:nowrap}
#tea-ai-root .tea-rolechip{color:#ffe3a8;border-color:rgba(201,168,106,.6);background:rgba(52,37,20,.72)}
/* ---- 立绘 ---- */
#tea-ai-root .tea-portrait{position:absolute;left:50%;bottom:clamp(148px,25vh,270px);transform:translateX(-50%) translateY(10px);height:min(66vh,680px);z-index:3;pointer-events:none;opacity:0;transition:opacity .35s ease,transform .35s ease;filter:drop-shadow(0 18px 38px rgba(0,0,0,.65))}
#tea-ai-root .tea-portrait.show{opacity:1;transform:translateX(-50%) translateY(0)}
#tea-ai-root .tea-portrait.dim{opacity:.45;filter:brightness(.7) drop-shadow(0 18px 38px rgba(0,0,0,.65))}
#tea-ai-root .tea-portrait img{display:block;height:100%;width:auto;max-width:min(72vw,760px);object-fit:contain}
#tea-ai-root .tea-portrait .vn-ph{display:flex;align-items:center;justify-content:center;width:min(40vw,300px);height:100%;color:rgba(240,217,168,.5);font-size:clamp(14px,1.4vw,22px);letter-spacing:4px;border:1px dashed rgba(201,168,106,.3);border-radius:18px;background:rgba(20,14,10,.28)}
/* ---- 羊皮纸对话框 ---- */
#tea-ai-root .tea-dbox{position:absolute;left:50%;bottom:clamp(48px,7.4vh,82px);transform:translateX(-50%);width:min(1420px,calc(100% - 20px));min-height:clamp(98px,21vh,206px);z-index:6;background:linear-gradient(180deg,rgba(249,246,242,.985) 0%,rgba(240,231,214,.985) 62%,rgba(232,219,196,.985) 100%);border:2px solid #c9a86a;border-radius:16px;box-shadow:0 16px 50px rgba(0,0,0,.55),inset 0 0 0 5px rgba(201,168,106,.16),inset 0 0 60px rgba(201,168,106,.10);padding:clamp(14px,2.1vh,24px) clamp(18px,3vw,42px) clamp(18px,2.6vh,30px);cursor:pointer}
#tea-ai-root .tea-dbox::before{content:"";position:absolute;left:10px;right:10px;top:10px;bottom:10px;border:1px solid rgba(201,168,106,.32);border-radius:11px;pointer-events:none}
#tea-ai-root .tea-name{position:absolute;top:calc(-1 * clamp(12px,1.7vh,20px));left:clamp(18px,3vw,42px);background:linear-gradient(180deg,#f6ecd8 0%,#e6d3ae 100%);color:#413126;border:1px solid rgba(138,106,66,.55);border-radius:9px;padding:clamp(5px,0.7vh,9px) clamp(13px,1.8vw,24px);font-size:clamp(14px,1.35vw,22px);letter-spacing:3px;box-shadow:0 4px 12px rgba(0,0,0,.45);white-space:nowrap}
#tea-ai-root .tea-name.you{background:linear-gradient(180deg,#e9f2f7,#cfe0ea);color:#2e4353;border-color:rgba(92,124,146,.6)}
#tea-ai-root .tea-name.private{background:linear-gradient(180deg,#f7ecd6,#e8d3a8);color:#6d4b1f;border-color:rgba(201,168,106,.7)}
#tea-ai-root .tea-name.narr{background:linear-gradient(180deg,#e8e2d6,#d6cbb8);color:#5a5142;border-color:rgba(138,120,96,.5)}
#tea-ai-root .tea-dtext{font-size:clamp(15px,1.5vw,25px);line-height:1.75;color:#33261a;letter-spacing:1.5px;min-height:2.7em;white-space:pre-wrap;word-break:break-word;text-align:left;padding-top:4px}
#tea-ai-root .tea-dtext.private{color:#7a561f}
#tea-ai-root .tea-dtext.narr{color:#5e5445;font-size:clamp(14px,1.35vw,22px)}
#tea-ai-root .tea-dnext{position:absolute;right:clamp(14px,2vw,26px);bottom:6px;color:#a8844b;font-size:clamp(14px,1.4vw,22px);animation:tea-bounce 1.1s ease-in-out infinite;opacity:0}
#tea-ai-root .tea-dnext.on{opacity:1}
@keyframes tea-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(4px)}}
/* ---- 状态/提示 ---- */
#tea-ai-root .tea-status{position:absolute;left:50%;top:clamp(48px,7.4vh,84px);transform:translateX(-50%);z-index:6;font-size:clamp(10px,.95vw,15px);letter-spacing:2px;color:#f0d9a8;text-shadow:0 2px 10px rgba(0,0,0,.9);white-space:nowrap;max-width:92%;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
#tea-ai-root .tea-status.loading::after{content:"…";animation:tea-dots 1.1s steps(4,end) infinite}
@keyframes tea-dots{0%,100%{opacity:.25}50%{opacity:1}}
/* ---- 底部输入/按钮 ---- */
#tea-ai-root .tea-inputbar{position:absolute;left:50%;bottom:clamp(5px,1vh,12px);transform:translateX(-50%);width:min(1420px,calc(100% - 20px));display:flex;gap:7px;align-items:stretch;z-index:8}
#tea-ai-root .tea-input{flex:1 1 auto;min-width:0;background:rgba(18,13,9,.78);border:1px solid rgba(201,168,106,.45);border-radius:9px;color:#f7f3ee;font-family:inherit;font-size:clamp(11px,1.05vw,16px);padding:0 13px;height:clamp(28px,3.8vh,40px);outline:none;letter-spacing:1px;user-select:text;box-shadow:0 3px 14px rgba(0,0,0,.4)}
#tea-ai-root .tea-input:focus{border-color:#ffdc9e;box-shadow:0 0 0 1px rgba(255,220,158,.25),0 0 16px rgba(255,205,120,.18)}
#tea-ai-root .tea-input::placeholder{color:rgba(247,243,238,.36)}
#tea-ai-root .tea-btn{font-family:inherit;cursor:pointer;border-radius:9px;border:1px solid rgba(201,168,106,.55);background:linear-gradient(180deg,rgba(80,59,34,.96),rgba(48,33,18,.96));color:#f2e6cd;letter-spacing:2px;height:clamp(28px,3.8vh,40px);padding:0 clamp(10px,1.2vw,20px);font-size:clamp(10px,1vw,16px);transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease,opacity .12s ease;white-space:nowrap;user-select:none;box-shadow:0 3px 12px rgba(0,0,0,.35)}
#tea-ai-root .tea-btn:hover:not(:disabled){border-color:#ffdc9e;box-shadow:0 0 14px rgba(255,205,120,.3);transform:translateY(-1px)}
#tea-ai-root .tea-btn:active:not(:disabled){transform:translateY(0)}
#tea-ai-root .tea-btn:disabled{opacity:.4;cursor:default}
#tea-ai-root .tea-btn.primary{background:linear-gradient(180deg,#d8b46e,#9d7a3f);color:#2c1e11;border-color:#f0d9a4;box-shadow:0 0 18px rgba(255,205,120,.22)}
#tea-ai-root .tea-btn.ghost{background:rgba(20,14,10,.62);color:#e8d9bc}
#tea-ai-root .tea-btn.mini{height:auto;padding:5px 12px;font-size:clamp(9px,.85vw,13px);letter-spacing:1.5px}
/* ---- 席位小头像条（投票/选人时出现） ---- */
#tea-ai-root .tea-cards{position:absolute;left:50%;bottom:calc(clamp(48px,7.4vh,82px) + clamp(98px,21vh,206px) + 16px);transform:translateX(-50%);z-index:6;display:none;gap:clamp(4px,.6vw,10px);max-width:calc(100% - 20px);padding:7px 10px;background:rgba(16,11,8,.72);border:1px solid rgba(201,168,106,.4);border-radius:13px;box-shadow:0 10px 30px rgba(0,0,0,.5);backdrop-filter:blur(3px);overflow-x:auto}
#tea-ai-root .tea-cards.show{display:flex}
#tea-ai-root .tea-card{position:relative;width:clamp(52px,5.4vw,82px);flex:0 0 auto;display:flex;flex-direction:column;overflow:hidden;border-radius:8px;border:1.5px solid rgba(201,168,106,.85);background:linear-gradient(180deg,#f9f4e8,#e5d5b8);box-shadow:0 4px 12px rgba(0,0,0,.45);transition:transform .15s ease,box-shadow .15s ease,filter .2s ease;min-width:0}
#tea-ai-root .tea-card .tc-art{position:relative;width:100%;aspect-ratio:1/1;overflow:hidden;background:#e8dcc4}
#tea-ai-root .tea-card .tc-art svg,#tea-ai-root .tea-card .tc-art img{display:block;width:100%;height:100%;object-fit:cover}
#tea-ai-root .tea-card .tc-name{font-size:clamp(9px,.8vw,12px);letter-spacing:1px;text-align:center;color:#3e2f22;padding-top:2px;white-space:nowrap}
#tea-ai-root .tea-card .tc-trait{display:none}
#tea-ai-root .tea-card .tc-badge{align-self:center;margin:1px 0 3px;font-size:clamp(7px,.6vw,9px);letter-spacing:.5px;color:#f3e7cc;background:linear-gradient(180deg,#7a6339,#584425);border:1px solid rgba(201,168,106,.6);border-radius:999px;padding:0 5px;white-space:nowrap;max-width:96%;overflow:hidden;text-overflow:ellipsis}
#tea-ai-root .tea-card.you .tc-badge{background:linear-gradient(180deg,#4f6a7e,#33495a)}
#tea-ai-root .tea-card.dead{filter:saturate(.3) brightness(.65)}
#tea-ai-root .tea-card.dead .tc-badge{background:#4a3a2c;color:#cbb99e}
#tea-ai-root .tea-card.out .tc-badge{background:#6d2f2a;color:#ffd9cf}
#tea-ai-root .tea-card.talk{transform:translateY(-3px);box-shadow:0 0 0 1.5px #ffd98c,0 0 18px rgba(255,205,120,.5)}
#tea-ai-root .tea-card.pickable{cursor:pointer;animation:tea-pick 1.4s ease-in-out infinite}
@keyframes tea-pick{0%,100%{box-shadow:0 0 0 1px rgba(255,216,150,.35),0 4px 12px rgba(0,0,0,.45)}50%{box-shadow:0 0 0 2px #ffd98c,0 0 22px rgba(255,205,120,.65),0 4px 12px rgba(0,0,0,.45)}}
#tea-ai-root .tea-card.pickable:hover{animation:none;transform:translateY(-4px);box-shadow:0 0 0 2px #ffe7b0,0 0 24px rgba(255,215,140,.8)}
#tea-ai-root .tc-mood{display:none}
/* ---- 玩家选择按钮 ---- */
#tea-ai-root .tea-choicebar{position:absolute;left:50%;bottom:calc(clamp(5px,1vh,12px) + clamp(28px,3.8vh,40px) + 8px);transform:translateX(-50%);z-index:8;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:calc(100% - 24px)}
#tea-ai-root .tea-choicebar.hidden{display:none}
/* ---- 规则弹窗 ---- */
#tea-ai-root .tea-mask{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(10,7,5,.76);backdrop-filter:blur(3px)}
#tea-ai-root .tea-mask.hidden{display:none}
#tea-ai-root .tea-rulecard{width:min(760px,100%);max-height:92%;overflow:auto;background:linear-gradient(180deg,#f9f4e8,#e9dbc0);color:#3e2f22;border:1.5px solid #c9a86a;border-radius:16px;padding:clamp(14px,2.6vw,32px);box-shadow:0 20px 60px rgba(0,0,0,.6),inset 0 0 0 4px rgba(201,168,106,.2);user-select:text}
#tea-ai-root .tea-rulecard h3{font-size:clamp(20px,2.4vw,30px);letter-spacing:5px;text-align:center;font-weight:400;color:#3e2f22;margin-bottom:10px}
#tea-ai-root .tea-rulecard p{font-size:clamp(11px,1.05vw,15px);line-height:1.8;letter-spacing:1px;color:#5a4632;margin:5px 0}
#tea-ai-root .tea-rulecard b{color:#8a5d27;font-weight:400}
#tea-ai-root .tea-rulecard .tea-rulefoot{display:flex;justify-content:center;margin-top:16px}
/* ---- 结局面板 ---- */
#tea-ai-root .tea-endmask{position:absolute;inset:0;z-index:22;display:flex;align-items:center;justify-content:center;padding:16px;background:radial-gradient(circle at 50% 62%,rgba(255,226,170,.14),rgba(8,5,4,.82) 68%)}
#tea-ai-root .tea-endmask.hidden{display:none}
#tea-ai-root .tea-endcard{position:relative;width:min(640px,100%);max-height:94%;overflow:auto;text-align:center;padding:clamp(16px,2.6vw,34px) clamp(16px,3vw,44px);background:linear-gradient(180deg,rgba(249,244,232,.985),rgba(233,219,192,.985));border:1.5px solid #c9a86a;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.65),inset 0 0 0 5px rgba(201,168,106,.18),inset 0 0 60px rgba(201,168,106,.15);color:#3e2f22;animation:tea-endin .45s ease-out}
@keyframes tea-endin{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
#tea-ai-root .tea-endcard.lighted{box-shadow:0 24px 70px rgba(0,0,0,.65),inset 0 0 0 5px rgba(201,168,106,.28),0 0 90px rgba(255,214,140,.35)}
#tea-ai-root .tea-endcard .tea-end-kicker{font-size:clamp(10px,.9vw,13px);letter-spacing:6px;color:#8a6b3c}
#tea-ai-root .tea-endcard h2{font-size:clamp(21px,2.7vw,36px);letter-spacing:6px;font-weight:400;margin:6px 0 4px;color:#33261a}
#tea-ai-root .tea-endcard .tea-end-sub{font-size:clamp(10px,.92vw,13px);letter-spacing:2px;color:#79603f}
#tea-ai-root .tea-endcard .tea-end-ident{margin-top:10px;font-size:clamp(11px,1.02vw,15px);letter-spacing:2px;color:#5a4632}
#tea-ai-root .tea-endcard .tea-end-tea{font-size:clamp(11px,1.02vw,15px);letter-spacing:1.5px;color:#5a4632;margin-top:4px}
#tea-ai-root .tea-endcard .tea-end-lamp{margin-top:8px;font-size:clamp(10px,.95vw,14px);letter-spacing:3px;color:#a67c32}
#tea-ai-root .tea-endcard .tea-end-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px}
#tea-ai-root .tea-endcard .tea-endglow{position:absolute;inset:-20%;pointer-events:none;background:radial-gradient(circle at 50% 50%,rgba(255,226,170,.5),transparent 58%);opacity:0;transition:opacity .8s ease}
#tea-ai-root .tea-endcard.lighted .tea-endglow{opacity:1;animation:tea-glow 2.6s ease-in-out infinite}
@keyframes tea-glow{0%,100%{opacity:.25}50%{opacity:.75}}
#tea-ai-root .tea-log{display:none}
#tea-ai-root .tea-toastline{display:none}
@media (max-height:620px){
 #tea-ai-root .tea-head{padding:5px 10px}
 #tea-ai-root .tea-title{font-size:15px;letter-spacing:2.5px}
 #tea-ai-root .tea-sub{font-size:9px;letter-spacing:1.2px;margin-top:1px}
 #tea-ai-root .tea-hostface{width:24px;height:24px}
 #tea-ai-root .tea-chip{display:none}
 #tea-ai-root .tea-rolechip{display:inline-block;font-size:9px;padding:2px 7px}
 #tea-ai-root .tea-btn.mini{height:auto;padding:3px 8px;font-size:9.5px}
 #tea-ai-root .tea-status{top:32px;font-size:10px}
 #tea-ai-root .tea-portrait{bottom:122px;height:44vh;max-height:210px}
 #tea-ai-root .tea-dbox{bottom:36px;min-height:92px;padding:10px 14px 14px;border-width:1.5px}
 #tea-ai-root .tea-name{top:-11px;left:14px;padding:3px 10px;font-size:12px;letter-spacing:2px}
 #tea-ai-root .tea-dtext{font-size:13px;line-height:1.6;letter-spacing:1px;min-height:2.6em}
 #tea-ai-root .tea-inputbar{bottom:4px;gap:5px}
 #tea-ai-root .tea-input,#tea-ai-root .tea-btn{height:27px;font-size:10.5px;padding:0 8px}
 #tea-ai-root .tea-cards{bottom:calc(36px + 92px + 10px);gap:4px;padding:5px 7px}
 #tea-ai-root .tea-card{width:44px}
 #tea-ai-root .tea-card .tc-name{font-size:8px}
 #tea-ai-root .tea-card .tc-badge{font-size:6.5px;padding:0 4px}
 #tea-ai-root .tea-choicebar{bottom:calc(4px + 27px + 6px);gap:5px}
 #tea-ai-root .tea-rulecard{padding:12px 16px}
 #tea-ai-root .tea-rulecard h3{font-size:18px;margin-bottom:5px}
 #tea-ai-root .tea-rulecard p{font-size:10px;line-height:1.55;margin:2px 0}
 #tea-ai-root .tea-endcard{padding:14px 18px}
 #tea-ai-root .tea-endcard h2{font-size:21px;margin:2px 0}
}
@media (max-width:560px){
 #tea-ai-root .tea-title{font-size:13px}
 #tea-ai-root .tea-sub{font-size:8.5px}
 #tea-ai-root .tea-input{font-size:10px}
}
@media (prefers-reduced-motion:reduce){
 #tea-ai-root .tea-card.pickable,#tea-ai-root .tea-dnext{animation:none}
 #tea-ai-root .tea-endcard{animation:none}
}
`;

  function ensureStyle() {
    if (document.getElementById("tea-ai-style")) return;
    var st = document.createElement("style");
    st.id = "tea-ai-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function cardHTML(key) {
    var c = char(key);
    var img = cardImage(key);
    var art = img
      ? '<img src="' + esc(img) + '" alt="' + esc(c.name || key) + '">'
      : artSVG(key);
    return '<article class="tea-card' + (key === P ? " you" : "") + '" data-who="' + esc(key) + '">' +
      '<div class="tc-art">' + art + '<span class="tc-mood" data-mood>' + esc(c.emoji || "🍵") + '</span></div>' +
      '<div class="tc-name">' + esc(c.label || key) + '</div>' +
      '<div class="tc-trait">' + esc(c.tagline || "") + '</div>' +
      '<div class="tc-badge" data-badge>在场</div></article>';
  }

  function buildOverlay() {
    if (root) return true;
    ensureStyle();
    root = document.createElement("div");
    root.id = "tea-ai-root";
    root.className = "tea-ai";
    root.innerHTML =
      '<div class="tea-shell"><div class="tea-vn">' +
        '<div class="tea-vn-bg" id="tea-vn-bg"></div>' +
        '<div class="tea-vn-shade"></div>' +
        '<header class="tea-head">' +
          '<div class="tea-brand"><div class="tea-hostface" id="tea-hostface"></div>' +
            '<div class="tea-titlebox"><div class="tea-title">月见茶会 · <b>AI 夜</b></div>' +
            '<div class="tea-sub">第 <b id="tea-day">1</b> 天 · <span id="tea-phase">开场</span></div></div></div>' +
          '<div class="tea-tools">' +
            '<span class="tea-chip tea-rolechip" id="tea-player-role">你的身份 · 村民</span>' +
            '<span class="tea-chip" id="tea-calls" style="display:none">AI 0</span>' +
            '<button type="button" class="tea-btn mini ghost" id="tea-seats">席位</button>' +
            '<button type="button" class="tea-btn mini ghost" id="tea-skip" style="display:none">快进</button>' +
            '<button type="button" class="tea-btn mini ghost" id="tea-rules">规则</button>' +
            '<button type="button" class="tea-btn mini ghost" id="tea-exit">退出</button></div>' +
        '</header>' +
        '<div class="tea-status" id="tea-status"></div>' +
        '<div class="tea-portrait" id="tea-portrait"></div>' +
        '<section class="tea-cards" id="tea-cards" style="--tea-cols:' + SEATS.length + '"></section>' +
        '<div class="tea-dbox" id="tea-dbox">' +
          '<div class="tea-name" id="tea-name">月 见</div>' +
          '<div class="tea-dtext" id="tea-dtext"></div>' +
          '<div class="tea-dnext" id="tea-dnext">▽</div>' +
        '</div>' +
        '<div class="tea-choicebar hidden" id="tea-choicebar"></div>' +
        '<div class="tea-inputbar">' +
          '<input id="tea-input" class="tea-input" type="text" maxlength="120" autocomplete="off" ' +
            'placeholder="说点什么……（回车发送）">' +
          '<button type="button" class="tea-btn" id="tea-send">说</button>' +
          '<button type="button" class="tea-btn primary" id="tea-continue">开始第一夜 ▶</button>' +
        '</div>' +
      '</div></div>' +
      '<div class="tea-mask hidden" id="tea-rulemask"><div class="tea-rulecard">' +
        '<h3>茶 礼 制 式</h3>' +
        '<p>· 八席：<b>三狼（其中一狼王）、预言家、女巫、猎人、两位村民</b>；玩家固定为<b>村民</b>，其余 7 个身份随机给 NPC，人物关系与性格不变。</p>' +
        '<p>· 你的身份显示在自己屏幕上；NPC 的身份始终保密。被放逐/离席的人不公开身份。</p>' +
        '<p>· <b>夜</b>：狼选刀；预言家验一人；女巫有解药/毒药各一瓶（一晚只用一瓶，解药只救狼刀，毒药第 2 夜起可用）。</p>' +
        '<p>· <b>死亡技能</b>：狼王被刀/被放逐时带一人；猎人被刀/被放逐时开枪；<b>被毒死的猎人不能开枪</b>。</p>' +
        '<p>· <b>昼</b>：众人发言，你可以随时输入；然后举盏投票，票多者离席。</p>' +
        '<p>· <b>胜负</b>：狼全出局＝好人胜；狼数 ≥ 好人数＝狼胜；最多 <b>' + maxDays() +
          ' 天</b>，仍分不出胜负由月见裁。</p>' +
        '<p>· 对话按「点击 / 空格 / 回车」推进；断网时茶会会用自己的记忆把这一局走完。</p>' +
        '<div class="tea-rulefoot"><button type="button" class="tea-btn primary" id="tea-ruleclose">知道了</button></div>' +
      '</div></div>' +
      '<div class="tea-endmask hidden" id="tea-endmask"></div>' +
      '<div class="tea-toastline" id="tea-toastline"></div>' +
      '<div class="tea-log" id="tea-log"></div>';
    document.body.appendChild(root);

    els = {
      shell: root.querySelector(".tea-shell"),
      hostface: root.querySelector("#tea-hostface"),
      day: root.querySelector("#tea-day"),
      phase: root.querySelector("#tea-phase"),
      calls: root.querySelector("#tea-calls"),
      roleChip: root.querySelector("#tea-player-role"),
      vnBg: root.querySelector("#tea-vn-bg"),
      portrait: root.querySelector("#tea-portrait"),
      cards: root.querySelector("#tea-cards"),
      dbox: root.querySelector("#tea-dbox"),
      dname: root.querySelector("#tea-name"),
      dtext: root.querySelector("#tea-dtext"),
      dnext: root.querySelector("#tea-dnext"),
      log: root.querySelector("#tea-log"),
      status: root.querySelector("#tea-status"),
      input: root.querySelector("#tea-input"),
      send: root.querySelector("#tea-send"),
      skip: root.querySelector("#tea-skip"),
      seatsBtn: root.querySelector("#tea-seats"),
      cont: root.querySelector("#tea-continue"),
      rulesBtn: root.querySelector("#tea-rules"),
      exitBtn: root.querySelector("#tea-exit"),
      rulemask: root.querySelector("#tea-rulemask"),
      ruleclose: root.querySelector("#tea-ruleclose"),
      endmask: root.querySelector("#tea-endmask"),
      toastline: root.querySelector("#tea-toastline"),
      choicebar: root.querySelector("#tea-choicebar"),
      cardEls: {}
    };
    var hostImg = cardImage(HOST);
    els.hostface.innerHTML = hostImg ? '<img src="' + esc(hostImg) + '" alt="' + esc(HOST) + '">' : artSVG(HOST);
    els.cards.innerHTML = SEATS.map(cardHTML).join("");
    SEATS.forEach(function (k) {
      els.cardEls[k] = els.cards.querySelector('[data-who="' + k + '"]');
    });

    /* 事件 */
    els.cont.addEventListener("click", function (e) { e.stopPropagation(); onContinue(); });
    els.send.addEventListener("click", function (e) { e.stopPropagation(); onSend(); });
    els.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); onSend(); }
    });
    els.dbox.addEventListener("click", function (e) { e.stopPropagation(); advanceBeat(); });
    els.skip.addEventListener("click", function (e) {
      e.stopPropagation();
      if (VN.typing) revealBeatAll();
      VN.skipFast = true;
      advanceBeat();
    });
    els.seatsBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!S) return;
      S.stripShown = !S.stripShown;
      syncUI();
    });
    els.rulesBtn.addEventListener("click", function (e) { e.stopPropagation(); els.rulemask.classList.remove("hidden"); });
    els.ruleclose.addEventListener("click", function (e) { e.stopPropagation(); els.rulemask.classList.add("hidden"); });
    els.rulemask.addEventListener("click", function (e) {
      if (e.target === els.rulemask) els.rulemask.classList.add("hidden");
    });
    els.exitBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      stop();
      toast("茶会先散了。");
    });
    els.cards.addEventListener("click", function (e) {
      e.stopPropagation();
      var card = e.target.closest ? e.target.closest(".tea-card") : null;
      if (card) onCardPick(card.getAttribute("data-who"));
    });
    els.choicebar.addEventListener("click", function (e) {
      e.stopPropagation();
      var b = e.target.closest ? e.target.closest("[data-choice]") : null;
      if (!b) return;
      if (S && S.choice) S.choice.answer({ type: "option", value: b.getAttribute("data-choice") });
    });
    root.addEventListener("click", function (e) {
      if (e.target.closest && (e.target.closest(".tea-card") || e.target.closest("button") ||
          e.target.closest("input") || e.target.closest(".tea-endmask") || e.target.closest(".tea-mask"))) return;
      advanceBeat();
    });
    document.addEventListener("keydown", function (e) {
      if (!root || !S) return;
      if (e.key !== " " && e.key !== "Enter") return;
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      advanceBeat();
    });
    return true;
  }

  /* ============================================================
     七、UI 同步
     ============================================================ */
  /* ---------- 玩家夜间/技能选择（Promise，超时走默认） ---------- */
  function renderChoicebar(spec) {
    if (!els.choicebar) return;
    var html = "";
    (spec.options || []).forEach(function (o) {
      html += '<button type="button" class="tea-btn ' + (o.cls || "") + '" data-choice="' +
        esc(String(o.value)) + '">' + esc(o.label) + "</button>";
    });
    if (spec.cardPick) {
      html += '<button type="button" class="tea-btn ghost" data-choice="__skip__">' +
        esc(spec.skipLabel || "跳过（交给月见）") + "</button>";
    }
    els.choicebar.innerHTML = html;
    els.choicebar.classList.remove("hidden");
  }
  function clearChoicebar() {
    if (!els.choicebar) return;
    els.choicebar.innerHTML = "";
    els.choicebar.classList.add("hidden");
  }
  function askChoice(g, spec) {
    spec = spec || {};
    return new Promise(function (resolve) {
      if (!S || S !== g) return resolve({ type: "option", value: spec.defaultValue });
      var done = false, timer = null;
      function finish(v) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        g.choice = null;
        clearChoicebar();
        if (v === undefined || v === null) v = { type: "option", value: spec.defaultValue };
        resolve(v);
      }
      g.choice = {
        spec: spec, allow: spec.allow || null, answer: finish,
        phase: spec.phase, hint: spec.hint
      };
      g.phase = spec.phase;
      g.busy = false;
      renderChoicebar(spec);
      syncUI();
      timer = setTimeout(function () {
        finish({ type: "option", value: spec.defaultValue, timeout: true });
      }, actionTimeout());
    });
  }
  function choiceTarget(result) {
    if (!result) return null;
    return result.type === "target" ? result.who : null;
  }

  function phaseLabel() {
    if (!S) return "开场";
    return ({
      open: "开场",
      night: "夜",
      night_wolf: "夜 · 选刀",
      night_seer: "夜 · 查验",
      night_witch: "夜 · 女巫",
      night_shot: "离席 · 开枪",
      day: S.spoke ? "昼 · 讨论" : "昼 · 发言",
      vote: "举盏 · 投票",
      result: "揭晓",
      ending: "结局"
    })[S.phase] || S.phase;
  }
  function renderHeader() {
    if (!S) return;
    els.day.textContent = String(S.day);
    els.phase.textContent = phaseLabel();
    els.calls.textContent = "AI " + api.calls;
    if (window.MOMO_TEA_DEBUG && els.calls) els.calls.style.display = "";
    if (els.roleChip) els.roleChip.textContent = "你的身份 · " + roleLabel(S.roles[P]);
  }
  function renderCards() {
    if (!S) return;
    SEATS.forEach(function (k) {
      var el = els.cardEls[k];
      if (!el) return;
      var badge = el.querySelector("[data-badge]");
      var alive = !!S.alive[k];
      var dead = S.dead[k];
      el.classList.remove("dead", "out", "pickable", "talk");
      if (!alive) {
        el.classList.add("dead");
        if (dead === "vote") { el.classList.add("out"); badge.textContent = "被放逐"; }
        else badge.textContent = "离席";
        return;
      }
      badge.textContent = (k === P) ? "你的身份 · " + roleLabel(S.roles[P]) : "在场";
      var pickable = false;
      if (S.choice && S.choice.allow && S.choice.allow.indexOf(k) >= 0) pickable = true;
      if (!S.choice && S.phase === "vote" && k !== P) pickable = true;

      if (pickable) el.classList.add("pickable");
    });
  }
  function statusText() {
    if (!S) return "";
    if (S.choice && S.choice.hint) return S.choice.hint;
    if (S.busy) return S.busyLabel || "月见在斟酌";
    switch (S.phase) {
      case "open": return "身份已发。只有你看得见自己的身份。";
      case "night": return "夜色落下。请闭目……";
      case "night_wolf": return "狼队选刀：点一张卡。";
      case "night_seer": return "预言家验人：点一张卡。";
      case "night_witch": return "女巫用药：请选择。";
      case "night_shot": return "离席前，带走一人。";
      case "day": return S.spoke
        ? "想说什么就写下来；也可以直接举盏投票。"
        : "轮到你听他们说话了。";
      case "vote": return S.npcVotes ? "请点一张角色卡，投出你的一票。" : "茶盏在桌上转……";
      case "result": return "茶盏收走。接着，是夜。";
      case "ending": return "茶会散了。";
      default: return "";
    }
  }
  function setBusy(on, label) {
    if (!S) return;
    S.busy = !!on;
    if (on) S.busyLabel = label || "月见在斟酌";
    syncUI();
  }
  function syncUI() {
    if (!S || !root) return;
    renderHeader();
    renderCards();
    var label = "", show = true, dis = !!S.busy || !!S.typing || vnBusy();
    if (S.busy || S.typing) {
      label = "……";
    } else if (S.choice) {
      show = false;
    } else {
      switch (S.phase) {
        case "open": label = S.wishesDone ? "开始第一夜 ▶" : "入席 · 听愿望 ▶"; break;
        case "night": show = false; break;
        case "night_wolf": case "night_seer": case "night_witch": case "night_shot": show = false; break;
        case "day": label = S.spoke ? "举盏投票 ▶" : "听众人发言 ▶"; break;
        case "vote": show = false; break;
        case "result": label = S.nextLabel || "入夜 ▶"; break;
        case "ending": show = false; break;
        default: show = false;
      }
    }
    if (vnBusy()) show = false;
    els.cont.textContent = label;
    els.cont.disabled = dis;
    els.cont.style.display = show ? "" : "none";
    var st = statusText();
    els.status.textContent = st;
    els.status.className = "tea-status" + (S.busy ? " loading" : "");
    if (els.skip) els.skip.style.display = vnBusy() ? "" : "none";
    var inputOn = !S.busy && !S.typing && !S.choice && !vnBusy() &&
      (S.phase === "day" || S.phase === "vote" || S.phase === "result");
    var stripOn = !!S.stripShown || S.phase === "vote" ||
      !!(S.choice && S.choice.allow && S.choice.spec && S.choice.spec.cardPick);
    if (els.cards) els.cards.classList.toggle("show", stripOn);
    els.input.disabled = !inputOn;
    els.send.disabled = !inputOn;
    els.input.placeholder = inputOn ? "可写：我信谁 / 我点谁 / 我投谁 / 理由" : "（此刻无人接话）";
    els.input.title = inputOn ? "可写：我信谁 / 我点谁 / 我投谁 / 理由" : "";
    els.calls.textContent = "AI " + api.calls;
  }

  function onCardPick(who) {
    if (!S || !who || S.busy) return;
    if (S.choice && S.choice.allow && S.choice.allow.indexOf(who) >= 0 && S.alive[who]) {
      S.choice.answer({ type: "target", who: who });
      return;
    }
    if (S.phase === "vote") {
      if (who === P || !S.alive[who]) return;
      castVote(who);
    }
  }

  /* ============================================================
     八、流程
     ============================================================ */
  function onContinue() {
    if (!S || S.busy || S.typing || vnBusy()) return;
    var g = S;
    if (g.phase === "open") return beginNight(1);
    if (g.phase === "day") {
      if (!g.spoke) return beginDaySpeech();
      return beginVote();
    }
    if (g.phase === "result") return afterResult();
    return null;
  }

  function hostLine(key, vars) {
    var t = (C.host_lines || {})[key];
    if (!t && PT.pools && PT.pools[HOST] && PT.pools[HOST][key]) t = PT.pools[HOST][key];
    if (!t && DEFAULT.host_lines) t = DEFAULT.host_lines[key];
    return fillTemplate(t || "", vars || {});
  }
  function fillTemplate(s, vars) {
    return String(s || "").replace(/\{(\w+)\}/g, function (m, k) {
      return (vars[k] === undefined || vars[k] === null) ? "" : String(vars[k]);
    });
  }

  /* ---- 夜 ---- */
  function beginNight(day) {
    var g = S;
    if (!g || g.busy) return Promise.resolve();
    g.day = day;
    g.phase = "night";
    g.spoke = false;
    g.playerVote = null;
    g.npcVotes = null;
    g.voteLines = null;
    g.voteDetail = null;
    g.tally = null;
    g.nextLabel = "";
    g.choice = null;
    clearChoicebar();
    setScene("bg_tea_night", "night");
    addLine(HOST, hostLine("night"), "host");
    addLine(null, hostLine("night_you"), "narr");
    sfx("sfx-settle");
    setBusy(true, "夜色渐深");
    return (async function () {
      await sleep(600);
      if (S !== g) return;
      var ev = await resolveNight(g);
      if (S !== g) return;
      g.lastNight = ev;
      await sleep(320);
      if (S !== g) return;
      var names = (ev.deaths || []).map(function (n) { return nameOf(n); });
      if (names.length) addLine(HOST, hostLine("dawn_dead", { who: names.join("、") }), "host");
      else addLine(HOST, hostLine("dawn_none"), "host");
      sfx("sfx-hit");
      setBusy(false);
      if (!g.alive[P]) {
        var byShot = (ev.shots || []).some(function (x) { return x.target === P; });
        return beginEnding(byShot ? "player_shot" : "player_night");
      }
      var wn = winnerNow(g);
      if (wn) { g.gameWinner = wn; return beginEnding(wn); }
      setScene("bg_tea", "dawn");
      g.phase = "day";
      syncUI();
      return null;
    })();
  }

  function weightedPick(w) {
    var keys = Object.keys(w || {});
    var total = 0;
    keys.forEach(function (k) { var v = Number(w[k]) || 0; if (v > 0) total += v; });
    if (total <= 0) return null;
    var r = Math.random() * total;
    for (var i = 0; i < keys.length; i++) {
      var v = Number(w[keys[i]]) || 0;
      if (v <= 0) continue;
      if (r < v) return keys[i];
      r -= v;
    }
    return keys[keys.length - 1] || null;
  }
  function aliveNpcs(g) {
    return NPCS.filter(function (k) { return g.alive[k]; });
  }
  function aliveAll(g) {
    return SEATS.filter(function (k) { return g.alive[k]; });
  }
  function isGuest(g, k) { return (g.wolves || []).indexOf(k) < 0; }
  function kill(g, who, cause) {
    if (!who || !g.alive[who]) return false;
    g.alive[who] = false;
    g.dead[who] = cause;
    if (who === P) g.playerAlive = false;
    return true;
  }

  /* ---- 夜里 NPC 的选人权重（不额外调用 AI，全部从 JSON 读） ---- */
  function chooseWolfKill(g) {
    var night = C.rules.night || {};
    var wolves = aliveAll(g).filter(function (k) { return isFox(g, k); });
    if (!wolves.length) return null;
    var killer = pick(wolves);
    var cands = aliveAll(g).filter(function (k) { return !isFox(g, k); });
    var zero = (night.knife_zero || {})[killer] || [];
    var filtered = cands.filter(function (k) { return zero.indexOf(k) < 0; });
    if (filtered.length) cands = filtered;
    if (!cands.length) return null;
    var w = {};
    cands.forEach(function (k) {
      var role = g.roles[k];
      var rw = (night.knife_role_weight || {})[role];
      var cw = (night.knife_weight || {})[k];
      var ww = (rw === undefined ? (night.knife_base_weight || 1) : Number(rw)) *
               (cw === undefined ? 1 : Number(cw));
      w[k] = ww > 0 ? ww : 0.05;
    });
    return weightedPick(w) || pick(cands);
  }
  function chooseSeerTarget(g) {
    var cands = aliveAll(g).filter(function (k) { return k !== g.seer; });
    if (!cands.length) return null;
    var w = {};
    cands.forEach(function (k) {
      var heat = (g.lastVotesAgainst[k] || []).length;
      var checked = g.seerChecks.filter(function (c) { return c.who === k; }).length;
      w[k] = (1 + heat * 1.5) * (checked ? 0.3 : 1);
    });
    return weightedPick(w) || pick(cands);
  }
  function roleCanShoot(g, role, cause) {
    var cfg = role === "wolf_king" ? (C.rules.wolf_king || {})
            : role === "hunter" ? (C.rules.hunter || {}) : null;
    if (!cfg) return false;
    var map = { knife: "shot_on_knife", vote: "shot_on_vote", poison: "shot_on_poison", shot: "shot_on_shot" };
    var key = map[cause];
    if (!key) return false;
    return cfg[key] !== false;
  }
  function chooseShotTarget(g, shooter) {
    var cfg = C.rules.death_shot || {};
    var cands = aliveAll(g).filter(function (k) { return k !== shooter; });
    if (!cands.length) return null;
    var shooterWolf = isFox(g, shooter);
    var prot = char(shooter).protect || [];
    var against = g.lastVotesAgainst[shooter] || [];
    var w = {};
    cands.forEach(function (k) {
      var role = g.roles[k];
      var ww = 1;
      if (shooterWolf) {
        if (isFox(g, k)) ww *= 0.05;
        else ww *= Number((cfg.target_role_weight || {})[role]) || 1;
      }
      if (against.indexOf(k) >= 0) ww *= Number(cfg.revenge_bonus) || 2.2;
      if (prot.indexOf(k) >= 0) ww *= Number(cfg.protect_penalty) || 0.08;
      w[k] = ww;
    });
    return weightedPick(w) || pick(cands);
  }
  /* 死亡技能：狼王/猎人（含玩家）离席前带人；被毒死按配置不能开枪 */
  async function resolveDeathShots(g, deaths, stage) {
    var cfg = C.rules.death_shot || {};
    var queue = (deaths || []).slice();
    var shots = [];
    var guard = 0;
    var maxShots = Number(cfg.max_shots) || 4;
    while (queue.length && guard < maxShots) {
      var d = queue.shift();
      if (!d || !g.roles[d.who]) continue;
      var role = g.roles[d.who];
      if (!roleCanShoot(g, role, d.cause)) continue;
      if (g.deathShotsDone[d.who]) continue;
      g.deathShotsDone[d.who] = true;
      var target = null;
      if (d.who === P) {
        addLine(null, "〔你的身份〕" + roleLabel(role) + "：离席前，可以带走一人。", "private");
        var cands = aliveAll(g).filter(function (k) { return k !== P; });
        if (!cands.length) continue;
        var fallback = pick(cands);
        var res = await askChoice(g, {
          phase: "night_shot",
          hint: "点一张卡，带TA一起走（也可以跳过，随机）。",
          allow: cands, cardPick: true, defaultValue: fallback,
          skipLabel: "跳过（随机带一人）"
        });
        if (S !== g) return shots;
        target = choiceTarget(res) || fallback;
      } else {
        target = chooseShotTarget(g, d.who);
      }
      if (!target || !g.alive[target]) continue;
      kill(g, target, "shot");
      var rec = { who: d.who, role: role, cause: d.cause, target: target, day: g.day };
      g.shots.push(rec);
      shots.push(rec);
      addLine(null, hostLine("shot", { who: nameOf(d.who), target: nameOf(target) }), "reveal");
      if (cfg.chain !== false) queue.push({ who: target, cause: "shot" });
      guard++;
    }
    return shots;
  }

  function npcWitchTurn(g, killWho) {
    var out = { saved: null, poisoned: null, antidoteUsed: false, poisonUsed: false };
    var witch = g.witch;
    if (!witch || !g.alive[witch]) return out;
    var wc = C.rules.witch || {};
    if (killWho && g.witchPotions.antidote > 0) {
      var cannotSelf = (killWho === witch && !wc.can_self_save);
      if (!cannotSelf) {
        var prot = char(witch).protect || [];
        var chance = Number(wc.save_base_chance) || 0.55;
        if (prot.indexOf(killWho) >= 0) chance += Number(wc.save_protect_bonus) || 0.35;
        if (g.day === 1) chance += 0.1;
        if (Math.random() < Math.min(0.95, chance)) {
          g.witchPotions.antidote--;
          out.saved = killWho;
          out.antidoteUsed = true;
        }
      }
    }
    if (!out.antidoteUsed && g.witchPotions.poison > 0 &&
        g.day >= (Number(wc.poison_after_day) || 2)) {
      var cands = aliveAll(g).filter(function (k) { return k !== witch; });
      var prot2 = char(witch).protect || [];
      var w = {};
      cands.forEach(function (k) {
        var ww = 1 + (g.lastVotesAgainst[k] || []).length * 1.2;
        if (prot2.indexOf(k) >= 0) ww *= Number(wc.poison_protect_penalty) || 0.08;
        w[k] = ww;
      });
      var target = weightedPick(w) || pick(cands);
      if (target && Math.random() < (Number(wc.poison_base_chance) || 0.45)) {
        g.witchPotions.poison--;
        out.poisoned = target;
        out.poisonUsed = true;
      }
    }
    return out;
  }
  async function playerWitchTurn(g, killWho) {
    var out = { saved: null, poisoned: null, antidoteUsed: false, poisonUsed: false };
    var wc = C.rules.witch || {};
    if (killWho && g.witchPotions.antidote > 0 && (killWho !== P || wc.can_self_save)) {
      addLine(null, "〔你的身份〕女巫：昨夜被刀的是 " + nameOf(killWho) + "。", "private");
      var res = await askChoice(g, {
        phase: "night_witch", hint: "是否使用解药救 " + nameOf(killWho) + "？（一晚只能用一瓶）",
        options: [{ label: "使用解药", value: "save", cls: "primary" },
                  { label: "不使用", value: "no" }],
        defaultValue: "no"
      });
      if (S !== g) return out;
      if (res.value === "save") {
        g.witchPotions.antidote--;
        out.saved = killWho;
        out.antidoteUsed = true;
        addLine(null, "〔女巫〕你使用了唯一的解药。", "private");
      }
    }
    if (!out.antidoteUsed && g.witchPotions.poison > 0 &&
        g.day >= (Number(wc.poison_after_day) || 2)) {
      var res2 = await askChoice(g, {
        phase: "night_witch", hint: "是否使用毒药？",
        options: [{ label: "使用毒药", value: "poison", cls: "primary" },
                  { label: "不使用", value: "no" }],
        defaultValue: "no"
      });
      if (S !== g) return out;
      if (res2.value === "poison") {
        var cands = aliveAll(g).filter(function (k) { return k !== P; });
        if (cands.length) {
          var fallback = pick(cands);
          var tr = await askChoice(g, {
            phase: "night_witch", hint: "选择要毒的人：点一张卡。",
            allow: cands, cardPick: true, defaultValue: fallback,
            skipLabel: "跳过（随机）"
          });
          if (S !== g) return out;
          var target = choiceTarget(tr) || fallback;
          if (target) {
            g.witchPotions.poison--;
            out.poisoned = target;
            out.poisonUsed = true;
            addLine(null, "〔女巫〕你把毒药下进了" + nameOf(target) + "的茶里。", "private");
          }
        }
      }
    }
    return out;
  }

  async function resolveNight(g) {
    var ev = {
      killed: null, saved: null, poisoned: null, checked: null,
      shots: [], deaths: [], playerDead: false, witchUsed: {}
    };
    var killWho = null;
    /* 1. 狼刀 */
    if (g.alive[P] && isFox(g, P)) {
      var suggestion = chooseWolfKill(g);
      var teammates = aliveAll(g).filter(function (k) { return k !== P && isFox(g, k); });
      if (teammates.length && suggestion) {
        addLine(null, "〔狼队〕同伴的意思：刀 " + nameOf(suggestion) + "。", "private");
      } else {
        addLine(null, "〔狼队〕今夜由你决定刀谁。", "private");
      }
      var knifeCands = aliveAll(g).filter(function (k) { return !isFox(g, k); });
      var kr = await askChoice(g, {
        phase: "night_wolf",
        hint: "狼队选刀：点一张卡（也可以跳过，交给同伴）。",
        allow: knifeCands, cardPick: true,
        defaultValue: suggestion || pick(knifeCands),
        skipLabel: "跳过（交给同伴）"
      });
      if (S !== g) return ev;
      killWho = choiceTarget(kr) || suggestion || null;
      if (killWho) addLine(null, "〔狼队〕你们选了 " + nameOf(killWho) + "。", "private");
    } else {
      killWho = chooseWolfKill(g);
    }
    /* 2. 预言家验人 */
    if (g.seer && g.alive[g.seer]) {
      if (g.seer === P) {
        var sc = aliveAll(g).filter(function (k) { return k !== P; });
        if (sc.length) {
          var sr = await askChoice(g, {
            phase: "night_seer",
            hint: "预言家：点一张卡查验（结果只有你看得见）。",
            allow: sc, cardPick: true, defaultValue: pick(sc),
            skipLabel: "跳过（随机）"
          });
          if (S !== g) return ev;
          var st = choiceTarget(sr) || pick(sc);
          if (st) {
            var chk = { day: g.day, who: st, isWolf: isFox(g, st) };
            g.seerChecks.push(chk);
            g.checked = chk;
            ev.checked = chk;
            addLine(null, "〔查验〕" + nameOf(st) + "：" + (chk.isWolf ? "狼" : "好人") + "。", "private");
          }
        }
      } else {
        var nt = chooseSeerTarget(g);
        if (nt) {
          var chk2 = { day: g.day, who: nt, isWolf: isFox(g, nt) };
          g.seerChecks.push(chk2);
          g.checked = chk2;
          ev.checked = chk2;
        }
      }
    }
    /* 3. 女巫用药 */
    var wres = null;
    if (g.witch && g.alive[g.witch]) {
      wres = (g.witch === P) ? await playerWitchTurn(g, killWho) : npcWitchTurn(g, killWho);
      if (S !== g) return ev;
      if (wres.saved) { ev.saved = wres.saved; killWho = null; }
      if (wres.poisoned) ev.poisoned = wres.poisoned;
    }
    ev.killed = killWho;
    /* 4. 结算死亡 */
    var deaths = [];
    if (killWho) { kill(g, killWho, "knife"); deaths.push({ who: killWho, cause: "knife" }); }
    if (ev.poisoned && g.alive[ev.poisoned] && ev.poisoned !== killWho) {
      kill(g, ev.poisoned, "poison");
      deaths.push({ who: ev.poisoned, cause: "poison" });
    }
    ev.deaths = deaths.map(function (d) { return d.who; });
    /* 5. 死亡技能（狼王/猎人） */
    ev.shots = await resolveDeathShots(g, deaths, "night");
    if (S !== g) return ev;
    ev.playerDead = !g.alive[P];
    return ev;
  }

  function winnerNow(g) {
    var alive = aliveAll(g);
    var wolfAlive = alive.filter(function (k) { return isFox(g, k); }).length;
    var goodAlive = alive.length - wolfAlive;
    if (wolfAlive <= 0) return "guest_win";
    if (wolfAlive >= goodAlive) return "fox_win";
    return null;
  }

  /* ============================================================
     剧情导演：代码指定 beat（谁/对象/目的/必须提到的事实），AI 只写台词
     ============================================================ */
  function heatOf(g, name) {
    var h = (g.targetHeat[name] || 0) + (g.lastVotesAgainst[name] || []).length * 1.5;
    return h;
  }
  /* ============================================================
     v5：私有计划 + 狼队私聊 + 性格镜头（只给模型看，不上 UI）
     ============================================================ */
  var LENS_FALLBACK = {
    "月见": "主持，不投票；只裁/提醒，不参与站边。",
    "千春": "用可爱和控制掩盖害怕被丢下；谁让池田难堪就咬谁；软萌反问带威胁，也会突然露出害怕。",
    "池田": "怕被冤枉、被害妄想；越被点越急，容易反咬最近的人；冲动、语无伦次。",
    "茶终": "老茶师、大家长、惜字如金；看人的手、坐姿、谁先动；短、下结论、不解释；在意樱井但不挂嘴上。",
    "樱井": "清冷、要强、背负家庭包袱；先给结论再补理由；被质疑时先解释动机（越解释越像掩饰），再更冷地压回去；绝不当众示弱。",
    "小野": "干练、好胜，也会怕；用玩笑和命令句挡过去；护幸子，也藏自己的脆弱。",
    "幸子": "怯，但想被需要；紧张时抠细节，常点出别人漏掉的一处矛盾。",
    "墨墨": "毒舌、护玩家；先下判断再补一句理由；句子短；嘴上不认。",
    "玩家": "墨墨之友；投票、参与逻辑盘算。"
  };
  var LENS_RE = {
    "千春": /清冷|体面|聪明|细节|控制|占有|软|笑|判断|稳/,
    "池田": /急|怕|回|父母|从前|冤枉|凭什么|！/,
    "茶终": /手|茶|火候|坐|先|不知道|看|等/,
    "樱井": /结论|解释|动机|因为|冷/,
    "小野": /幸子/,
    "幸子": /母亲|妈妈|失望|漏|矛盾|不敢|对不上/,
    "墨墨": /毒|判断|理由|护|嘴硬|哼/
  };
  function lensOf(name) { return char(name).lens || LENS_FALLBACK[name] || ""; }
  function cn6(s) { return String(s || "").replace(/[^\u4e00-\u9fff]/g, ""); }
  function commonSix(a, b) {
    a = cn6(a); b = cn6(b);
    if (a.length < 6 || b.length < 6) return "";
    for (var i = 0; i + 6 <= a.length; i++) {
      var frag = a.substr(i, 6);
      if (b.indexOf(frag) >= 0) return frag;
    }
    return "";
  }
  function humanSpeechOk(g, who, text, pool) {
    if (!text) return false;
    if (/[0-9０-９]/.test(text)) return false;
    if (text.indexOf("号") >= 0 || text.indexOf("座位") >= 0) return false;
    if (/先看谁.*坐不住|急.{0,5}点我|点我.{0,5}急|反应太干净/.test(text)) return false;
    var bans = (C.rules.speech_bans || []).concat(["听水", "水声", "听停顿", "听人心", "听心跳"]);
    for (var i = 0; i < bans.length; i++) if (bans[i] && text.indexOf(bans[i]) >= 0) return false;
    if (/^[（(]/.test(text) || /```|https?:|\bJSON\b|\bsystem\b/i.test(text)) return false;
    var sentences = (text.match(/[。！？!?]/g) || []).length;
    if (sentences < 1 || sentences > 3) return false;
    if (!/[信站保投票出推]/.test(text)) return false;
    var lr = LENS_RE[who];
    if (lr && !lr.test(text)) return false;
    var flat = text.replace(/\s+/g, "");
    for (var pi = 0; pi < (pool || []).length; pi++) {
      var other = (pool[pi] || "").replace(/\s+/g, "");
      if (commonSix(flat, other)) return false;
    }
    return true;
  }
  function speechPattern(text) {
    var t = String(text || "").replace(/[^\u4e00-\u9fff]/g, "");
    ["千春", "池田", "茶终", "樱井", "小野", "幸子", "墨墨", "月见"].forEach(function (n) {
      t = t.split(n).join("");
    });
    return t.slice(0, 8);
  }
  function poolTexts(g) {
    return (g.log || []).slice(-40).map(function (e) { return e.text || ""; });
  }

  function validVote(g, name, self) {
    name = normalizeName(name);
    if (!name || name === self || name === HOST) return "";
    return g.alive[name] ? name : "";
  }
  function validRespond(g, name, self) {
    name = normalizeName(name);
    if (!name || name === self) return "";
    if (name === P) return P;
    if (name === HOST) return HOST;
    return g.alive[name] ? name : "";
  }
  function heatTarget(g, self, goodOnly) {
    var cands = aliveAll(g).filter(function (k) { return k !== self && k !== P; });
    if (goodOnly) cands = cands.filter(function (k) { return !isFox(g, k); });
    if (!cands.length) cands = aliveAll(g).filter(function (k) { return k !== self; });
    var best = null, bs = -1;
    cands.forEach(function (k) {
      var h = heatOf(g, k) + (isFox(g, self) && isFox(g, k) ? -20 : 0);
      if (h > bs) { bs = h; best = k; }
    });
    return best || pick(cands);
  }
  function defaultWolfChat(g) {
    var wolves = aliveAll(g).filter(function (k) { return isFox(g, k); });
    var goods = aliveAll(g).filter(function (k) { return !isFox(g, k); });
    var hammer = wolves.filter(function (n) { return n === "墨墨"; })[0] || wolves[0] || "";
    var rest = wolves.filter(function (n) { return n !== hammer; });
    var push = heatTarget(g, hammer, true);
    var knife = chooseWolfKill(g) || push;
    return {
      hammer: hammer,
      deep: rest[0] || "",
      charge: rest[1] || "",
      knife: knife || "",
      push: push || ""
    };
  }
  function publicReasons(g) {
    var arr = [];
    var n = g.lastNight || {};
    if ((n.deaths || []).length) arr.push("昨夜" + n.deaths.map(nameOf).join("、") + "离席");
    if ((n.shots || []).length) arr.push(n.shots.map(function (x) { return nameOf(x.who) + "带走了" + nameOf(x.target); }).join("；"));
    if (g.expel) arr.push("上一轮" + nameOf(g.expel.who) + "被放逐");
    if (g.voteDetail && Object.keys(g.voteDetail).length) {
      var vk = Object.keys(g.voteDetail)[0];
      arr.push("上一轮" + nameOf(vk) + "投了" + nameOf(g.voteDetail[vk]));
    }
    arr.push("第一轮还没有票型", "现在还没人放逐过", "大家还在试探", "场上还没有人亮身份");
    return arr;
  }
  function defaultPlan(g, name, wolfChat) {
    var role = g.roles[name];
    var wc = wolfChat || defaultWolfChat(g);
    var goods = aliveAll(g).filter(function (k) { return k !== name && !isFox(g, k); });
    var target = heatTarget(g, name, false) || (goods[0] || "");
    var claim = "民", reason = "", stance = "", responseTo = "";
    if (isFox(g, name)) {
      claim = wc.hammer === name ? "悍跳预" : (wc.deep === name ? "倒钩狼" : (wc.charge === name ? "冲锋狼" : "深水狼"));
      target = validVote(g, wc.push, name) || target;
      reason = (g.lastNight && (g.lastNight.deaths || []).length)
        ? "昨夜" + (g.lastNight.deaths || []).map(nameOf).join("、") + "离席"
        : "第一轮还没有票型，先看他怎么站";
      stance = "不信" + nameOf(target);
    } else if (role === "seer") {
      var wolfCheck = null;
      for (var i = g.seerChecks.length - 1; i >= 0; i--) {
        if (g.seerChecks[i].isWolf && g.alive[g.seerChecks[i].who]) { wolfCheck = g.seerChecks[i]; break; }
      }
      if (wolfCheck) {
        claim = "预"; target = wolfCheck.who;
        reason = "昨夜验出" + nameOf(target) + "是狼";
        stance = "不信" + nameOf(target);
      } else {
        claim = g.day >= 2 ? "预" : "民";
        reason = "先看谁在带票";
        stance = "信" + nameOf(char(name).protect && char(name).protect[0] && g.alive[char(name).protect[0]] ? char(name).protect[0] : name);
      }
    } else if (role === "witch") {
      claim = g.day >= 3 ? "女" : "民";
      reason = "先看谁在带票";
      stance = "信" + nameOf(char(name).protect && char(name).protect[0] && g.alive[char(name).protect[0]] ? char(name).protect[0] : name);
    } else if (role === "hunter") {
      claim = g.day >= 3 ? "猎" : "民";
      reason = "先看谁在带票";
      stance = "不信" + nameOf(target);
    } else {
      var prot = (char(name).protect || []).filter(function (k) { return g.alive[k]; })[0];
      stance = prot ? "信" + nameOf(prot) : "不信" + nameOf(target);
      reason = (g.lastNight && (g.lastNight.deaths || []).length)
        ? "昨夜" + (g.lastNight.deaths || []).map(nameOf).join("、") + "离席"
        : "第一轮还没有票型";
    }
    return {
      claim: claim, stance: stance,
      suspect: [target, reason || "他在带节奏"],
      voteIntent: target, reason: reason,
      responseTo: responseTo
    };
  }
  function defaultPlans(g) {
    var wc = defaultWolfChat(g);
    var plans = {};
    aliveNpcs(g).forEach(function (name) { plans[name] = defaultPlan(g, name, wc); });
    return { plans: plans, wolfChat: wc };
  }
  function fallbackPlans(g) {
    var d = defaultPlans(g);
    return normalizePlans(g, { plans: d.plans, wolf_chat: d.wolfChat });
  }
  function normalizePlans(g, raw) {
    var fallback = defaultPlans(g);
    var out = {};
    var claims = C.rules.claims || ["民", "预", "女", "猎", "悍跳预", "倒钩狼", "冲锋狼", "深水狼"];
    var wp = raw && raw.wolf_chat || {};
    var wc = {
      hammer: normalizeName(wp.hammer || ""),
      deep: normalizeName(wp.deep || ""),
      charge: normalizeName(wp.charge || ""),
      knife: normalizeName(wp.knife || ""),
      push: normalizeName(wp.push || "")
    };
    var wolves = aliveAll(g).filter(function (k) { return isFox(g, k); });
    var variants = publicReasons(g), usedReasons = {};
    [wc.hammer, wc.deep, wc.charge].forEach(function (n, i) {
      if (wolves.indexOf(n) < 0) wc[i === 0 ? "hammer" : i === 1 ? "deep" : "charge"] = wolves[i] || "";
    });
    if (!wc.knife || !g.alive[wc.knife] || isFox(g, wc.knife)) wc.knife = fallback.wolfChat.knife;
    if (!wc.push || !g.alive[wc.push] || isFox(g, wc.push)) wc.push = fallback.wolfChat.push;
    aliveNpcs(g).forEach(function (name) {
      var p = raw && raw.plans && raw.plans[name] || {};
      var def = defaultPlan(g, name, wc);
      var claim = claims.indexOf(p.claim) >= 0 ? p.claim : def.claim;
      var target = validVote(g, p.voteIntent, name) || def.voteIntent;
      if (isFox(g, name) && isFox(g, target)) target = wc.push || def.voteIntent;
      var resp = validRespond(g, p.responseTo, name) || "";
      var sus = Array.isArray(p.suspect) ? p.suspect.slice(0, 2).map(String) : def.suspect;
      var susName = validVote(g, sus[0], name);
      if (!susName) sus = def.suspect;
      var reason = String(p.reason || def.reason).slice(0, 80);
      reason = reason.replace(/第[0-9０-９一二三四五六七八九十]+夜/g, "昨夜");
      if (/狼队|私聊|今晚刀|刀谁|悍跳|倒钩|冲锋|深水|药/.test(reason)) reason = def.reason;
      var generic = /第一轮还没有票型|先看谁在带票|先看他怎么站/.test(reason);
      if (generic || usedReasons[reason]) {
        var alt = variants.filter(function (r) {
          return !usedReasons[r] && (!generic || r === reason || r.indexOf("第一轮还没有票型") < 0);
        })[0];
        if (alt) reason = alt;
      }
      usedReasons[reason] = true;
      var stance = String(p.stance || def.stance).slice(0, 20);
      if (/狼队|私聊|刀/.test(stance)) stance = def.stance;
      var sus2 = sus;
      if (sus2.some(function (x) { return /狼队|私聊|刀谁|今晚刀/.test(String(x)); })) sus2 = def.suspect;
      out[name] = {
        claim: claim,
        stance: stance,
        suspect: sus2,
        voteIntent: target,
        reason: reason,
        responseTo: resp || def.responseTo || ""
      };
    });
    return { plans: out, wolfChat: wc };
  }
  function aiPlans(g) {
    if (api.calls >= AI_MAX_CALLS) return Promise.resolve(fallbackPlans(g));
    var alive = aliveNpcs(g);
    var ps = g.playerStance;
    var playerBit = "";
    if (ps) {
      playerBit = "【玩家上轮公开表态】" +
        (ps.trust ? "信" + nameOf(ps.trust) + "；" : "") +
        (ps.accuse ? "点" + nameOf(ps.accuse) + "；" : "") +
        (ps.vote ? "投" + nameOf(ps.vote) + "；" : "") +
        "本轮至少一位 NPC 的 responseTo 必须回应玩家或该对象。\n";
    }
    var sys = baseSystem() + charBlock(g) + "\n" + boardBlock(g) + "\n" +
      "【本轮先做私密计划：只给模型看，绝不显示给玩家】\n" +
      "1) 狼队先私聊：hammer(谁悍跳预)、deep(谁倒钩狼)、charge(谁冲锋狼)、knife(今晚刀谁)、push(今天推谁)。\n" +
      "2) 每个在场 NPC 给自己 plan：claim 只能从 " + (C.rules.claims || []).join("/") +
      "；stance 写“信X/不信X”；suspect 写 [名字, 为什么]；voteIntent 必须是当前在场者且不是自己；" +
      "reason 必须是公开可见的依据（哪句公开发言/哪次票/谁死了），狼也不能把私聊/刀人计划写进 reason；responseTo 写上一句点你/怀疑你的人，没有就写上一位发言者。\n" +
      "3) 预言家决定起跳或藏；女巫/猎人决定藏或拍身份；狼按私聊执行。每条发言都必须和 voteIntent 一致。\n" +
      playerBit +
      "【输出严格 JSON】{\"wolf_chat\":{\"hammer\":\"墨墨\",\"deep\":\"樱井\",\"charge\":\"茶终\",\"knife\":\"千春\",\"push\":\"池田\"}," +
      "\"plans\":{\"千春\":{\"claim\":\"民\",\"stance\":\"不信池田\",\"suspect\":[\"池田\",\"他先点我\"],\"voteIntent\":\"池田\",\"reason\":\"昨夜无人离席，池田先点我\",\"responseTo\":\"池田\"}}}。" +
      "plans 键必须覆盖：" + alive.join("、") + "。";
    var user = "第 " + g.day + " 天。请先私聊/计划，再只输出 JSON（wolf_chat + plans）。";
    return callAI(g, sys, user, Number((C.rules.ai || {}).plan_max_tokens) || 1400).then(function (t) {
      var o = parseJSON(t);
      if (!o) { api.parseFails++; return fallbackPlans(g); }
      return normalizePlans(g, o);
    })["catch"](function () { api.parseFails++; return fallbackPlans(g); });
  }

  function buildDayBeats(g) {
    var alive = aliveNpcs(g);
    var plans = g.plans || {};
    var deaths = (g.lastNight && g.lastNight.deaths) || [];
    var shots = (g.lastNight && g.lastNight.shots) || [];
    var prevVote = g.voteDetail || {};
    var prevExpel = g.expel && g.expel.who;
    var heat = {};
    aliveAll(g).forEach(function (k) { heat[k] = heatOf(g, k); });
    var beats = [], prevSpeaker = null, prevBeat = null, usedFacts = [];
    var factVariants = ["第一轮还没有票型", "昨夜没有死人", "现在还没人放逐过", "场上还没有验人公开", "大家都在试探", "这段发言还没被回应", "现在还没人把话挑明", "现在只能靠听"];
    alive.forEach(function (name, idx) {
      var role = g.roles[name];
      var p = plans[name] || defaultPlan(g, name, g.wolfChat);
      var votedBy = (g.lastVotesAgainst && g.lastVotesAgainst[name]) || [];
      var accused = heat[name] >= 2 || votedBy.length > 0;
      var target = validVote(g, p.voteIntent, name) || heatTarget(g, name, isFox(g, name)) || "";
      /* 先回应“上一句点我/怀疑我”的人；没人点我，再回应上一位发言者 */
      var pointedBy = (prevBeat && prevBeat.target === name && prevBeat.who !== name) ? prevBeat.who : "";
      var respond = validRespond(g, p.responseTo, name) ||
        (pointedBy ? pointedBy : (prevSpeaker && prevSpeaker !== name ? prevSpeaker : ""));
      var goal = "质疑";
      if (p.claim === "悍跳预" || (p.claim === "预" && role !== "seer")) goal = "悍跳";
      else if (p.claim === "倒钩狼") goal = "倒钩";
      else if (p.claim === "冲锋狼") goal = "带节奏";
      else if (p.claim === "深水狼") goal = "藏身份";
      else if (p.claim === "女" || p.claim === "猎") goal = "拍身份";
      else if (role === "seer" && p.claim === "预") goal = "报验人";
      else if (accused) goal = "辩护";
      var facts = [];
      if (p.reason) facts.push(p.reason);
      if (deaths.length && idx === 0) facts.push("昨夜" + deaths.map(nameOf).join("、") + "离席");
      if (shots.length && idx === 1) facts.push(shots.map(function (x) { return nameOf(x.who) + "带走" + nameOf(x.target); }).join("；"));
      if (prevExpel && facts.length < 2) facts.push("上一轮" + nameOf(prevExpel) + "被放逐");
      if (votedBy.length && facts.length < 2) facts.push("上一轮" + votedBy.map(nameOf).join("、") + "投了你");
      if (prevVote[name] && facts.length < 2) facts.push("你上一轮投了" + nameOf(prevVote[name]));
      var uniq = [];
      facts.forEach(function (f) {
        f = String(f);
        if (usedFacts.some(function (u) { return commonSix(f, u); })) return;
        uniq.push(f);
      });
      if (!uniq.length) {
        for (var vi = 0; vi < factVariants.length; vi++) {
          var cand = factVariants[(idx + vi) % factVariants.length];
          if (!usedFacts.some(function (u) { return commonSix(cand, u); })) { uniq.push(cand); break; }
        }
      }
      if (!uniq.length) uniq.push("轮到" + nameOf(name) + "把话说明白");
      usedFacts = usedFacts.concat(uniq);
      facts = uniq;
      var lens = lensOf(name);
      beats.push({
        who: name, target: target, respond: respond, goal: goal,
        claim: p.claim, stance: p.stance || "", voteIntent: target,
        facts: facts.slice(0, 3), lens: lens, day: g.day, order: idx
      });
      prevSpeaker = name;
      prevBeat = beats[beats.length - 1];
    });
    /* 玩家上轮的公开站边/点名：下一轮至少一位 NPC 必须回应 */
    var ps = g.playerStance;
    if (ps) {
      var named = ps.accuse || ps.vote || ps.trust;
      var b = null;
      beats.forEach(function (x) { if (!b && named && x.who === named) b = x; });
      if (!b) b = beats[0];
      if (b) {
        b.respond = P;
        b.facts.unshift("玩家上轮公开" + (ps.trust ? "信你" : "点名你") +
          (named && named !== b.who ? "，提到" + nameOf(named) : ""));
      }
      g.playerStanceApplied = ps;
      g.playerStance = null;
    }
    return beats;
  }
  function beatPrompt(g, beats) {
    var lines = [];
    beats.forEach(function (b, i) {
      lines.push("Beat " + (i + 1) + "｜" + b.who +
        "｜先回应：" + (b.respond ? nameOf(b.respond) : "上一位发言者") +
        "｜claim：" + (b.claim || "民") +
        "｜站边：" + (b.stance || "未定") +
        "｜点名/今天投：" + (b.target ? nameOf(b.target) : "众人") +
        "｜依据：" + (b.facts.join("；") || "当前局面") +
        "｜性格镜头：" + b.lens);
    });
    return lines.join("\n");
  }
  function beatTokens(b) {
    var toks = [];
    if (b.target) toks.push(nameOf(b.target));
    (b.facts || []).forEach(function (f) {
      SEATS.concat([HOST]).forEach(function (k) {
        if (f.indexOf(k) >= 0) toks.push(nameOf(k));
      });
      ["昨夜", "上一轮", "被放逐", "离席", "投了你"].forEach(function (w) {
        if (f.indexOf(w) >= 0) toks.push(w);
      });
    });
    return toks;
  }
  function parseBeatPlain(text) {
    var out = [];
    String(text || "").split(/\n+/).forEach(function (line) {
      line = line.trim().replace(/^[-*\d.、\s]+/, "");
      if (!line) return;
      var parts = line.split(/\s*[｜|]\s*/);
      if (parts.length >= 2) {
        var who = normalizeName(parts[0].replace(/[：:]/g, "").trim());
        var tx = (parts[1] || "").trim();
        if (who && tx) out.push({
          who: who, text: tx,
          expr: (parts[2] || "").trim(),
          stance: (parts[3] || "").trim(),
          target: normalizeName((parts[4] || "").trim())
        });
        return;
      }
      var m = line.match(/^([^：:]{1,8})[：:]\s*(.+)$/);
      if (m) out.push({ who: normalizeName(m[1]), text: m[2].trim() });
    });
    return out;
  }
  function modelLinesFromAny(t) {
    var o = parseJSON(t);
    if (o) {
      var ls = modelLines(o);
      if (Array.isArray(ls) && ls.length) return ls;
    }
    return parseBeatPlain(t);
  }

  function validateBeatLines(g, arr, beats) {
    var EXPR = expressions(), ST = stances(), BAN = bannedTerms();
    var out = [];
    if (!Array.isArray(arr)) return out;
    var pool = poolTexts(g);
    var seen = (g.log || []).slice(-40).map(function (e) { return normText(e.text); });
    beats.forEach(function (beat) {
      var cand = null;
      arr.forEach(function (x) {
        if (!cand && x && normalizeName(x.who) === beat.who) cand = x;
      });
      if (!cand) return;
      var text = String(cand.text || "").replace(/\s*\n+\s*/g, " ").trim();
      if (text.length < 6 || text.length > dayLineMax() + 10) return;
      for (var bi = 0; bi < BAN.length; bi++) if (BAN[bi] && text.indexOf(BAN[bi]) >= 0) return;
      if (deathClaimBad(g, beat.who, text)) return;
      if (beat.who !== HOST && /主持/.test(text)) return;
      if (!humanSpeechOk(g, beat.who, text, pool.concat(out.map(function (x) { return x.text; })))) return;
      var pat = speechPattern(text);
      if (g.lastPatterns && g.lastPatterns[beat.who] && g.lastPatterns[beat.who] === pat) return;
      var key = normText(text);
      if (!key || seen.indexOf(key) >= 0) return;
      var flat = text.replace(/\s+/g, "");
      var target = beat.voteIntent || beat.target;
      if (target) {
        var tn = nameOf(target).replace(/\s+/g, "");
        if (!(flat.indexOf(tn) >= 0 || (target === P && flat.indexOf("你") >= 0))) return;
      }
      if (beat.respond) {
        var rn = nameOf(beat.respond).replace(/\s+/g, "");
        if (!(flat.indexOf(rn) >= 0 || (beat.respond === P && flat.indexOf("你") >= 0))) return;
      }
      var ftoks = [];
      (beat.facts || []).forEach(function (f) {
        SEATS.concat([HOST]).forEach(function (k) {
          var kn = nameOf(k).replace(/\s+/g, "");
          if (f.indexOf(k) >= 0 && ftoks.indexOf(kn) < 0) ftoks.push(kn);
        });
        ["昨夜", "上一轮", "无人离席", "没有死人", "被放逐", "投了你", "票型", "验人"].forEach(function (w) {
          if (f.indexOf(w) >= 0) ftoks.push(w.replace(/\s+/g, ""));
        });
      });
      if (ftoks.length) {
        var hitFact = false;
        for (var fi = 0; fi < ftoks.length; fi++) if (ftoks[fi] && flat.indexOf(ftoks[fi]) >= 0) { hitFact = true; break; }
        if (!hitFact) return;
      }
      seen.push(key);
      var expr = mapExpr(cand.expr);
      var stance = mapStance(cand.stance);
      if (g.lastPatterns) g.lastPatterns[beat.who] = pat;
      out.push({
        who: beat.who, text: text, expr: expr, stance: stance,
        target: target || "", respond: beat.respond || "", voteIntent: target || "",
        goal: beat.goal, claim: beat.claim, facts: beat.facts
      });
    });
    return out;
  }
  function aiBeatGroup(g, beats, retry, prevLines) {
    var sys = baseSystem() + charBlock(g) + "\n" + boardBlock(g) + "\n" +
      (prevLines && prevLines.length
        ? "【本轮已发言（不要复读、不要复用 6 字以上连续短语）】\n" +
          prevLines.map(function (l) { return l.who + "：" + l.text; }).join("\n") + "\n"
        : "") +
      "【导演已指定 beat：你只写台词，不能改 who/回应对象/点名对象/站边/票意图，不能决定谁死谁被投】\n" +
      beatPrompt(g, beats) + "\n" +
      "【硬要求】\n" +
      "1) 第 1 句先回应「先回应」的人；之后点名「点名/今天投」的人，并说出「依据」里的具体事实。\n" +
      "2) 明确站边（信/不信/保/推），并且今天的票要投给点名的人；不要含糊。\n" +
      "3) 1~3 句、第一人称、口语；自然带出「性格镜头」的关注点/偏见/攻击方式，不要念设定。\n" +
      "4) 禁止任何编号/座位号（不许出现阿拉伯数字、X号、座位）；禁止 AI 套话（我认为/从逻辑上看/首先/其次/综上所述）；禁止旁白、总结、全知；禁止听水/水声/听停顿/听人心/听心跳。\n" +
      "5) 不得复用别人的句式或 6 字以上连续短语，不得复读。\n" +
      "【输出格式】不要 JSON、不要 markdown、不要解释，每个 NPC 一行：\n" +
      "who｜台词｜表情｜立场｜对象\n" +
      "示例：樱井｜结论我先给：昨夜没人离席，池田先点我，解释一次，我今天票池田。｜默认｜质疑｜池田\n" +
      "严格按 Beat 顺序、不增不减，共 " + beats.length + " 行；who 必须是 " + beats.map(function (b) { return b.who; }).join("、") +
      "；表情只能从 " + expressions().join("/") + "；立场只能从 " + stances().join("/") + "。";
    var order = beats.map(function (b, i) {
      return "第" + (i + 1) + "行：" + b.who +
        "；先回应：" + (b.respond ? nameOf(b.respond) : "上一位发言者") +
        "；点名/今天投：" + (b.target ? nameOf(b.target) : "众人") +
        "；依据：" + (b.facts.join("；") || "当前局面");
    }).join("\n");
    var user = "第 " + g.day + " 天。严格按下面顺序写 " + beats.length +
      " 行（who｜台词｜表情｜立场｜对象），不增不减：\n" + order +
      (retry ? "\n上一版不合格：有人没回应/没点名/没事实/带编号/复读，这次必须严格命中。" : "");
    return callAI(g, sys, user, 1500).then(function (t) {
      var arr = modelLinesFromAny(t);
      if (!arr || !arr.length) { api.parseFails++; return null; }
      var lines = validateBeatLines(g, arr, beats);
      return lines.length ? lines : null;
    })["catch"](function () { api.parseFails++; return null; });
  }
  function fallbackBeatLine(g, beat) {
    var name = beat.who;
    var target = beat.target ? nameOf(beat.target) : "众人";
    var respond = beat.respond ? nameOf(beat.respond) : "";
    var fact = (beat.facts || [])[0] || "现在还没什么线索";
    fact = String(fact).replace(/第[0-9０-９一二三四五六七八九十]+夜/g, "昨夜");
    var voteWord = { "千春": "我这票给", "池田": "我投", "茶终": "投", "樱井": "我投", "小野": "我投", "幸子": "我一票给", "墨墨": "票" }[name] || "我投";
    var openers = {
      "千春": ["先别急着定人。", "我听完了，再说判断。", "这件事，我看的是细节。"],
      "池田": ["别把话都往我身上绕。", "我不是被吓大的。", "你们先听我把话说完！"],
      "茶终": ["先坐。", "茶还热。", "看手。"],
      "樱井": ["结论先给。", "我说我的判断。", "解释一次。"],
      "小野": ["幸子，你那里说错了。", "幸子，先想清楚再说。", "把话说明白。"],
      "幸子": ["我、我怕说错……", "我只说一处。", "我算过了。"],
      "墨墨": ["……先下判断。", "说短一点。", "理由只有一条。"]
    };
    var op = (openers[name] || ["我说一句。"])[g.day % 3];
    var text = "";
    if (beat.goal === "报验人" || beat.goal === "悍跳") {
      if (name === "千春") text = "我跳预言家。昨夜验的是" + target + "，是狼；细节我不多解释，" + voteWord + target + "。";
      else if (name === "樱井") text = "结论先给：我是预言家，昨夜验的是" + target + "，是狼；" + voteWord + target + "。";
      else if (name === "茶终") text = "看手。验" + target + "，狼。投" + target + "。";
      else if (name === "池田") text = "别逼我急！我是预言家，昨夜验的是" + target + "，是狼；" + voteWord + target + "。";
      else if (name === "墨墨") text = "……先下判断：我是预言家，验的是" + target + "，狼；" + voteWord + target + "。";
      else if (name === "小野") text = (g.alive["幸子"] ? "幸子，看好了：" : "幸子不在，") +
        "验错不了，" + target + "是狼；我是预言家，" + voteWord + target + "。";
      else if (name === "幸子") text = "妈妈，我说清楚：我是预言家，验的是" + target + "，狼；" + voteWord + target + "。";
      else text = "我是预言家。昨夜验的是" + target + "，是狼；" + voteWord + target + "。";
    } else if (name === "千春") {
      text = op + (respond ? respond + "，" : "") + fact + "。" + voteWord + target +
        (target === "池田" ? "。" : "，细节对不上。");
    } else if (name === "池田") {
      text = op.replace(/。$/, "，我确实急。") + (respond ? respond + "，" : "") + fact +
        ((g.day % 2 === 0) ? "；我也想过回到父母都在的时候。" : "；你先把矛头对准我，这不对。") + voteWord + target + "。";
    } else if (name === "茶终") {
      text = op + fact + "。" + voteWord + target + "。";
    } else if (name === "樱井") {
      text = "结论先给：" + fact + "。" + (respond ? respond + "，" : "") +
        "我解释一次，我" + voteWord.replace(/^我/, "") + target + "。";
    } else if (name === "小野") {
      text = (g.alive["幸子"] ? op : "幸子不在了，") + fact + "；错了就是错了，" + voteWord + target + "。";
    } else if (name === "幸子") {
      text = op + (g.alive["小野"] ? "妈妈，我会说清楚：" : "妈妈不在了，我更要说清楚：") + fact + "；" + voteWord + target + "。";
    } else {
      text = op + (respond ? respond + "，" : "") + fact + "。" +
        "理由只有一条：" + voteWord + target + "。";
    }
    text = text.replace(/。。+/g, "。").replace(/……。/g, "……");
    if (text.length > dayLineMax()) text = text.slice(0, dayLineMax() - 1) + "…";
    return {
      who: name, text: text, expr: randomExpr(), stance: mapStance(beat.stance) || "质疑",
      target: beat.target || "", respond: beat.respond || "",
      voteIntent: beat.voteIntent || beat.target || "",
      goal: beat.goal, claim: beat.claim, facts: beat.facts
    };
  }
  function runBeats(g, beats, label) {
    if (!beats.length) return Promise.resolve([]);
    var groups = [];
    var allWish = beats.every(function (b) { return b.goal === "愿望"; });
    var size = allWish ? beats.length : Math.max(1, Number((C.rules.ai || {}).day_group_size) || 3);
    for (var i = 0; i < beats.length; i += size) groups.push(beats.slice(i, i + size));
    return (async function () {
      var map = {}, prev = [];
      for (var gi = 0; gi < groups.length; gi++) {
        var grp = groups[gi];
        var lines = await aiBeatGroup(g, grp, false, prev);
        if (S !== g) return [];
        if (!lines || lines.length < grp.length) {
          if (api.calls < AI_MAX_CALLS) {
            var retry = await aiBeatGroup(g, grp, true, prev);
            if (S !== g) return [];
            if (retry && retry.length > (lines ? lines.length : 0)) lines = retry;
          }
        }
        (lines || []).forEach(function (L) { map[L.who] = L; if (!allWish) prev.push(L); });
        grp.forEach(function (b) { if (!map[b.who]) map[b.who] = fallbackBeatLine(g, b); });
      }
      var ordered = beats.map(function (b) { return map[b.who]; }).filter(Boolean);
      ordered.forEach(function (L) {
        if (L.target) g.targetHeat[L.target] = (g.targetHeat[L.target] || 0) + 1;
      });
      return ordered;
    })();
  }
  /* ---- 昼：AI 一次批量生成所有在场 NPC 的发言 ---- */
  function beginDaySpeech() {
    var g = S;
    if (!g || g.busy) return Promise.resolve();
    if (g.spoke) return Promise.resolve();
    var alive = aliveNpcs(g);
    if (!alive.length) { g.spoke = true; syncUI(); return Promise.resolve(); }
    setScene("bg_tea", "dawn");
    setBusy(true, "茶会正在盘算");
    return aiPlans(g).then(function (res) {
      if (S !== g) return;
      g.plans = res.plans;
      g.wolfChat = res.wolfChat;
      var beats = buildDayBeats(g);
      g.lastBeats = beats;
      return runBeats(g, beats, "昼").then(function (lines) {
        if (S !== g) return;
        setBusy(false);
        if (!lines || !lines.length) {
        lines = (g.lastBeats || []).map(function (b) { return fallbackBeatLine(g, b); });
      }
        return showLines(g, lines, 240).then(function () {
          if (S !== g) return;
          g.spoke = true;
          addLine(HOST, hostLine("day_open"), "host");
          syncUI();
          return null;
        });
      });
    });
  }

  /* ---- 投票 ---- */
  function beginVote() {
    var g = S;
    if (!g || g.busy || g.phase === "vote") return Promise.resolve();
    g.phase = "vote";
    g.playerVote = null;
    g.expel = null;
    g.tally = null;
    g.voteDetail = null;
    g.nextLabel = "";
    setScene("bg_tea", "dawn");
    addLine(HOST, hostLine("vote_open"), "host");
    g.npcVotes = normalizeVotes(g, null, g.plans);
    g.plannedVotes = clone(g.npcVotes);
    /* 测试用：window.MOMO_TEA_FORCE_VOTE = "千春" 时让 NPC 票集中到某人（仅 QA，不影响正常对局） */
    var fv = window.MOMO_TEA_FORCE_VOTE;
    if (fv && g.alive[fv]) {
      aliveNpcs(g).forEach(function (v) { if (v !== fv) g.npcVotes[v] = fv; });
    }
    g.voteLines = null;
    setBusy(false);
    syncUI();
    return Promise.resolve();
  }

  function castVote(target) {
    var g = S;
    if (!g || g.busy || g.phase !== "vote" || !g.alive[target] || target === P) return;
    g.playerVote = target;
    setBusy(true, "正在收票");
    return (async function () {
      await sleep(420);
      if (S !== g) return;
      var tally = {}, detail = {};
      Object.keys(g.npcVotes || {}).forEach(function (v) {
        if (!g.alive[v]) return;
        var t = g.npcVotes[v];
        if (t && g.alive[t] && t !== v) { tally[t] = (tally[t] || 0) + 1; detail[v] = t; }
      });
      tally[target] = (tally[target] || 0) + 1;
      detail[P] = target;
      g.tally = tally;
      g.voteDetail = detail;
      var max = -1, tops = [];
      Object.keys(tally).forEach(function (k) {
        if (tally[k] > max) { max = tally[k]; tops = [k]; }
        else if (tally[k] === max) tops.push(k);
      });
      var expel = tops.length === 1 && max > 0 ? tops[0] : null;
      var summary = Object.keys(detail).map(function (v) {
        return (v === P ? labelOf(P) : v) + "→" + (detail[v] === P ? labelOf(P) : detail[v]);
      }).join("　");
      addLine(null, "〔举盏〕" + summary, "sys");
      if (g.voteLines && g.voteLines.length) {
        g.voteLines.forEach(function (l) {
          addLine(l.who, l.text, l.who === HOST ? "host" : "line", l.expr, l.stance, l.target);
        });
      }
      var against = {};
      Object.keys(detail).forEach(function (v) {
        var t = detail[v];
        (against[t] = against[t] || []).push(v);
      });
      g.lastVotesAgainst = against;
      var shotDeaths = [];
      if (expel) {
        g.expel = { who: expel };
        kill(g, expel, "vote");
        shotDeaths.push({ who: expel, cause: "vote" });
        addLine(HOST, hostLine("vote_out", { who: labelOf(expel) }), "host");
        sfx("sfx-wrong");
      } else {
        addLine(HOST, hostLine("vote_none"), "host");
      }
      /* 狼王/猎人被放逐 → 带人；玩家是狼王/猎人时在这里点卡 */
      await resolveDeathShots(g, shotDeaths, "vote");
      if (S !== g) return;
      setBusy(false);
      if (expel === P) return beginEnding("player_out");
      if (!g.alive[P]) return beginEnding("player_shot");
      var wn = winnerNow(g);
      if (wn) {
        g.gameWinner = wn;
        g.pendingWinner = wn;
        g.nextLabel = "听月见收束 ▶";
        g.phase = "result";
        syncUI();
        return null;
      }
      if (g.day >= maxDays()) {
        g.pendingWinner = "judge";
        g.phase = "result";
        g.nextLabel = "听月见收束 ▶";
        syncUI();
        return null;
      }
      g.phase = "result";
      g.nextLabel = "下一夜 ▶";
      syncUI();
      return null;
    })();
  }

  function afterResult() {
    var g = S;
    if (!g || g.busy) return Promise.resolve();
    if (g.pendingWinner) return beginEnding(g.pendingWinner);
    if (g.day >= maxDays()) return beginEnding("judge");
    return beginNight(g.day + 1);
  }

  /* ---- 结局 ---- */
  /* 收尾剧情：不交给模型，固定演出，保证每局都有完整落点。
     不再出现“末茶/递茶/愿望被听见”；愿望只作为月见口中的一句规矩。 */
  function fixedEnding(g, kind) {
    var H = HOST, M = "墨墨";
    var E = {
      guest_win: {
        title: "茶散，灯明",
        lines: [
          { who: H, text: "三只狼，都离席了。茶会，到这儿。", expr: "眯眼笑" },
          { who: H, text: "赢的人可以许一个愿。不过今晚，我劝你们别急着用。", expr: "默认" },
          { who: M, text: "……许愿就免了。先把人送回去。", expr: "不悦" },
          { who: H, text: "桥上的灯，已经亮了。", expr: "眯眼笑" },
          { who: null, text: "烛火一盏一盏灭下去。长桌、茶具、八把椅子，像被谁从底下抽走了。", expr: null },
          { who: M, text: "抓住我。别回头。", expr: "欲言又止" }
        ]
      },
      fox_win: {
        title: "茶凉之前",
        lines: [
          { who: H, text: "狼还在席上。今夜，算你们赢。", expr: "眯眼笑" },
          { who: H, text: "输的人，留下来陪我喝茶——这是规矩。", expr: "默认" },
          { who: M, text: "……喂。别闭眼。抓住我。", expr: "惊讶" },
          { who: null, text: "茶水漫上来的时候，你听见她在骂你。骂得很轻。", expr: null },
          { who: H, text: "下一次，别信错人。", expr: "眯眼笑" }
        ]
      },
      judge: {
        title: "月见裁",
        lines: [
          { who: H, text: "四天。狼未现形。", expr: "默认" },
          { who: H, text: "那这一盏，我来裁。", expr: "眯眼笑" },
          { who: M, text: "……裁什么裁。你先把我们送回去。", expr: "不悦" },
          { who: H, text: "裁完了。灯在桥上。", expr: "眯眼笑" },
          { who: null, text: "他抬手，最后一盏茶自己翻倒。茶水落地，却没有声音。", expr: null }
        ]
      },
      player_out: {
        title: "请你离席",
        lines: [
          { who: H, text: "你，请离席。", expr: "默认" },
          { who: M, text: "……谁准你走的。", expr: "不悦" },
          { who: null, text: "她的声音被茶雾隔开。你往下沉，手里还攥着那只空杯。", expr: null },
          { who: H, text: "茶会，继续。", expr: "眯眼笑" }
        ]
      },
      player_night: {
        title: "空盏",
        lines: [
          { who: H, text: "你的盏，空了。茶会……继续。", expr: "默认" },
          { who: M, text: "……笨蛋。谁让你闭眼的。", expr: "悲伤" },
          { who: null, text: "黑暗里，有人攥住你的手腕。很紧。", expr: null }
        ]
      },
      player_shot: {
        title: "枪响之后",
        lines: [
          { who: H, text: "枪响之前，茶已经凉了。", expr: "默认" },
          { who: M, text: "……谁让你站那么近的。", expr: "悲伤" },
          { who: null, text: "你最后看见的，是她踢翻椅子冲过来的影子。", expr: null }
        ]
      }
    };
    var e = E[kind] || E.judge;
    var lines = (e.lines || []).map(function (l) {
      return { who: l.who, text: l.text, expr: l.expr || "默认" };
    });
    return { title: e.title || "茶散灯明", lines: lines };
  }

  function beginEnding(kind) {
    var g = S;
    if (!g || !kind) return Promise.resolve();
    if (g.phase === "ending") return Promise.resolve();
    g.phase = "ending";
    g.winner = kind;
    g.ended = true;
    setScene("cg_lamp");
    addLine(null, "——", "narr");
    setBusy(true, "茶会正在收束");
    return Promise.resolve(fixedEnding(g, kind)).then(function (res) {
      if (S !== g) return;
      g.ending = { title: res.title || "", lines: res.lines };
      setBusy(false);
      return showLines(g, res.lines, 520).then(function () {
        if (S !== g) return;
        /* 结局即落档：lit / ch1_done（toast 留给「点灯」动作，已亮则不再发） */
        g.lampFirst = applyLamp();
        syncUI();
        showEndPanel(g);
        sfx("sfx-award");
        return null;
      });
    });
  }

  function endingLabel(kind) {
    var e = (C.endings || {})[kind];
    return (e && e.label) || ({
      guest_win: "狼被找齐了",
      fox_win: "狼混过了这一夜",
      judge: "月见裁",
      player_out: "你在席上被请离",
      player_night: "你在夜里离席",
      player_shot: "你在席间被带走",
      player_knife: "你的茶盏空了"
    })[kind] || "茶会散了";
  }

  function fallbackEnding(g, kind) {
    var e = (C.endings || {})[kind] || (DEFAULT.endings || {})[kind] || {};
    var vars = {
      player: labelOf(P),
      day: g.day,
      host: HOST
    };
    var lines = (e.lines || []).map(function (l) {
      return { who: l.who || HOST, text: fillTemplate(l.text || "", vars) };
    });
    if (!lines.length) {
      lines = [
        { who: HOST, text: "茶会，散了。" },
        { who: "墨墨", text: "……哼。回家吧。" }
      ];
    }

    return { title: e.label || "茶会散了", lines: lines };
  }

  function showEndPanel(g) {
    if (!els.endmask) return;
    var label = endingLabel(g.winner);
    var title = (g.ending && g.ending.title) || label;
    var litText = g.wasLit ? "心之桥 · 第 1 盏灯「勇气」早已亮着" : "心之桥 · 待点灯";
    els.endmask.innerHTML =
      '<div class="tea-endcard' + (g.wasLit ? " lighted" : "") + '" id="tea-endcard">' +
        '<div class="tea-endglow"></div>' +
        '<div class="tea-end-kicker">月 见 茶 会 · 终</div>' +
        '<h2>' + esc(title) + "</h2>" +
        '<div class="tea-end-sub">' + esc(label) + " · 第 " + g.day + " 天" + (window.MOMO_TEA_DEBUG ? (" · 本局 AI 调用 " + api.calls + " 次") : "") + "</div>" +
        '<div class="tea-end-ident">你的身份：' + esc(roleLabel(g.roles[P])) + "</div>" +
        '<div class="tea-end-tea">' + esc(g.playerAlive ? "你还坐在席上。" : "你已经离席。") + "</div>" +
        '<div class="tea-end-lamp">' + esc(litText) + "</div>" +
        '<div class="tea-end-actions">' +
          '<button type="button" class="tea-btn primary" id="tea-lamp">' + (g.wasLit ? "回主画面" : "点灯 · 收席") + "</button>" +
          '<button type="button" class="tea-btn" id="tea-again">再来一局</button>' +
        "</div>" +
      "</div>";
    els.endmask.classList.remove("hidden");
    var lamp = document.getElementById("tea-lamp");
    var again = document.getElementById("tea-again");
    if (lamp) lamp.addEventListener("click", onLampClick);
    if (again) again.addEventListener("click", onAgainClick);
  }

  function onAgainClick() {
    if (!S) return;
    newGame();
  }

  function onLampClick() {
    var g = S;
    if (!g) return;
    if (g.lamped) return;
    g.lamped = true;
    var first = !g.wasLit;
    var card = document.getElementById("tea-endcard");
    if (card) card.classList.add("lighted");
    if (first) {
      g.lampFirst = applyLamp();
      if (!g.toasted) {
        g.toasted = true;
        toast("心之桥 · 第 1 盏灯「勇气」已点亮");
        sfx("sfx-award");
      }
    } else {
      applyLamp();
    }
    /* QA P1：点灯后的延时如果在新一局开始后才执行，会把新局浮层 stop 掉。
       所有延时都记到本局的 lampTimers，并在回调里检查「还是这一局」。 */
    var t1 = setTimeout(function () {
      if (S !== g) return;
      try { if (window.MomoUI && window.MomoUI.show) window.MomoUI.show("主画面"); } catch (e) {}
      var t2 = setTimeout(function () { if (S === g) stop(); }, isDebug() ? 0 : 900);
      (g.lampTimers = g.lampTimers || []).push(t2);
    }, isDebug() ? 0 : (first ? 1500 : 400));
    (g.lampTimers = g.lampTimers || []).push(t1);
  }

  /* ============================================================
     九、AI 调用（SSE 解析 / 15s 超时 / 重连一次 / JSON 容错）
     ============================================================ */
  function parseJSON(text) {
    if (!text) return null;
    var s = String(text).replace(/```json/gi, "```").replace(/```/g, "").trim();
    var i = s.indexOf("{"), j = s.lastIndexOf("}");
    if (i < 0 || j <= i) return null;
    var frag = s.slice(i, j + 1);
    try { return JSON.parse(frag); } catch (e) {}
    try {
      return JSON.parse(frag.replace(/,\s*([}\]])/g, "$1").replace(/[\u201c\u201d]/g, '"'));
    } catch (e) {}
    return null;
  }

  function callAI(g, system, user, maxTokens) {
    if (window.MOMO_TEA_OFFLINE || !window.fetch) return Promise.resolve(null);
    if (api.calls >= AI_MAX_CALLS) return Promise.resolve(null);
    api.calls++;
    if (g) g.aiCalls++;
    var started = Date.now();
    var text = "";
    var attemptNo = 0;
    var settled = false;
    return new Promise(function (resolve) {
      function finish(ok) {
        if (settled) return;
        settled = true;
        api.ms.push(Date.now() - started);
        if (!ok) api.fails++;
        var out = (text || "").trim();
        if (out) api.lastRaw = out.slice(0, 4000);
        resolve(ok && out ? out : null);
      }
      function attempt() {
        if (settled) return;
        var left = AI_TOTAL_TIMEOUT - (Date.now() - started);
        if (left <= 300) return finish(false);
        var ctrl = null;
        try { ctrl = window.AbortController ? new AbortController() : null; } catch (e) {}
        api.requests++;
        var base = "", got = false;
        var hard = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (e) {} }, left);
        var watch = setTimeout(function () { if (!got) { try { if (ctrl) ctrl.abort(); } catch (e) {} } },
          Math.min(AI_FIRST_WAIT, left - 300));
        function cleanup() { clearTimeout(hard); clearTimeout(watch); }
        function failed() {
          cleanup();
          if (settled) return;
          if (attemptNo === 0 && text === "") {
            attemptNo = 1;
            text = "";
            setTimeout(attempt, 120);
          } else {
            finish(false);
          }
        }
        var opt = {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify({
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            max_tokens: maxTokens || 800,
            response_format: { type: "json_object" }
          })
        };
        if (ctrl) opt.signal = ctrl.signal;
        fetch(endpoint(), opt).then(function (res) {
          if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
          var ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
          if (ct.indexOf("application/json") >= 0 && ct.indexOf("event-stream") < 0) {
            return res.text().then(function (t) {
              var o = null;
              try { o = JSON.parse(t); } catch (e) {}
              var c = o && o.choices && o.choices[0];
              var v = (c && ((c.message && c.message.content) || c.text)) || (o && o.content) || "";
              cleanup();
              if (typeof v === "string" && v.trim()) { text = v; finish(true); }
              else finish(false);
            });
          }
          var reader = res.body.getReader();
          var dec = new TextDecoder("utf-8");
          var buf = "";
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) return null;
              buf += dec.decode(r.value, { stream: true });
              var parts = buf.split("\n");
              buf = parts.pop();
              for (var i = 0; i < parts.length; i++) {
                var line = parts[i].trim();
                if (!line || line.slice(0, 5) !== "data:") continue;
                var pay = line.slice(5).trim();
                if (!pay || pay === "[DONE]") continue;
                try {
                  var o = JSON.parse(pay);
                  if (o && o.error) continue;
                  var c = o.choices && o.choices[0];
                  var d = c && (c.delta || c.message);
                  var piece = (d && d.content) || (c && c.text) || "";
                  if (typeof piece === "string" && piece) {
                    got = true;
                    clearTimeout(watch);
                    base += piece;
                  }
                } catch (e) { /* 半行 / 心跳 */ }
              }
              return pump();
            });
          }
          return pump().then(function () {
            cleanup();
            if (base.trim()) { text = base; finish(true); }
            else finish(false);
          });
        })["catch"](function () { failed(); });
      }
      attempt();
    });
  }

  /* ---- 提示词：全部从配置读，不写死关系 ---- */
  /* ============================================================
     九、提示词与生成策略（质量优先：每人一句、必须表态、必须点名）
     ============================================================ */
  function expressions() {
    return C.rules.expressions || ["默认", "眯眼笑", "不悦", "惊讶", "悲伤", "害羞", "欲言又止", "低头落寞"];
  }
  function stances() {
    return C.rules.stances || ["质疑", "辩护", "站边", "观察", "带节奏", "自保"];
  }
  function bannedTerms() {
    return C.rules.banned_terms || ["执念", "暗线", "人设", "AI", "system", "JSON", "旁白"];
  }
  function dayLineMax() { return (C.rules.ai && C.rules.ai.day_line_max) || 90; }
  function endingLineMax() { return (C.rules.ai && C.rules.ai.ending_line_max) || 70; }
  function playerTalkCap() { return (C.rules.ai && C.rules.ai.player_input_calls) || 2; }
  function dayGroups() { return Math.max(1, Number((C.rules.ai || {}).day_groups) || 2); }

  function baseSystem() {
    var core = C.core || "";
    return "你是文字冒险《墨墨的洋馆》第一章《月见茶会》的对局对话引擎。你在替几位 NPC 扮演一场高智商狼人杀，玩家固定是村民。\n" +
      "【核心】" + core + "\n" +
      "【铁律】\n" +
      "1. 只有你知道全部身份；玩家看不到 NPC 身份。台词里绝不能直接宣布谁是什么身份，也不能提 AI／JSON／系统／提示词／执念／暗线／人设。\n" +
      "2. 每个角色只能使用自己知道的信息：狼只知道狼同伴；预言家只知道自己的验人；女巫只知道自己的药；猎人/村民只知道公开信息。不要用上帝视角。\n" +
      "3. 每条发言必须第一人称、1~2 句、结合当前局面（昨夜谁离席、谁被怀疑、上一轮谁说了什么/投了谁），至少给出一个具体判断/质问/辩护/站边，并点名 target。\n" +
      "4. 不能复读、不能空话、不能写旁白或心理活动、不能照念人物设定；狼要撒谎带节奏，预言家可跳可藏，女巫/猎人按人设藏身份。\n" +
      "5. 【记忆分层】你只拥有：本角色的私密记忆（身份/狼同伴/验人/药/执念与暗线）+ 公开记忆（在场、离席、公开发言、票型、公开结果）。不要使用上帝视角，不要知道别人的隐藏身份或夜间行动。\n" +
      "6. 【计划-发言】每次开口前先在心里定好意图（要让谁被怀疑/替谁辩护/报什么信息/藏什么），再写台词；只输出台词，不输出计划。\n" +
      "7. 【反思】上一轮谁投了你、谁替你说话、谁在带节奏——这一句必须对此做出回应；投票与夜间行动由引擎决定，你只负责让台词符合自己的立场与视角。\n" +
      "8. 禁止用编号/座位号称呼人（不许出现阿拉伯数字、X号、座位），一律用名字：千春/池田/茶终/樱井/小野/幸子/墨墨/月见/你。\n" +
      "9. 禁止 AI 套话（我认为/从逻辑上看/首先/其次/综上所述）；口语、第一人称；必须回应上一句点你/怀疑你的人，没有就回应上一位发言者；至少点名一个具体角色+一个具体事实（死亡/票型/改口/保人），并明确站边和今天票意图。\n" +
      "10. 每句话必须自然体现「性格镜头」的关注点/偏见/攻击方式（不能只写“我觉得/我投X”），不要念设定；禁止听水/水声/听停顿/听人心/听心跳等灵异化描写。\n" +
      "11. 禁止固定梗：杯子/座位/挡话/听水/时间线/编号/第几位/记下；禁止“你急着点我/反应太干净/先看谁坐不住”这类同款狼人杀模板句。每个角色必须用自己的关注点说话；同一角色不要连着两轮用同一种开头/句式。\n";
  }
  function rolePrivateText(g, name) {
    var role = g.roles[name];
    if (isWolfRole(role)) {
      var mates = g.wolves.filter(function (k) { return k !== name; });
      return "身份：" + roleLabel(role) + "（狼同伴：" + (mates.length ? mates.join("、") : "无") + "）" +
        (role === "wolf_king" ? "；你被刀/被放逐时可带走一人（被毒不触发）" : "") + "。";
    }
    if (role === "seer") {
      var cs = g.seerChecks.map(function (c) {
        return "第" + c.day + "夜验" + c.who + "=" + (c.isWolf ? "狼" : "好人");
      });
      return "身份：预言家（" + (cs.length ? cs.join("；") + "；" : "还没有验人结果；") + "只有你知道）。";
    }
    if (role === "witch") {
      return "身份：女巫（解药 " + g.witchPotions.antidote + "、毒药 " + g.witchPotions.poison +
        "；一晚只能用一瓶；解药只救狼刀，毒药第2夜起可用；只有你知道）。";
    }
    if (role === "hunter") return "身份：猎人（被刀/被放逐可开枪；被毒死不能；只有你知道）。";
    return "身份：村民（没有夜间信息）。";
  }
  function compactChar(name) {
    var c = char(name);
    var bits = [];
    if (c.tagline) bits.push(c.tagline);
    if (c.relations) bits.push("关系：" + relationsText(c));
    if (c.voice) bits.push("说话：" + c.voice);
    if (c.taboos && c.taboos.length) bits.push("禁忌：" + taboosText(c));
    if (c.obsession) bits.push("执念：" + c.obsession);
    if (c.secret) bits.push("暗线：" + c.secret);
    var t = bits.join("；");
    return t.length > 260 ? t.slice(0, 259) + "…" : t;
  }
  function charBlock(g) {
    var arr = ["【私密记忆 · 仅本角色自己可见】"];
    SEATS.forEach(function (k) {
      if (k === P) {
        arr.push("· " + labelOf(k) + "（玩家，身份：" + roleLabel(g.roles[P]) + "，不使用未公开信息）：" + compactChar(k) + " 性格镜头：" + lensOf(k));
        return;
      }
      arr.push("· " + k + "｜" + rolePrivateText(g, k) + " 人设：" + compactChar(k) +
        " 性格镜头：" + lensOf(k) +
        " 当前行为：" + (isFox(g, k) ? (char(k).fox_behavior || "") : (char(k).guest_behavior || "")));
    });
    arr.push("· " + HOST + "（主持，永远不是狼，不投票）：" + compactChar(HOST));
    return arr.join("\n");
  }
  function publicHistory(g, limit) {
    var rows = (g.log || []).filter(function (e) {
      return (e.kind === "line" || e.kind === "host" || e.kind === "you" || e.kind === "reveal") && e.text;
    }).slice(-(limit || 12));
    return rows.map(function (e) {
      var who = e.kind === "you" ? labelOf(P) : (e.who === P ? labelOf(P) : (e.who || "茶会"));
      var extra = [];
      if (e.stance) extra.push(e.stance);
      if (e.target) extra.push("→" + e.target);
      return (e.day ? "D" + e.day + " " : "") + who +
        (extra.length ? "（" + extra.join(" ") + "）" : "") + "：" + String(e.text).slice(0, 110);
    }).join("\n");
  }
  function boardBlock(g) {
    var alive = aliveAll(g);
    var gone = Object.keys(g.dead || {}).map(function (k) {
      return nameOf(k) + "（" + ({ vote: "被放逐", knife: "夜里离席", poison: "夜里离席", shot: "席间被带走" }[g.dead[k]] || "离席") + "）";
    });
    var s = ["【公开记忆 · 所有人可见】第 " + g.day + " 天 · " + ({
      open: "开场", night: "夜", day: "白天发言", vote: "投票", result: "揭晓", ending: "结局"
    }[g.phase] || g.phase) + "。"];
    s.push("在场：" + alive.map(function (k) { return k === P ? labelOf(P) + "（玩家）" : k; }).join("、") + "。");
    if (gone.length) s.push("已离席：" + gone.join("、") + "。");
    var n = g.lastNight;
    if (n && (n.deaths || []).length) {
      s.push("昨夜公开结果：" + n.deaths.map(nameOf).join("、") + " 离席" +
        ((n.shots || []).length ? "；" + n.shots.map(function (x) { return nameOf(x.who) + "带走" + nameOf(x.target); }).join("；") : "") +
        "。（只能使用这个公开事实，不要虚构其他人的死亡/离席）");
    } else if (n) {
      s.push("昨夜公开结果：无人离席。（公开事实：不要虚构任何人死亡/离席）");
    }
    if (g.voteDetail && Object.keys(g.voteDetail).length) {
      s.push("上一轮投票：" + Object.keys(g.voteDetail).map(function (v) {
        return nameOf(v) + "→" + nameOf(g.voteDetail[v]);
      }).join("　") + "。");
    }
    var hist = publicHistory(g, 12);
    if (hist) s.push("【最近公开发言】\n" + hist);
    s.push("【阶段目标】" + (g.phase === "vote" ? "说服别人/决定票；狼可以带票。"
      : "找出狼、表明立场、回应上一轮对你的怀疑。"));
    return s.join("\n");
  }

  /* QA P0：lines 被写成字符串也不能抛异常 */
  function modelLines(o) {
    if (!o) return null;
    var arr = o.lines || o.utterances || o.dialogues || o.speeches || o.replies || o.data || o.records;
    if (!arr && Array.isArray(o)) arr = o;
    if (typeof arr === "string") {
      var speaker = o.speaker || o.who || o.name || o.role || "";
      var rows = [];
      if (/[\n：:]/.test(arr)) {
        String(arr).split(/\n+/).forEach(function (line) {
          line = line.trim();
          if (!line) return;
          var m = line.match(/^([^：:]{1,8})[：:]\s*(.+)$/);
          if (m) rows.push({ who: m[1].trim(), text: m[2].trim() });
          else rows.push({ who: speaker, text: line });
        });
      } else {
        rows.push({ who: speaker, text: arr });
      }
      arr = rows;
    }
    if (!Array.isArray(arr)) {
      if (isObj(o)) {
        var keys = Object.keys(o).filter(function (k) { return C.characters[k] && typeof o[k] === "string"; });
        arr = keys.length ? keys.map(function (k) { return { who: k, text: o[k] }; }) : [];
      } else {
        arr = [];
      }
    }
    return arr.map(function (x) {
      if (typeof x === "string") return { who: o.speaker || o.who || "", text: x };
      if (!isObj(x)) return null;
      return {
        who: x.who || x.speaker || x.name || x.role || x.character || "",
        text: x.text || x.line || x.content || x.say || x.dialogue || x.utterance || "",
        expr: x.expr || x.expression || x.emotion || "",
        stance: x.stance || x.attitude || "",
        target: x.target || x.point || x.at || ""
      };
    }).filter(Boolean);
  }
  function normText(t) {
    return String(t || "").replace(/[\s，。！？、；：""''…—,.!?;:]/g, "").slice(0, 24);
  }
  function normalizeName(n) {
    n = String(n || "").trim();
    if (!n) return "";
    if (n === "你" || n === "玩家" || n === "末茶人" || n === "客人") return P;
    if (n === "月见" || n === "主持人") return HOST;
    for (var i = 0; i < SEATS.length; i++) {
      var k = SEATS[i];
      if (n === k || n === char(k).label || n === char(k).name) return k;
    }
    if (n === char(HOST).label || n === char(HOST).name) return HOST;
    return n;
  }

  function mapExpr(expr) {
    var E = expressions(), e = String(expr || "").trim();
    if (E.indexOf(e) >= 0) return e;
    if (/笑|微笑|浅笑|嗤笑|含笑/.test(e)) return "眯眼笑";
    if (/怒|不悦|冷|沉|皱眉|警告|压/.test(e)) return "不悦";
    if (/惊|震/.test(e)) return "惊讶";
    if (/悲|痛|落寞|低落/.test(e)) return "悲伤";
    if (/羞|脸红|赧/.test(e)) return "害羞";
    if (/欲言|犹豫|欲止|迟疑/.test(e)) return "欲言又止";
    if (/低|垂|沉默|疲惫/.test(e)) return "低头落寞";
    return "默认";
  }
  function mapStance(st) {
    var S2 = stances(), x = String(st || "").trim();
    if (S2.indexOf(x) >= 0) return x;
    if (/^信|站边|支持/.test(x)) return "站边";
    if (/^不信|怀疑|不信/.test(x)) return "质疑";
    if (/疑|试探|施压|质问|反指|盘/.test(x)) return "质疑";
    if (/辩|解释|反驳|澄清/.test(x)) return "辩护";
    if (/站|支持|附议/.test(x)) return "站边";
    if (/观望|中立|观察|记/.test(x)) return "观察";
    if (/节奏|煽|引|带/.test(x)) return "带节奏";
    if (/自保|防御|转移|反击/.test(x)) return "自保";
    return "观察";
  }

  function deathClaimBad(g, who, text) {
    var deaths = (g.lastNight && g.lastNight.deaths) || [];
    var hard = /(离席|死了|被刀|被毒|出局|尸体)/;
    var absence = /(没来|没露面|没到场|未到|缺席|失踪|早退)/;
    if (!deaths.length) {
      if (absence.test(text)) return true;
      if (hard.test(text) && !/无人离席|没有离席/.test(text)) return true;
    }
    var bad = false;
    aliveAll(g).forEach(function (k) {
      if (k === who) return;
      var idx = text.indexOf(k);
      if (idx < 0) return;
      var tail = text.slice(idx + k.length, idx + k.length + 10);
      if (hard.test(tail) || absence.test(tail)) bad = true;
    });
    if (who !== HOST && /月见(说|却|提到|告诉)/.test(text)) bad = true;
    return bad;
  }

  function validateLines(g, arr, allowedWho, opt) {
    opt = opt || {};
    var EXPR = expressions(), ST = stances(), BAN = bannedTerms();
    var out = [];
    var seen = (g.log || []).slice(-36).map(function (e) { return normText(e.text); });
    if (!Array.isArray(arr)) return out;
    arr.slice(0, opt.limit || 8).forEach(function (x) {
      if (!x) return;
      var who = normalizeName(String(x.who || "").trim());
      if (!who || (allowedWho && allowedWho.indexOf(who) < 0)) return;
      if (who !== HOST && !g.alive[who]) return;
      var text = String(x.text || "").replace(/\s*\n+\s*/g, " ").trim();
      var min = opt.min || Number((C.rules.quality || {}).min_line_chars) || 6;
      if (text.length < min) return;
      var max = opt.max || dayLineMax();
      if (text.length > max) text = text.slice(0, max - 1) + "…";
      if (/^[（(]/.test(text)) return;                 /* 旁白 */
      if (/```|https?:|\bJSON\b|\bsystem\b/i.test(text)) return;
      for (var bi = 0; bi < BAN.length; bi++) {
        if (BAN[bi] && text.indexOf(BAN[bi]) >= 0) return;
      }
      if (deathClaimBad(g, who, text)) return;
      if (who !== HOST && /主持/.test(text)) return;
      if (/[0-9０-９]/.test(text) || text.indexOf("号") >= 0 || text.indexOf("座位") >= 0) return;
      var bans2 = (C.rules.speech_bans || []);
      for (var bj = 0; bj < bans2.length; bj++) if (bans2[bj] && text.indexOf(bans2[bj]) >= 0) return;
      var key = normText(text);
      if (!key || seen.indexOf(key) >= 0) return;
      seen.push(key);
      var expr = mapExpr(x.expr);
      var stance = mapStance(x.stance);
      var target = normalizeName(String(x.target || "").trim());
      if (target === "你" || target === "玩家") target = P;
      if (target && target !== "众人" && target !== HOST && target !== P) {
        if (!g.alive[target] || target === who) target = "";
      }
      out.push({ who: who, text: text, expr: expr, stance: stance, target: target });
    });
    return out;
  }

  function speechPrompt(g, group) {
    var sys = baseSystem() + charBlock(g) + "\n" + boardBlock(g) + "\n" +
      "【本轮只写这些 NPC 的发言】" + group.join("、") + "。每人 1 句，按这个顺序。\n" +
      "【输出】只输出严格 JSON：{\"lines\":[{\"who\":\"千春\",\"text\":\"池田，你从刚才起就在躲我的问题——你在怕什么？\",\"expr\":\"眯眼笑\",\"stance\":\"质疑\",\"target\":\"池田\"}]}\n" +
      "expr 只能从：" + expressions().join("/") + "；stance 只能从：" + stances().join("/") + "；" +
      "target 必须是当前在场者的名字或「众人」；text 必须 1~2 句、第一人称、不超过 " + dayLineMax() +
      " 字、点名目标、基于当前局面；不能旁白、不能念设定、不能复读。";
    var user = "第 " + g.day + " 天" + (g.phase === "vote" ? "投票前" : "白天") +
      "。请让 " + group.join("、") + " 依次发言：每句都要针对当前局面（昨夜离席、上一轮发言/投票、谁被怀疑）给出具体判断/质问/辩护/站边。只输出 JSON。";
    return { sys: sys, user: user };
  }
  function aiSpeechGroup(g, group, retry) {
    var pr = speechPrompt(g, group);
    if (retry) pr.user += "\n上一次输出不合格（格式错/空话/复读）。这次必须严格按 schema、每人一句、点名 target。";
    return callAI(g, pr.sys, pr.user, 900).then(function (t) {
      var o = parseJSON(t);
      if (!o) { api.parseFails++; return null; }
      var lines = validateLines(g, modelLines(o), group, { max: dayLineMax(), limit: group.length });
      return lines.length ? lines : null;
    })["catch"](function () { api.parseFails++; return null; });
  }

  function aiDaySpeech(g) {
    var alive = aliveNpcs(g);
    if (!alive.length) return Promise.resolve([]);
    var groups = [];
    var n = dayGroups();
    var size = Math.ceil(alive.length / n);
    for (var i = 0; i < alive.length; i += size) groups.push(alive.slice(i, i + size));
    return (async function () {
      var map = {};
      for (var gi = 0; gi < groups.length; gi++) {
        var gl = groups[gi];
        var lines = await aiSpeechGroup(g, gl, false);
        if (S !== g) return [];
        if (!lines || lines.length < Math.max(1, gl.length - 1)) {
          if (api.calls < AI_MAX_CALLS) {
            var retryLines = await aiSpeechGroup(g, gl, true);
            if (S !== g) return [];
            if (retryLines && retryLines.length > (lines ? lines.length : 0)) lines = retryLines;
          }
        }
        (lines || []).forEach(function (L) { map[L.who] = L; });
        gl.forEach(function (name) {
          if (!map[name]) map[name] = fallbackLineFor(g, name);
        });
      }
      return alive.map(function (name) { return map[name]; }).filter(Boolean);
    })();
  }

  function aiVote(g) {
    var alive = aliveNpcs(g);
    var sys = baseSystem() + charBlock(g) + "\n" + boardBlock(g) + "\n" +
      "【输出】只输出一个 JSON 对象，不要 markdown：{\"votes\":{\"千春\":\"池田\",\"池田\":\"千春\"},\"lines\":[{\"who\":\"小野\",\"text\":\"我盯她很久了。\",\"expr\":\"不悦\",\"stance\":\"质疑\",\"target\":\"千春\"}]}\n" +
      "votes 的键必须是这些在场 NPC：" + alive.join("、") + "；每人一票；不能投自己/主持人/已离席者；可以投玩家。" +
      "lines 是 1~4 句投票理由（可省略），规则同发言：第一人称、点名对象、不旁白、不复读。";
    var user = "第 " + g.day + " 天投票。请让每位在场 NPC 基于本轮公开发言、上一轮投票和自己的立场/身份决定这一票；狼尽量不投狼（可牺牲同伴洗白），好人按怀疑投。只输出 JSON。";
    return callAI(g, sys, user, 700).then(function (t) {
      var o = parseJSON(t);
      if (!o) { api.parseFails++; return null; }
      var v = o.votes || o.vote || o.ballots || o.result;
      if (Array.isArray(v)) {
        var m = {};
        v.forEach(function (x) {
          if (!isObj(x)) return;
          var who = x.who || x.voter || x.name || x.from;
          var to = x.target || x.to || x.vote || x.choose;
          if (who && to) m[who] = to;
        });
        v = m;
      }
      if (!isObj(v) || !Object.keys(v).length) { api.parseFails++; return null; }
      o.votes = v;
      o.lines = validateLines(g, modelLines(o), alive, { max: dayLineMax(), limit: 4 });
      return o;
    })["catch"](function () { api.parseFails++; return null; });
  }

  function aiReply(g, text) {
    var alive = aliveNpcs(g).concat([HOST]);
    var sys = baseSystem() + charBlock(g) + "\n" + boardBlock(g) + "\n" +
      "【输出】只输出严格 JSON：{\"lines\":[{\"who\":\"墨墨\",\"text\":\"……哼，你自己不会递茶吗？\",\"expr\":\"不悦\",\"stance\":\"辩护\",\"target\":\"你\"}]}\n" +
      "只让 1~2 位与这句话最相关的在场 NPC 接话（优先被点名的人；否则墨墨/当前被怀疑者）。\n" +
      "【输出格式】不要 JSON、不要解释，每个 NPC 一行：who｜台词｜表情｜立场｜对象。每人 1 句、第一人称、必须点到玩家或具体对象、可以反驳/护人/带节奏；不能旁白、不能复读、不能念设定。";
    var ps = g.playerStance;
    var stanceBit = ps ? ("玩家公开表态：" + (ps.trust ? "信" + nameOf(ps.trust) + "；" : "") +
      (ps.accuse ? "点" + nameOf(ps.accuse) + "；" : "") + (ps.vote ? "投" + nameOf(ps.vote) + "；" : "") +
      "被点到的人必须直接回应。") : "";
    var user = "玩家（" + labelOf(P) + "，村民）刚说：「" + text + "」。" + stanceBit +
      "请让 1~2 位最相关的在场 NPC 回应（优先被点名者）。只输出 JSON。";
    return callAI(g, sys, user, 600).then(function (t) {
      var arr = modelLinesFromAny(t);
      if (!arr || !arr.length) { api.parseFails++; return null; }
      var lines = validateLines(g, arr, alive, { max: dayLineMax(), limit: 2 });
      return lines.length ? lines : null;
    })["catch"](function () { api.parseFails++; return null; });
  }

  function aiEnding(g, kind) {
    var sys = baseSystem() + charBlock(g) + "\n" + boardBlock(g) + "\n" +
      "【结局】" + endingLabel(kind) + "。" +
      (g.playerAlive ? "玩家还坐在席上。" : "玩家已经离席。") + "\n" +
      "请以月见的视角写 3~6 句收束（胜负有定，或开放）：可以点到 1~2 位角色的愿望/暗线与茶会之后，但不要直接宣布任何 NPC 的身份/角色，禁止提 AI；" +
      "最后点出茶会散去、心之桥上的第一盏灯亮起。\n" +
      "【输出】只输出 JSON：{\"title\":\"茶散灯明\",\"lines\":[{\"who\":\"月见\",\"text\":\"茶会，散了。\",\"expr\":\"默认\"}]}。lines 是对象数组。";
    var user = "请为这一局写结局。只输出 JSON。";
    return callAI(g, sys, user, 700).then(function (t) {
      var arr = modelLinesFromAny(t);
      if (!arr || !arr.length) { api.parseFails++; return null; }
      var allowed = SEATS.concat([HOST]);
      var lines = validateLines(g, arr, allowed, { max: endingLineMax(), limit: 6, min: 2 });
      if (!lines.length) return null;
      return { title: String(o.title || "").slice(0, 12), lines: lines };
    })["catch"](function () { api.parseFails++; return null; });
  }

  /* ---- 本地兜底：断网/解析失败时仍要有人味、有对象、有立场 ---- */
  var SAFE_LINES = {
    "千春": ["我听完了，再说判断。", "池田，你手在抖。", "这地方不对。"],
    "池田": ["谁把我弄来的。", "别看我！", "我不是被吓大的。"],
    "茶终": ["茶还热。急什么。", "先坐。", "慌，茶会洒。"],
    "樱井": ["结论我先给。", "你在解释动机。", "我不喜欢这种场合。"],
    "小野": ["坐直了说。", "幸子，抬头。", "错了就是错了。"],
    "幸子": ["我只说一处。", "妈妈，我会说清楚。", "对不起，我、我想确认。"],
    "墨墨": ["说重点。", "先听。", "茶凉了。散吧。"],
    "月见": ["夜了。", "茶续上。", "举盏。"]
  };
  var REPLY_LINES = {
    "千春": ["你这么说，是想让谁安心。", "我听懂了。然后呢。"],
    "池田": ["你别忽然说这种话。", "等等，你什么意思。"],
    "茶终": ["……说。", "继续。"],
    "樱井": ["你的话，我记下了。", "请对自己的话负责。"],
    "小野": ["站直了说。", "别绕。说重点。"],
    "幸子": ["我、我想确认一下你的意思。", "对不起，我记下了。"]
  };
  var REPLY_LINES_MOMO = ["……说重点。", "我听见了。", "别重复。"];
  function pickDifferent(name, arr) {
    if (!arr || !arr.length) return "";
    var last = (S && S._lastFallback && S._lastFallback[name]) || "";
    var pool = arr.filter(function (t) { return t !== last; });
    if (!pool.length) pool = arr;
    var t = pick(pool);
    if (S) {
      if (!S._lastFallback) S._lastFallback = {};
      S._lastFallback[name] = t;
    }
    return t;
  }
  function fallbackTarget(g, name) {
    var role = g.roles[name];
    var others = aliveAll(g).filter(function (k) { return k !== name; });
    if (!others.length) return "";
    if (role === "seer" && g.seerChecks.length) {
      for (var i = g.seerChecks.length - 1; i >= 0; i--) {
        var c = g.seerChecks[i];
        if (c.isWolf && g.alive[c.who]) return c.who;
      }
    }
    if (isFox(g, name)) {
      var goods = others.filter(function (k) { return !isFox(g, k); });
      if (goods.length) others = goods;
    }
    var best = null, bestScore = -1;
    others.forEach(function (k) {
      var heat = (g.lastVotesAgainst[k] || []).length;
      if (heat > bestScore) { bestScore = heat; best = k; }
    });
    return (bestScore > 0 && best) ? best : pick(others);
  }
  function randomExpr() {
    var arr = expressions();
    return arr[1 + rnd(arr.length - 1)] || "默认";
  }
  function randomStance() {
    var arr = stances();
    return arr[rnd(arr.length)];
  }
  function fallbackLineFor(g, name) {
    var role = g.roles[name];
    var target = fallbackTarget(g, name) || "众人";
    var text = "", stance = randomStance();
    if (role === "seer" && g.seerChecks.length && Math.random() < 0.7) {
      var last = g.seerChecks[g.seerChecks.length - 1];
      text = "我是预言家。第" + last.day + "夜我验的是" + nameOf(last.who) + "，" +
        (last.isWolf ? "狼。" : "好人。") + target + "，你还要装到什么时候？";
      stance = "站边";
      target = last.who === name ? target : last.who;
    } else if (isFox(g, name) && Math.random() < 0.3 && name !== g.wolfKing) {
      var fake = aliveAll(g).filter(function (k) { return k !== name && !isFox(g, k); });
      if (fake.length) {
        var ft = pick(fake);
        text = "我是预言家，昨夜验的是" + nameOf(ft) + "，是狼。" + nameOf(target) + "，你信我一次。";
        stance = "带节奏";
      }
    }
    if (!text) {
      var base = pickDifferent(name, SAFE_LINES[name] || []);
      text = base || "……";
      if (target && target !== "众人" && text.indexOf(target) < 0) {
        text += "——" + nameOf(target) + "，你怎么说？";
      }
    }
    var max = dayLineMax();
    if (text.length > max) text = text.slice(0, max - 1) + "…";
    return { who: name, text: text, expr: randomExpr(), stance: stance, target: target === "众人" ? "" : target };
  }
  function fallbackDayLines(g) {
    var out = [];
    aliveNpcs(g).forEach(function (k) { out.push(fallbackLineFor(g, k)); });
    return out.length ? out : [{ who: HOST, text: "茶会的声音，低了下去。", expr: "默认", stance: "观察", target: "" }];
  }
  function topOfCount(soFar) {
    var c = {}, max = 0, top = null;
    Object.keys(soFar || {}).forEach(function (v) {
      var t = soFar[v];
      if (!t) return;
      c[t] = (c[t] || 0) + 1;
      if (c[t] > max) { max = c[t]; top = t; }
    });
    return top;
  }
  function fallbackVote(g, voter, soFar) {
    var cands = aliveAll(g).filter(function (k) { return k !== voter; });
    if (!cands.length) return null;
    var V = (C.rules.vote || {})[voter] || {};
    var w = {};
    cands.forEach(function (k) { w[k] = 1; });
    Object.keys(V).forEach(function (k) {
      if (typeof V[k] === "number" && w[k] !== undefined) w[k] = V[k];
    });
    if (V.never) V.never.forEach(function (k) { if (w[k] !== undefined) w[k] = 0; });
    if (voter === g.seer) {
      g.seerChecks.forEach(function (c) {
        if (!g.alive[c.who] || w[c.who] === undefined) return;
        w[c.who] *= c.isWolf ? 8 : 0.12;
      });
    }
    if (isFox(g, voter)) {
      g.wolves.forEach(function (f) {
        if (f !== voter && w[f] !== undefined) w[f] *= 0.06;
      });
      cands.forEach(function (k) {
        if (!isFox(g, k)) w[k] *= 1 + (g.lastVotesAgainst[k] || []).length * 0.4;
      });
    } else if (V.follow) {
      var top = topOfCount(soFar);
      if (top && w[top] !== undefined) w[top] *= 8;
    }
    cands.forEach(function (k) {
      var heat = (g.lastVotesAgainst[k] || []).length;
      if (heat > 0) w[k] = (w[k] || 1) * (1 + heat * 0.6);
    });
    var k2 = weightedPick(w);
    return k2 || pick(cands);
  }
  function normalizeVotes(g, raw, plans) {
    var out = {};
    aliveNpcs(g).forEach(function (v) {
      var t = raw && raw[v];
      /* v5：公开 voteIntent 必须与实际票一致；优先使用本轮计划里的 voteIntent */
      if (!t && plans && plans[v]) t = plans[v].voteIntent;
      t = normalizeName(typeof t === "string" ? t.trim() : "");
      if (!t || !g.alive[t] || t === v || t === HOST) t = fallbackVote(g, v, out);
      if (t) out[v] = t;
    });
    return out;
  }
  function fallbackReplies(g, text) {
    var alive = aliveNpcs(g);
    var picks = [];
    alive.forEach(function (k) {
      if (picks.length < 2 && String(text).indexOf(k) >= 0) picks.push(k);
    });
    if (!picks.length && alive.indexOf("墨墨") >= 0) picks.push("墨墨");
    while (picks.length < 2 && alive.length) {
      var k = alive[rnd(alive.length)];
      if (picks.indexOf(k) < 0) picks.push(k);
    }
    if (!picks.length) return [{ who: HOST, text: "……茶会已经散了。", expr: "默认", stance: "观察", target: "" }];
    return picks.map(function (k) {
      var arr = (k === "墨墨" && Math.random() < 0.6) ? REPLY_LINES_MOMO : (REPLY_LINES[k] || SAFE_LINES[k] || ["……"]);
      var line = pickDifferent(k + "_reply", arr) || "……";
      if (line.length > dayLineMax()) line = line.slice(0, dayLineMax() - 1) + "…";
      return { who: k, text: line, expr: randomExpr(), stance: "辩护", target: P };
    });
  }

  /* ============================================================
     十、玩家自由输入
     ============================================================ */
  function parsePlayerStance(text) {
    var g = S;
    if (!g) return;
    var st = g.playerStance || {};
    function hit(re) {
      var m = String(text || "").match(re);
      if (!m) return "";
      return normalizeName(m[1]);
    }
    var t = hit(/我(?:更|还是)?(?:信|相信|站边?|支持)\s*([^，。！？、\s]{1,6})/);
    if (t && (t === P || t === HOST || g.alive[t])) st.trust = t;
    var a = hit(/我(?:点|怀疑|不信|要出|想出)\s*([^，。！？、\s]{1,6})/);
    if (a && (a === P || a === HOST || g.alive[a])) st.accuse = a;
    var v = hit(/我(?:投|票给|会投|这一票给)\s*([^，。！？、\s]{1,6})/);
    if (v && (v === P || v === HOST || g.alive[v])) st.vote = v;
    if (st.trust || st.accuse || st.vote) g.playerStance = st;
  }

  function onSend() {
    if (!S || S.busy) return;
    var text = (els.input.value || "").trim();
    if (!text) return;
    var now = Date.now();
    if (now - S.lastInputAt < 700) return;     /* 防连点 */
    S.lastInputAt = now;
    els.input.value = "";
    sendPlayer(text);
  }

  function sendPlayer(text) {
    var g = S;
    if (!g || g.busy) return Promise.resolve();
    if (!(g.phase === "day" || g.phase === "vote" || g.phase === "result")) {
      addLine(null, "（此刻，没有人应声。）", "narr");
      return Promise.resolve();
    }
    text = String(text).replace(/\s*\n+\s*/g, " ").trim().slice(0, 120);
    if (!text) return Promise.resolve();
    addLine(P, text, "you");
    parsePlayerStance(text);
    captureCorpus("user", text);
    var cap = playerTalkCap();
    if (g.playerTalk >= cap || api.calls >= AI_MAX_CALLS) {
      g.playerTalk++;
      var local = fallbackReplies(g, text);
      return showLines(g, local, 200).then(function () {
        if (S === g) addLine(null, "（茶会的声音，渐渐低了下去。）", "narr");
      });
    }
    g.playerTalk++;
    setBusy(true, "茶会正在应声");
    return aiReply(g, text).then(function (lines) {
      if (S !== g) return;
      setBusy(false);
      if (!lines || !lines.length) lines = fallbackReplies(g, text);
      return showLines(g, lines, 240).then(function () {
        if (S === g) syncUI();
      });
    });
  }

  /* ============================================================
     十一、start / stop / 对外接口
     ============================================================ */
  function start() {
    if (root && S) {           /* 已开着：重开一局（同页可反复开局） */
      newGame();
      return state();
    }
    if (!buildOverlay()) return { running: false, error: "overlay" };
    newGame();
    /* 测试用：?test=tea&ending=guest_win / fox_win / judge / player_out / player_night / player_shot
       直接跳到对应收尾，方便作者验收结局，不影响正常入口。 */
    try {
      var e = new URLSearchParams(location.search).get("ending");
      if (e && /^(guest_win|fox_win|judge|player_out|player_night|player_shot)$/.test(e)) {
        setTimeout(function () { if (S) beginEnding(e); }, 1200);
      }
    } catch (err) {}
    return state();
  }
  function stop() {
    flushVN();
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    els = {};
    S = null;
  }
  function state() {
    if (!S) return { running: false, configLoaded: !!MD.tea_personas, lamp: lampLit() };
    return {
      running: true,
      day: S.day,
      phase: S.phase,
      busy: S.busy,
      typing: S.typing,
      spoke: S.spoke,
      foxes: S.foxes.slice(),
      alive: clone(S.alive),
      dead: clone(S.dead),
      playerAlive: S.playerAlive,
      checked: clone(S.checked),
      lastNight: clone(S.lastNight),
      votes: clone(S.npcVotes),
      playerVote: S.playerVote,
      tally: clone(S.tally),
      expel: clone(S.expel),
      winner: S.winner,
      ending: clone(S.ending),
      aiCalls: S.aiCalls,
      api: { calls: api.calls, requests: api.requests, fails: api.fails, parseFails: api.parseFails, lastMs: api.ms[api.ms.length - 1] || 0 },
      logCount: S.log.length,
      wasLit: S.wasLit,
      lamp: lampLit(),
      ch1_done: ch1Done(),
      seatOrder: S.seats.slice(),
      player: P,
      playerRole: S.playerRole,
      role: S.roles[P],
      roles: clone(S.roles),
      wolves: (S.wolves || []).slice(),
      wolfKing: S.wolfKing,
      seer: S.seer,
      witch: S.witch,
      hunter: S.hunter,
      witchPotions: clone(S.witchPotions),
      seerChecks: clone(S.seerChecks),
      shots: clone(S.shots),
      transcript: clone(S.transcript || []),
      plans: clone(S.plans || {}),
      wolfChat: clone(S.wolfChat || null),
      playerStance: clone(S.playerStanceApplied || S.playerStance || null),
      plannedVotes: clone(S.plannedVotes || null),
      wishesDone: !!S.wishesDone,
      stripShown: !!S.stripShown,
      choice: S.choice ? { phase: S.choice.phase, hint: S.choice.hint } : null,
      vnBusy: vnBusy(),
      host: HOST,
      configLoaded: !!MD.tea_personas,
      cardsLoaded: !!(MD.tea_cards && (MD.tea_cards.cards || Object.keys(MD.tea_cards).length))
    };
  }
  function drive(limit) {
    limit = limit || 140;
    return (async function () {
      for (var i = 0; i < limit; i++) {
        if (!S) return state();
        if (S.phase === "ending") {
          for (var j = 0; j < 120 && S && (S.busy || !S.ending || (els.endmask && els.endmask.classList.contains("hidden"))); j++) {
            if (vnBusy()) advanceBeat();
            await sleep(isDebug() ? 30 : 90);
          }
          await sleep(isDebug() ? 30 : 200);
          return state();
        }
        if (S.choice) {
          var spec = S.choice.spec || {};
          S.choice.answer({ type: "option", value: spec.defaultValue });
          await sleep(40);
          continue;
        }
        if (S.busy) { await sleep(60); continue; }
        if (vnBusy()) { advanceBeat(); await sleep(isDebug() ? 10 : 40); continue; }
        if (S.phase === "vote") {
          var t = aliveNpcs(S);
          if (!t.length) return state();
          onCardPick(t[rnd(t.length)]);
          await sleep(60);
          continue;
        }
        if (S.phase === "open" || S.phase === "day" || S.phase === "result") {
          await onContinue();
          await sleep(50);
          continue;
        }
        await sleep(60);
      }
      return state();
    })();
  }

  window.MomoTeaAI = {
    start: start,
    stop: stop,
    state: state,
    config: function () { return C; },
    cards: function () {
      return SEATS.map(function (k) { return { who: k, label: labelOf(k), image: cardImage(k) }; });
    },
    debug: {
      drive: drive,
      cont: onContinue,
      pick: onCardPick,
      say: function (t) { return sendPlayer(t); },
      light: onLampClick,
      end: function (kind) { if (S) return beginEnding(kind || "judge"); },
      again: onAgainClick,
      nextBeat: advanceBeat,
      beats: function () {
        return {
          queue: VN.queue.length, current: !!VN.current, typing: VN.typing,
          specs: (S && S.lastBeats || []).map(function (b) {
            return { who: b.who, goal: b.goal, target: b.target ? nameOf(b.target) : "", facts: b.facts };
          })
        };
      },
      toast: toast,
      api: function () { return { calls: api.calls, requests: api.requests, fails: api.fails, parseFails: api.parseFails, lastRaw: api.lastRaw, ms: api.ms.slice() }; },
      config: function () { return C; },
      cards: function () { return window.MomoTeaAI.cards(); }
    }
  };

  /* 剧情链接线：dialogues.json 的 ch1_正文 结尾 then:"tea:ai" */
  document.addEventListener("momo:script_end", function (e) {
    if (!e || !e.detail) return;
    if (e.detail.then !== "tea:ai") return;
    setTimeout(function () { start(); }, isDebug() ? 0 : 260);
  });
})();
