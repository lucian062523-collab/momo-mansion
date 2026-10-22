/* 墨墨 · 出题（方案 §5.2 的四个变体）
   同一套数据结构四变体共用，渲染层只认 kind —— 加变体不用改界面。

   变体：
     meaning 词义选择   给词形，四选一选中文释义
     cloze   填空       例句挖空，四选一填回原词
     colloc  用法搭配   给释义，四选一选正确搭配
     listen  听音选词   TTS 念出词，四选一选词形（无 TTS 时自动降级为显示音标）

   组卷必须"活"：干扰项优先取词条自带的 distractors（同形近义，最像真题），
   凑不够再从词库里随机补，且永远排除正确答案本身。

   只吃数据吐数据，不碰 DOM。判分归这里，惩罚归经济系统 —— 本层不扣任何数值。 */
(function () {
  "use strict";
  var DATA = window.MOMO_DATA || {};

  var VARIANTS = ["meaning", "cloze", "colloc", "listen"];

  function pool(lang) {
    return (lang === "ja" ? DATA.words_ja : DATA.words_en) || [];
  }
  function ttsOk() {
    try { return !!(window.speechSynthesis && window.SpeechSynthesisUtterance); }
    catch (e) { return false; }
  }
  /* 词形（日语优先汉字，无汉字用假名） */
  function form(w) {
    return w.lang === "ja" ? (w.kanji || w.kana || w.lemma) : w.lemma;
  }
  function sub(w) {
    if (w.lang === "ja") return w.kana + "　" + (w.romaji || "");
    return w.pron || "";
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* 把 t 里的词挖成空；挖不到（例句用了变形）返回 null，调用方降级换变体 */
  function blank(t, w) {
    var forms = [w.lemma, w.kanji, w.kana].filter(Boolean);
    for (var i = 0; i < forms.length; i++) {
      var f = String(forms[i]);
      if (f.length < 2 && w.lang === "en") continue;
      var re = new RegExp("(^|[^A-Za-z0-9\\u3040-\\u30ff\\u4e00-\\u9fff])(" +
        f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "i");
      if (re.test(t)) return t.replace(re, "$1____");
    }
    return null;
  }

  /* 从词库里凑 3 个干扰项文本，排除正确答案 */
  function pad(correct, cands, all, field) {
    var out = [];
    function push(x) {
      x = String(x == null ? "" : x).trim();
      if (!x || x === correct || out.indexOf(x) >= 0) return;
      out.push(x);
    }
    cands.forEach(push);
    if (out.length < 3) {
      var rest = shuffle(all.slice()).slice(0, 60);
      for (var i = 0; i < rest.length && out.length < 3; i++) push(rest[i][field]);
    }
    return out.slice(0, 3);
  }

  /* 同形近义干扰项对应的词对象（distractors 里写的是词形，回查词库拿释义） */
  function byForm(all, lang, forms) {
    var m = {};
    all.forEach(function (w) { m[String(form(w)).toLowerCase()] = w; });
    return (forms || []).map(function (f) { return m[String(f).toLowerCase()]; })
      .filter(Boolean);
  }

  function make(w, kind, all) {
    var item = null;
    if (kind === "meaning") {
      var correctM = w.meaning_zh;
      var near = byForm(all, w.lang, w.distractors);
      var wrong = pad(correctM, near.map(function (x) { return x.meaning_zh; }), all, "meaning_zh");
      var cs = shuffle([{ t: correctM, ok: true }].concat(
        wrong.map(function (t) { return { t: t, ok: false }; })));
      item = {
        kind: kind, word: w, prompt: form(w), prompt_sub: sub(w),
        ask: "选出正确的释义", choices: cs
      };
    } else if (kind === "cloze") {
      var b = blank(w.example.t, w);
      if (!b) return null;
      var cs2 = shuffle([{ t: form(w), ok: true }].concat(
        pad(form(w), w.distractors, all, "lemma").map(function (t) { return { t: t, ok: false }; })));
      item = {
        kind: kind, word: w, prompt: b, prompt_sub: w.example.zh,
        ask: "选出应填入空格的词", choices: cs2
      };
    } else if (kind === "colloc") {
      var co = (w.colloc || []).filter(function (x) { return String(x).trim(); });
      if (!co.length) return null;
      var correctC = co[0];
      var others = [];
      var nears = byForm(all, w.lang, w.distractors);
      nears.forEach(function (x) { (x.colloc || []).forEach(function (c) { others.push(c); }); });
      var pool2 = others.length >= 3 ? others
        : others.concat(shuffle(all.slice()).slice(0, 40)
          .map(function (x) { return (x.colloc || [])[0]; }));
      var cs3 = shuffle([{ t: correctC, ok: true }].concat(
        pad(correctC, pool2, all, "colloc").map(function (t) { return { t: t, ok: false }; })));
      if (cs3.length < 2) return null;
      item = {
        kind: kind, word: w, prompt: form(w), prompt_sub: w.meaning_zh,
        ask: "选出正确搭配", choices: cs3
      };
    } else if (kind === "listen") {
      var cs4 = shuffle([{ t: form(w), ok: true }].concat(
        pad(form(w), w.distractors, all, "lemma").map(function (t) { return { t: t, ok: false }; })));
      item = {
        kind: kind, word: w, prompt: ttsOk() ? "🔊" : (w.pron || ""),
        prompt_sub: ttsOk() ? "点击喇叭重听" : "（本机无语音合成，按音标选）",
        ask: "选出你听到的词", choices: cs4
      };
    }
    if (item) item.answer = -1;
    return item;
  }

  /* 组卷：ids 已经由 SRS.pick 排好优先级，这里只负责把变体轮着铺开 */
  function build(lang, ids, n) {
    var all = pool(lang);
    var byId = {};
    all.forEach(function (w) { byId[w.id] = w; });
    var out = [], vi = 0;
    for (var i = 0; i < ids.length && out.length < n; i++) {
      var w = byId[ids[i]];
      if (!w) continue;
      /* 变体轮转；某个变体缺数据（如没有搭配）就顺延到下一个 */
      var made = null;
      for (var k = 0; k < VARIANTS.length && !made; k++) {
        made = make(w, VARIANTS[(vi + k) % VARIANTS.length], all);
      }
      if (!made) continue;
      vi += 1;
      out.push(made);
    }
    return out;
  }

  function answerIndex(item) {
    for (var i = 0; i < item.choices.length; i++) if (item.choices[i].ok) return i;
    return -1;
  }

  function speak(text, lang) {
    if (!ttsOk()) return false;
    try {
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = lang === "ja" ? "ja-JP" : "en-US";
      u.rate = 0.92;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }

  window.MomoQuiz = {
    VARIANTS: VARIANTS,
    pool: pool,
    form: form,
    build: build,
    answerIndex: answerIndex,
    ttsOk: ttsOk,
    speak: speak
  };
})();