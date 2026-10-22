/* 墨墨 · 第 6 天起自动编日引擎
   =====================================================================
   依赖：window.MOMO_DATA（words_en / words_ja，字段与 index.html 内嵌一致）
   SRS 状态：本模块自带结构，建议落盘进 MomoStore 的 save（见文末接入示例）
   输出：与 lessons.days[] 手写日程同构的「一天」对象，引擎无需改动即可消费

   与 lessons.next.auto_rule 的对应关系——
     新词优先取 srs.interval < 7 且从未出现过的词  → pickNew() 规则 1
     复习优先取 due <= 今天 的词                   → pickReview()
     （「interval < 7」按原意实现为：从未进入过 SRS 的词；已在 SRS 里的词
       归复习流，由 due 驱动，不会和新词混池。）

   使用（伪代码）：
     var day = MomoAuto.nextDay(6, srs, MOMO_DATA, { date: "2026-09-26" });
     // day 清晨/午后/夜晚结构与 days[0] 完全一致，直接进三时段玩法
     // 时段结束后，按玩家每张卡的自评调 updateSrs(srs, wordId, rating, today)
   ===================================================================== */
(function (global) {
  "use strict";

  var AUTO = {};

  /* ---------- 配置（都从这里调，别散落在逻辑里） ---------- */
  var CFG = {
    new_per_lang: 4,            // 每语种每日新词（三时段配比公式的源头）
    review_cap_per_lang: 6,     // 每语种每日复习上限
    unseen_buffer: 4,           // 当前档剩余未见词 < 此值时，提前开下一档
    quiz_count: 10,
    /* 变体配比 3:3:2:2，轮转取用，保证每天题型结构稳定 */
    variant_mix: [["meaning", 3], ["cloze", 3], ["listen", 2], ["collocation", 2]],
    scenes: {
      清晨: ["卧房-早", "玄关-早"],
      午后: ["教室-白天", "图书馆-白天", "琴房-白天"],
      夜晚: ["卧房-夜-开灯", "客厅-夜-开灯", "书房-夜-开灯"]
    },
    hint_templates: {
      en: "主语 + 谓语动词 + 宾语 + 地点/时间状语",
      ja: "主语 + は + 名词 + です/ます"
    },
    /* 章节计划：镜像好感曲线的中后期主线。to 为 0 表示此后恒定 */
    chapter_plan: [
      { from: 6,  to: 9,  title: "第四章 · 细水长流" },
      { from: 10, to: 13, title: "第五章 · 不动声色" },
      { from: 14, to: 16, title: "第六章 · 心照不宣" },
      { from: 17, to: 0,  title: "日常 · 一直都在" }
    ],
    /* 节日词包：命中当天，新词全部替换为词包词、台词池切到 daily.festival 对应键。
       ！！！词条必须先加进 words_en / words_ja（tier 建议 5，不进常规轮换）。
       exam 项不按日期，由 opts.exam_week = true 手动开启。 */
    festival_packs: {
      "01-01": { key: "newyear",    words: { en: [], ja: [] } },
      "02-14": { key: "valentine",  words: { en: [], ja: [] } },
      "12-25": { key: "christmas",  words: { en: [], ja: [] } },
      "exam":   { key: "exam_season", words: { en: [], ja: [] }, manual: true }
    }
  };

  /* ---------- SRS：三档自评推进 ----------
     忘了  → 盒子归 0，明天必然重见
     模糊  → 盒子不动，3 天后见
     记得  → 盒子 +1，间隔按表走
     间隔表（天）：盒子0=1，1=2，2=4，3=7，4=15，5=30，6以后=60        */
  var BOX_INTERVALS = [1, 2, 4, 7, 15, 30, 60];

  function todayStr(d) {
    return d ? d : new Date().toISOString().slice(0, 10);
  }
  function addDays(dateStr, n) {
    var d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function ensure(srs, id) {
    if (!srs[id]) srs[id] = { box: 0, due: null, seen: 0 };
    return srs[id];
  }
  /* rating: "忘了" | "模糊" | "记得"（与 flashcard self_rating 三键一致） */
  function updateSrs(srs, wordId, rating, today) {
    var st = ensure(srs, wordId);
    st.seen++;
    today = todayStr(today);
    if (rating === "忘了") {
      st.box = 0;
      st.due = addDays(today, 1);
    } else if (rating === "模糊") {
      st.due = addDays(today, 3);
    } else { /* 记得 */
      st.box = Math.min(st.box + 1, BOX_INTERVALS.length - 1 + 10);
      var gap = BOX_INTERVALS[Math.min(st.box, BOX_INTERVALS.length - 1)];
      st.due = addDays(today, gap);
    }
    return st;
  }

  /* ---------- 工具 ---------- */
  function wordsOf(DATA, lang) {
    return (DATA.words_en || []).concat(DATA.words_ja || []).filter(function (w) { return w.lang === lang; });
  }
  function byId(DATA) {
    var m = {};
    ["words_en", "words_ja"].forEach(function (k) {
      (DATA[k] || []).forEach(function (w) { m[w.id] = w; });
    });
    return m;
  }
  function shuffle(arr, seed) {
    /* 轻量种随机：同一天同 seed 结果稳定，方便复现与调试 */
    var s = (seed || 1) >>> 0;
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      var j = s % (i + 1);
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- 选词：新词 ----------
     规则 1：从未进入 SRS 的词优先（即 auto_rule 的「从未出现过」）
     规则 2：档位从低到高；当前档未见词剩 < unseen_buffer 时开下一档
     规则 3：tier 5 是节日/主题词包专用档，常规轮换永远不取  */
  function pickNew(DATA, srs, dayNum) {
    var out = { en: [], ja: [] };
    ["en", "ja"].forEach(function (lang) {
      var pool = wordsOf(DATA, lang).filter(function (w) {
        return w.tier < 5 && !srs[w.id];
      });
      /* 按档分组 */
      var byTier = {};
      pool.forEach(function (w) {
        (byTier[w.tier] = byTier[w.tier] || []).push(w);
      });
      var tiers = Object.keys(byTier).map(Number).sort(function (a, b) { return a - b; });
      var take = CFG.new_per_lang, picked = [];
      while (take > 0 && tiers.length) {
        var t = tiers[0];
        var arr = shuffle(byTier[t], dayNum * 31 + t);
        var canOpen = arr.length - CFG.unseen_buffer;
        var n = Math.min(take, Math.max(canOpen, 0) > 0 ? take : Math.max(arr.length, 0));
        /* 档内够数就取满；不足且下档未开时，把本档剩余一并吃掉再开下档 */
        if (arr.length >= take + CFG.unseen_buffer) {
          n = take;
        } else if (arr.length <= CFG.unseen_buffer) {
          n = 0; /* 直接开下一档 */
        } else {
          n = arr.length - CFG.unseen_buffer;
        }
        picked = picked.concat(arr.slice(0, n));
        take -= n;
        tiers.shift();
      }
      out[lang] = picked.slice(0, CFG.new_per_lang).map(function (w) { return w.id; });
    });
    return out;
  }

  /* ---------- 选词：复习（due <= today，升序，限量） ---------- */
  function pickReview(DATA, srs, today) {
    var out = { en: [], ja: [] };
    ["en", "ja"].forEach(function (lang) {
      var due = wordsOf(DATA, lang).filter(function (w) {
        var st = srs[w.id];
        return st && st.due && st.due <= todayStr(today);
      });
      due.sort(function (a, b) { return srs[a.id].due < srs[b.id].due ? -1 : 1; });
      out[lang] = due.slice(0, CFG.review_cap_per_lang).map(function (w) { return w.id; });
    });
    return out;
  }

  /* ---------- 出题：随堂测 10 题 ----------
     题源：今日新词 + 复习词混合，新词优先占前排
     cloze：把例句里的 lemma 挖成 ____（lemma 不在句中则退化为 meaning）
     collocation：tags 带 collocation 的词优先，没有则并入 meaning 池    */
  function makeQuizWord(word, variant) {
    var q = { word: word.id, variant: variant };
    if (variant === "cloze") {
      var t = word.example && word.example.t;
      if (!t || t.indexOf(word.lemma) === -1) q.variant = "meaning";
    }
    return q;
  }
  function buildQuiz(DATA, dayWords) {
    var map = byId(DATA);
    var all = [];
    dayWords.new.en.concat(dayWords.review.en, dayWords.new.ja, dayWords.review.ja)
      .forEach(function (id) { if (map[id]) all.push(map[id]); });
    all = shuffle(all, all.length * 7 + 13);
    /* 展开变体配比成一个队列，再与词一一配对 */
    var plan = [];
    CFG.variant_mix.forEach(function (pair) {
      for (var i = 0; i < pair[1]; i++) plan.push(pair[0]);
    });
    var quiz = [];
    for (var i = 0; i < CFG.quiz_count && i < all.length; i++) {
      quiz.push(makeQuizWord(all[i], plan[i % plan.length]));
    }
    while (quiz.length < CFG.quiz_count && all.length) {
      quiz.push(makeQuizWord(all[quiz.length % all.length], "meaning"));
    }
    return quiz;
  }

  /* ---------- 解密两式 ----------
     p1_order：挑一个 en 新词例句，打乱词序（标点剥离、首词保大写作锚点）
     p2_match：今日四词 ↔ 释义配对（英日各取，凑不齐就单语种）        */
  function buildPuzzles(DATA, dayWords) {
    var map = byId(DATA);
    var out = [];
    /* p1 语序拼句 */
    var enIds = dayWords.new.en.concat(dayWords.review.en);
    for (var i = 0; i < enIds.length; i++) {
      var w = map[enIds[i]];
      var t = w && w.example && w.example.t;
      if (t && t.split(" ").length >= 5) {
        var words = t.replace(/[.!?]$/, "").split(" ");
        var scram = shuffle(words, words.length * 17 + 5);
        if (scram.join(" ") !== words.join(" ")) {
          out.push({
            type: "p1_order", lang: "en", answer: t,
            scrambled: scram,
            hint: CFG.hint_templates.en
          });
          break;
        }
      }
    }
    /* p2 配对 */
    var pairs = [];
    dayWords.new.en.concat(dayWords.review.en).slice(0, 2).forEach(function (id) {
      if (map[id]) pairs.push([map[id].lemma, map[id].meaning_zh.split("；")[0]]);
    });
    dayWords.new.ja.concat(dayWords.review.ja).slice(0, 2).forEach(function (id) {
      if (map[id]) pairs.push([map[id].lemma, map[id].meaning_zh.split("；")[0]]);
    });
    if (pairs.length >= 3) out.push({ type: "p2_match", pairs: pairs });
    return out;
  }

  /* ---------- 章节、场景、节日 ---------- */
  function chapterFor(dayNum) {
    for (var i = 0; i < CFG.chapter_plan.length; i++) {
      var c = CFG.chapter_plan[i];
      if (dayNum >= c.from && (c.to === 0 || dayNum <= c.to)) return c.title;
    }
    return "日常 · 一直都在";
  }
  function sceneFor(slot, dayNum) {
    var arr = CFG.scenes[slot] || [""];
    return arr[(dayNum - 1) % arr.length];
  }
  function festivalFor(dateStr, opts) {
    if (!dateStr) return null;
    if (opts && opts.exam_week) return CFG.festival_packs["exam"];
    var mmdd = dateStr.slice(5);
    return CFG.festival_packs[mmdd] || null;
  }

  /* ---------- 主出口：编一天 ---------- */
  function nextDay(dayNum, srs, DATA, opts) {
    opts = opts || {};
    var today = todayStr(opts.date);
    var fest = festivalFor(today, opts);

    var dayWords;
    if (fest) {
      /* 节日覆盖：新词全部换成词包（词条须已在词库）；复习照常 */
      dayWords = {
        new: { en: fest.words.en.slice(0, CFG.new_per_lang), ja: fest.words.ja.slice(0, CFG.new_per_lang) },
        review: pickReview(DATA, srs, today)
      };
    } else {
      dayWords = { new: pickNew(DATA, srs, dayNum), review: pickReview(DATA, srs, today) };
    }

    return {
      day: dayNum,
      ng: opts.ng || 1,
      chapter: fest ? "特别篇 · " + fest.key : chapterFor(dayNum),
      festival: fest ? fest.key : null,
      清晨: {
        scene: sceneFor("清晨", dayNum),
        new: dayWords.new,
        review: dayWords.review
      },
      午后: {
        scene: sceneFor("午后", dayNum),
        quiz: buildQuiz(DATA, dayWords),
        puzzles: buildPuzzles(DATA, dayWords)
      },
      夜晚: {
        scene: sceneFor("夜晚", dayNum),
        immerse: { word_pool: dayWords.new.en.concat(dayWords.new.ja).slice(0, 5) },
        minigame: "scene_hunt"
      }
    };
  }

  /* ---------- 导出 ---------- */
  AUTO.nextDay = nextDay;
  AUTO.updateSrs = updateSrs;
  AUTO.pickNew = pickNew;
  AUTO.pickReview = pickReview;
  AUTO.CFG = CFG;
  global.MomoAuto = AUTO;
  return AUTO;

  /* ============ 接入示例（注释，供参考） ============
     1. 存档里给 MomoStore.DEFAULT 加一项：
        srs: {}   // { wordId: { box, due, seen } }

     2. 每日开局（day > 5 时）：
        var day = MomoAuto.nextDay(day, S.save().srs, window.MOMO_DATA, {
          date: new Date().toISOString().slice(0, 10)
        });

     3. 玩家翻完一张卡：
        MomoAuto.updateSrs(srs, "en_abandon", "记得", today);   // 持久化 srs 即可

     4. 节日词包补词（往 MOMO_DATA.words_en push）：
        { id: "en_valentine", lang: "en", tier: 5, lemma: "valentine", ... }
        然后把 id 填进 CFG.festival_packs["02-14"].words.en

     验收基准：
     - 连续 nextDay 7 天不重词（词库充足时）
     - 标「忘了」的词次日必然出现在 review
     - 节日当天 chapter 前缀为「特别篇 · 」
     ==================================================== */
})(typeof window !== "undefined" ? window : globalThis);
