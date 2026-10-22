/* 墨墨 · 存档（最小可用版）
   统一出口：window.MomoStore.state / .save()
   目前用 localStorage；方案 §9 定稿后替换为完整存档结构即可，调用方不用改。 */
(function () {
  "use strict";
  var KEY = "momo.save.main";
  var DEFAULT = {
    version: 1,
    wardrobe: { worn: null, unlocked: [] },   // 已穿戴 / 已解锁套装
    cg: { unlocked: [], viewed: [] },         // 已解锁 / 已看过的 CG
    currency: 1000,                           // 货币（学习产出；学习系统接通前先给启动货币，否则赠送必「余额不足」）
    supplies: 60,                             // 物资（墨墨生存指标，0–100，归零 → 墨墨死亡）
    mood: 50,                                 // 心情（关系指标，0–100）
    affection: 0,                             // 好感（无上限，驱动 CG / 服装 / 剧情）
    cycle: 1,                                 // 周目数（墨墨死亡重开时 +1）
    room: "卧房",                             // 当前所在房间（场景基名；主画面据此出图）
    floor: "F1",                              // 当前所在楼层（F1/F2/F3/OUT；地图据此打开）
    /* 主线剧情进度。开场引入演完置 true，之后不再自动重播；
       多周目（墨墨死亡重开）会整份重置，所以开场跟周目一起重来。
       log 是「剧情回放」读的过往对话，每演一句由 director.js 追加一笔
       （只记说出来的话，不记表情演出），上限见 director.js 的 LOG_MAX。 */
    story: { intro_done: false, log: [] },
    /* ---- 心之桥（主线章节进度，2026-10）----
       lit = 已点亮的灯（0~8）。灯是她的勇气与记忆：死亡/换周目不清——
       revive() 只重置 story/好感/心情，这里跨周目保留（与 §8「学习进度保留」同构）。
       ch1_* 的剧本 flag 也挂在这一层（bridge.ch1_done 等）：换周目后章节不重播。 */
    bridge: { lit: 0 },
    /* ---- 学习系统（方案 §9 的 learned / unlocked 子集，先落最小可用形态）----
       learned 是 SRS 主表，跨周目保留（§8：死亡只清关系状态，不清学习进度）。
       记词本的「已掌握 / 待复习 / 新收录」、错题集、练习组卷全部由这里推导，
       不再有写死的数据。 */
    learn: {
      lang: "en",                             // 当前语种：en | ja
      learned: {},                            // 词 id → {ease, interval, due, seen, correct, wrong}
      starred: { en: [], ja: [] },            // 单词卡片 ★（「收入记词本」）
      wrong: { en: [], ja: [] },              // 错题集：答错的词 id（按时间倒序，去重）
      grammar: { en: [], ja: [] }             // 语法页已看过的点 id
    },
    /* ---- 日循环（daily.js 维护）----
       day 是「以 05:00 为界」的自然日键 YYYYMMDD —— 日结算与缺席判定都按它算；
       slots 记当天三段是否已经发过在线奖励（每段只发一次）；
       quiz_total / quiz_right 是当天判分的累计，用来算「当天准确率」；
       streak 是连续不缺席的天数（满 7 天发连勤奖励后归零重新数）。 */
    daily: {
      day: "",
      slots: { "清晨": false, "午后": false, "夜晚": false },
      quiz_total: 0,
      quiz_right: 0,
      streak: 0,
      /* 地点小游戏的配额（daily.js 换日/重周目时清）：used 记「哪些地点今天结算过」，
         total 记今天结算过几个 —— 防止把 40 个房间当成 40 个提款机。 */
      mini: { day: "", used: {}, total: 0 }
    }
  };
  /* 各数值上下限（好感不设上限） */
  var LIMITS = { supplies: [0, 100], mood: [0, 100], affection: [0, Infinity] };
  function clamp(k, v) {
    var r = LIMITS[k];
    return r ? Math.max(r[0], Math.min(r[1], v)) : v;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return clone(DEFAULT);
      var o = JSON.parse(raw);
      for (var k in DEFAULT) if (!(k in o)) o[k] = clone(DEFAULT[k]);
      return o;
    } catch (e) {
      return clone(DEFAULT);
    }
  }
  var state = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  window.MomoStore = {
    state: state,
    save: save,
    /* 读档：把快照整体写回当前存档（缺的顶层字段用 DEFAULT 补），落盘并广播，
       界面层收到 momo:store 后各自重绘。 */
    load: function (obj) {
      if (!obj) return state;
      state = Object.assign(clone(DEFAULT), obj);
      window.MomoStore.state = state;
      save();
      document.dispatchEvent(new CustomEvent("momo:store", { detail: { loaded: true } }));
      return state;
    },
    reset: function () { state = clone(DEFAULT); window.MomoStore.state = state; save(); },
    /* 统一加减出口：赠送道具、学习产出等都走这里。
       自动按 LIMITS 夹取，落盘后派发 momo:store，界面层（人物屏属性条等）据此刷新。 */
    apply: function (delta) {
      if (!delta) return state;
      for (var k in delta) {
        if (!(k in state)) continue;
        state[k] = clamp(k, (typeof state[k] === "number" ? state[k] : 0) + delta[k]);
      }
      save();
      document.dispatchEvent(new CustomEvent("momo:store", { detail: { delta: delta } }));
      return state;
    },
    /* ---- 货币的两个统一出口 ----
       经济系统的数值层（有多少钱、扣多少）跟「钱从哪来」是解耦的：产出方只说
       「我该拿多少、因为什么」，source 只作记账用（learn 学习产出 / onetime 日结算与
       连勤奖励 / purchase 消费）。将来接真实付费时，只要再加一个 source（如 pay）
       走同一个出口，游戏内所有数值逻辑一行都不用改。
       earn 不设上限（好感、货币都是无上限的）；spend 余额不足直接返回 false、不扣。 */
    earn: function (amount, source) {
      amount = Math.round(amount || 0);
      if (!amount) return state;
      state.currency = (state.currency || 0) + amount;
      save();
      document.dispatchEvent(new CustomEvent("momo:store",
        { detail: { delta: { currency: amount }, source: source || "" } }));
      return state;
    },
    spend: function (amount, source) {
      amount = Math.round(amount || 0);
      if (amount <= 0) return true;
      if ((state.currency || 0) < amount) return false;
      state.currency -= amount;
      save();
      document.dispatchEvent(new CustomEvent("momo:store",
        { detail: { delta: { currency: -amount }, source: source || "" } }));
      return true;
    }
  };
})();