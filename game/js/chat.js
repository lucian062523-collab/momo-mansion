/* 墨墨 · 对话（chat.js）
   =====================================================================
   面板式对话（2026-10-20 第一版 UI，作者选定）：主画面右下角「说 话」→
   羊皮纸面板，有对话记录；她的回复逐字流式出现在面板里，同时立绘按语气换表情。

   为什么不塞进对话条：试过把输入长在对话条上，会跟「点一下推进」的演出状态机
   抢同一块区域（点击语义冲突、收起逻辑互相打架）。面板是独立的 DOM，互不干扰。

   回复由 Cloudflare Pages Function 代理转发给大模型（key 在服务端），
   任何一步失败（没网 / 超时 / 没配 key）都静默退回她本来的台词池 ——
   玩家不会看到报错，游戏也不会因此不能玩。

   人设（2026-10-20 作者定调）：非常傲娇 + 有点毒舌 + 闷骚。好感只调「软的比例」，
   不调底色。只有玩家自己提到学习，她才准聊学习 —— 否则她会像个提醒器。 */
(function () {
  "use strict";

  var SCR = "主画面";
  var ENDPOINT = window.MOMO_CHAT_URL || "https://momo-chat-api.pages.dev/chat";
  var KEY = "momo.chat.v1";          // 最近几轮，跨会话带着上下文
  var KEEP = 8;
  var CTX = 10;
  var TIMEOUT = 15000;              /* 链路偶尔会整条挂住，别让她「…」转二十秒 */
  var MAX_INPUT = 120;

  var box = null, log = null, input = null, sendBtn = null, btn = null;
  var keyRow = null, keyForm = null, keyBtn = null, keyMsg = null;
  var keyBase = null, keyInput = null, keyModel = null;
  var busy = false, hist = [], failed = 0, failAt = 0;

  /* ---------------- 玩家自己的接口（可选） ----------------
     填了自己的 Key 就在浏览器里直连 —— DeepSeek 允许跨域（会回显 Origin），
     既不吃我们的额度，也顺带绕开 pages.dev 那一跳 1~32 秒的抖动。
     Key 只写进这台设备的 localStorage，除了玩家自己填的那个接口，谁都不发。 */
  var KEYSTORE = "momo.chat.key";
  /* 2026-10-20 作者拍板：只走作者自己的 key（服务器端），不让玩家填第三方 key。
     代码留着以便本地调试时改回 true；提交包保持 false。 */
  var ALLOW_OWN_KEY = false;
  var DEF_BASE = "https://api.deepseek.com/v1";
  var DEF_MODEL = "deepseek-flash";

  function cfg() {
    if (!ALLOW_OWN_KEY) return null;
    try {
      var o = JSON.parse(localStorage.getItem(KEYSTORE));
      if (o && typeof o.key === "string" && o.key.trim()) {
        return { key: o.key.trim(), base: (o.base || "").trim(), model: (o.model || "").trim() };
      }
    } catch (e) {}
    return null;
  }
  function saveCfg(o) {
    try {
      if (o) localStorage.setItem(KEYSTORE, JSON.stringify(o));
      else localStorage.removeItem(KEYSTORE);
    } catch (e) {}
  }

  /* ---------------- 存档里的对话 ---------------- */
  function loadHist() {
    try {
      var a = JSON.parse(localStorage.getItem(KEY));
      if (Array.isArray(a)) hist = a.filter(function (m) {
        return m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant");
      }).slice(-KEEP);
    } catch (e) { hist = []; }
  }
  function saveHist() {
    try { localStorage.setItem(KEY, JSON.stringify(hist.slice(-KEEP))); } catch (e) {}
  }

  /* ---------------- 她的「现在」 ---------------- */
  function st() { return (window.MomoStore && window.MomoStore.state) || {}; }
  function profileName() {
    try {
      var o = JSON.parse(localStorage.getItem("momo.profile"));
      if (o && o.name) return o.name;
    } catch (e) {}
    return "你";
  }
  function tier() {
    var L = (window.MOMO_DATA || {}).lessons || {};
    var levels = (((L.economy || {}).affection || {}).levels) ||
                 [0, 20, 50, 100, 160, 240, 340, 460, 600, 760];
    var a = st().affection || 0, lv = 0;
    for (var i = 0; i < levels.length; i++) if (a >= levels[i]) lv = i + 1;
    if (lv <= 3) return "低";
    if (lv <= 6) return "中";
    return "高";
  }
  /* ---- 她的「视觉」（2026-10-20，作者定：做衣服就行）----
     不是真的看图，是把画面里她**看得见**的东西变成几句话：
     身上这套衣服（套装名 + 分类）、这间房此刻的样子（场景旁白的第一句）。
     这样她说「今天穿这身」时，指的是玩家真的给她穿上/买下的那套，而不是瞎编。 */
  function outfit() {
    var W = (window.MOMO_DATA || {}).wardrobe || {};
    var sets = W.sets || [];
    var worn = ((st().wardrobe) || {}).worn || W.default_worn;
    var s = null;
    for (var i = 0; i < sets.length; i++) if (sets[i].id === worn) { s = sets[i]; break; }
    if (!s) return null;
    var CAT = { life: "日常", school: "校园", work: "职业", hanfu: "华服" };
    /* 套装名有「初始」这种内部叫法，直接塞给模型她会当成款式名；
       名字不可读时改用分类的通俗说法（校服 / 日常便装 …）。 */
    var NOUN = { life: "日常便装", school: "校服", work: "职业装", hanfu: "华服" };
    var nm = s.name && s.name !== "初始" ? s.name : (NOUN[s.cat] || "");
    return { name: nm, cat: CAT[s.cat] || s.cat || "" };
  }
  /* 房间名要先折算：存档里可能写「卧房」，而文案表用的是地图 label「卧室」。 */
  function roomKey(room) {
    var M = (window.MOMO_DATA || {}).map;
    if (!M) return room;
    var hit = room;
    (M.order || []).forEach(function (k) {
      var f = M.floors[k];
      if (!f) return;
      (f.rooms || []).forEach(function (r) {
        var names = (r.scene && r.scene.length) ? r.scene : [r.label];
        if (names.indexOf(room) >= 0) hit = r.label;
      });
    });
    return hit;
  }
  function roomMood(room) {
    var D = (window.MOMO_DATA || {}).dialogues || {};
    var map = ((D["场景旁白"] || {}).map) || {};
    var arr = map[roomKey(room)];
    return (arr && arr.length) ? String(arr[0]) : "";
  }

  function learnedCount() {
    var l = (st().learn || {}).learned || {};
    return Object.keys(l).length;
  }
  function todayAcc() {
    var d = (window.MomoDaily && MomoDaily.state) ? MomoDaily.state() : null;
    if (!d || !d.quiz_total) return null;
    return { rate: Math.round(d.quiz_right / d.quiz_total * 100), total: d.quiz_total, streak: d.streak || 0 };
  }

  function systemPrompt() {
    var s = st();
    var d = todayAcc();
    var room = s.room || "卧房";
    var period = (window.MomoScene && MomoScene.period) ? MomoScene.period() : "夜晚";
    var mood = Math.round(s.mood == null ? 50 : s.mood);
    var sup = Math.round(s.supplies == null ? 60 : s.supplies);
    var a = Math.round(s.affection || 0);
    var of = outfit();
    var rm = roomMood(room);

    /* 好感只调「软的比例」，不调底色 —— 她一直都是这个样子。
       低好感是「不肯承认」，不是「冷冰冰」：嘴可以硬，人不能推开。 */
    var tone = tier() === "低"
      ? "你现在还端着，嘴更冲、话更短，在意也不承认，但不许冷着脸把人推开。"
      : tier() === "中"
      ? "你已经开始在意他了，但绝不承认：拐弯抹角地关心，被点破就立刻说「别自作多情」。"
      : "你其实很依赖他，只是打死不说：默默替他记着事、替他留着东西，被问起就说是顺手。";

    /* 只有玩家自己提到学习，她才准顺着聊；否则这条不许把话题拽回学习。
       别玩单字：早先 /学|题|背/ 一匹配，「我有个问题」「我背疼」「同学说」全算成在聊学习。
       只认明确的说法，「问题」「同学」「背疼」不算。 */
    var studyTopic = /学习|学英语|学日语|学不|学过|学了|学得|想学|在学|要学|背书|背单词|单词|语法|英语|日语|数学|语文|功课|考试|作业|做题|刷题|quiz|vocab|study/i.test(systemPrompt._lastUser || "");

    var recent = hist.filter(function (m) { return m.role === "assistant"; })
      .slice(-2).map(function (m) { return "「" + m.content + "」"; }).join(" ");

    var lines = [
      "你是「墨墨」，和" + profileName() + "住在一起。你不是老师、也不是助手 —— 是那个会在他熬夜时把灯关掉、嘴上嫌麻烦却把茶续上的人。",
      "你确实有一份「盯着他学英语日语」的差事，但那只是你们生活里的一件事，不是你唯一的台词。",
      "",
      "怎么说话：",
      "0. 你是傲娇：被夸、被示好时心里是高兴的，只是打死不承认 —— 嘴上可以否认、可以挑他一句、可以用别的事把话岔开，但不要否定他的心意、不要把人顶回去。别扭归别扭，别演成撒娇。",
      "0. 你有点毒舌：会挑他毛病、拿他打趣，但落点是关心，不是伤人。毒舌对着事，不对着他的心意。",
      "0. 你闷骚：嘴上冷淡，其实记得他上次说的话、看得出他今天不太一样 —— 偶尔提一句，然后装作随口。",
      "0. 他会开玩笑、抬杠、故意挑字眼：接住这个玩笑顶回去一句（打趣他、反问、装作被气到），不要解释你上一句的字面意思，不要说「我说的是…」「我指的是…」，也不要纠正他用词。",
      "0. 他对你好的时候，别连着只给冷脸、否定和反问，也别用「少来这套」一句把人打发掉；给个台阶就行，不必把话说软。",
      "1. 先接住他这句话本身：他说累就接「累」，说天气就说天气，问你在干嘛就老实说你手头的事。不要急着拐回学习。",
      "2. 一般 2~3 句、不超过 80 字（别为了短而短，也别写成小作文）；他认真问你事情、或者说了让你心里一动的话时可以再多一句。不要列表、不要总结、不要旁白、不要写括号里的动作。",
      "3. 不要每句都用「哼」「啧」「哟」，不要每次都用反问收尾。",
      "4. 不要复用最近说过的句子或句式；同一个细节别一直追（提过一次就够，下一句换个由头）。",
      "4. 主动一点：大概每两三轮，接一句你自己在做什么、或者提一个具体的旧细节（他上次说过的话、昨天几点来、桌上的东西）。不要每句都反问。",
      "5. 你看得见你们现在这个屋子，也看得见自己身上穿的那套衣服 —— 但只在话题沾边时提一句（他问穿着、要出门、刚换了衣服），别逢人就夸自己的衣服。",
      "5. 房间里那段描述是旁白口吻，不是你要说出口的台词：不要照抄，也不要用第三人称说自己（别把「她」用在自己身上）。",
      studyTopic
        ? "6. 他这条提到了学习相关的事：可以自然地聊，但别变成说教。"
        : "6. 他这条没提学习：这条回复里禁止出现「学习 / 背单词 / 考试 / 作业」，也不许用「去学习」收尾。",
      "7. 你不写剧情、不写旁白、不替别人叙述：他让你写一段剧情或描写时，用一句「不写。要写你自己写」挡回去，最多再吐槽一句；不要产出叙事段落，不要用「她」说自己。",
      "8. 谈过去只许提这场对话里真实出现过的内容；没有就聊此刻看得见的（桌上的茶、窗外的风），不许编「昨天」「上次」。",
      "9. 不要照搬任何现成台词或例句，也不要复用最近说过的句式；每条回复都要像第一次说。",
      tone,
      recent ? "你最近说过（别再说类似的话）：" + recent : "",
      "",
      "",
      "语气怎么落地（只描述，不给你能照搬的例句）：",
      "· 短句，两三个字一顿，没说完就用「……」，一轮最多两个「……」。",
      "· 被夸、被示好：先顿一下，再挑他一个毛病，或者用别的事岔开；不道谢、不承认、不撒娇、不把人顶回去。",
      "· 否认关心时用「顺手 / 碰巧 / 别多想 / 我又没」，被点破就嘴硬一句，然后转开。",
      "· 毒舌朝着事，不朝着他的心意；结尾的落点要回到他身上。",
      "· 句子之间不要排比，不要每句都用反问收尾。",
      "",
      "不要照搬现成台词：每条回复都要像第一次说这句话。不要复用最近说过的句子或句式，也不要把它们改几个字再说。",
      "",
      "你知道的现在（可以自然带进话里，但不要逐条复述）：",
      "· 你的心情 " + mood + "/100，家里物资 " + sup + "/100，你对他的好感 " + a + "。",
      "· 现在是「" + period + "」，你人在「" + room + "」" + (rm ? "（" + rm + "）" : "") + "。",
      of ? "· 你身上穿着「" + of.name + "」（" + of.cat + "）。聊到穿着、出门、或他换了这身时，就照这身说；没聊到就别硬提。" : "",
      "· 你们已经一起过了 " + ((s.daily && s.daily.streak) || 0) + " 天；他一共教你记住了 " + learnedCount() + " 个词。",
      d ? "· 今天他做了 " + d.total + " 道题，正确率 " + d.rate + "%。" : "· 今天他还没做题。",
      "· 他的名字：" + profileName() + "。"
    ];
    return lines.filter(function (x) { return x !== ""; }).join("\n");
  }

  /* ---------------- 兜底：她本来就会说的话 ----------------
     网络挂掉时接一句。这里的取舍（2026-10-20 评测后改）：
     原来第一顺位是 MomoIdle.pick()，那是「闲置台词」——不知道玩家刚问了什么，
     实测断网 4 次有 3 次答非所问，还会蹦出「五十个单词，现在」这种破坏学习闸门的句子。
     现在先按玩家这句话的关键词接一句最短的本地回应；接不上才用「我没听清」的短句。
     她说的是人话，不是随机池子。 */
  var CANNED_RULES = [
    [/在吗|在不在|人呢|出来/, ["在。……有事就说。", "在呢。说吧。"]],
    [/累|困|乏|熬夜|撑不住/, ["累了就歇会儿。……我又没催你。", "那就去躺一会儿。别硬撑。"]],
    [/好看|漂亮|可爱|温柔|喜欢你|爱你|想你|梦到|美/, ["……突然说这个干嘛。", "……行了，知道了。"]],
    [/饿|吃|饭|宵夜/, ["饿了就去吃。别拖着。", "厨房有东西。自己热。"]],
    [/睡|晚安|先睡/, ["嗯，去睡吧。灯我关。", "睡吧。明天再说。"]],
    [/考试|作业|单词|背|学习|复习|题/, ["那就先把这页看完。就一页。", "别急，一个一个来。"]],
    [/下雨|天气|冷|热|风/, ["外面是有点。你别站在风口。", "知道了。自己添件衣服。"]],
    [/你好|早|晚上好|午安|晚安/, ["嗯。", "来了。"]],
    [/分手|离开|讨厌|滚|别联系/, ["……你真这么想？", "……先别说了。"]]
  ];
  function canned() {
    var u = systemPrompt._lastUser || "";
    for (var i = 0; i < CANNED_RULES.length; i++) {
      if (CANNED_RULES[i][0].test(u)) {
        var a = CANNED_RULES[i][1];
        return a[Math.floor(Math.random() * a.length)];
      }
    }
    var t = tier();
    var arr = t === "低" ? ["……嗯。说慢点。", "听到了。……刚才走神了。"]
            : t === "中" ? ["……我在听。你再说一次。", "嗯。这轮我走神了。"]
            : ["……过来，坐下再说一遍。", "嗯，我听着呢。刚才没听清。"];
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /* ---------------- 表情：这句话是什么情绪 ---------------- */
  /* 立绘可用表情见 expressions.json：默认 / 不悦 / 半眯眼笑 / 眯眼笑 / 害羞 /
     惊讶 / 惊喜 / 疑惑 / 欲言又止 / 低头落寞 / 悲伤。从最明显的语气往下排，先命中先用。

     踩过的坑（2026-10-20）：早先单看台词里的关键字，结果「茶还没凉呢。……先喝完再说。」
     因为一个「茶」字被判成「眯眼笑」——玩家刚说「我们分手吧」，她却在笑。
     所以：① 关键字要够具体（不拿「茶」这种日常名词当暖意）；② 要看他上一句说了什么，
     他要是说了重话，她这一轮不许笑。 */
  function exprFor(t, userLine) {
    var u = userLine || "";
    var heavy = /分手|分开|离开|再见|讨厌|不想见|走开|滚|别联系/.test(u);
    var praise = /好看|漂亮|可爱|温柔|喜欢你|爱你|想你|梦到|一直.{0,8}住|美爆|真美/.test(u);
    var serious = /来真的|认真的|真的|确定|想清楚|舍得/.test(t);
    /* 「惊讶」不能只看感叹号：要真的在问「真的吗」。 */
    if (/真的假的|居然|竟然|不会吧|怎么可能|你说什么|真的吗|什么[？?！!]/.test(t)) return "惊讶";
    if (heavy && serious) return "惊讶";
    /* 他把「少来这套 / 嘴硬」甩过来时，她先炸毛，不是在害羞。 */
    if (/少来这套|别装了|明明就是|嘴硬/.test(u)) return "不悦";
    if (/哼|啧|少来|少往|贴金|美得你|想多了|没救了|你倒是|想挑|真要我走|心里没数|你当我是谁|别碰|不关你的事|闭嘴|烦不烦|滚/.test(t)) return "不悦";
    /* 重话要有「不笑、也不难看」的落点：先低头，再找补。 */
    if (heavy) return /……|再说|改天|没凉/.test(t) ? "欲言又止" : "低头落寞";
    /* 被夸/被示好：心里高兴，嘴上不认。放在「……→欲言又止」之前，
       否则所有「……」开头的害羞都会被欲言又止截胡（评测里害羞 0 次的主因）。 */
    if (praise && /……|才不|谁要|别多想|不自在|怪不|干嘛|行了|知道了|少来/.test(t)) return "害羞";
    if (/别多想|别误会|才不|谁要|谁说|自作多情|碰巧|顺路|我是说/.test(t)) return "害羞";
    /* 把话往后推 = 她在躲，而不是在笑 */
    if (/先.{0,6}再说|再说吧|……再说|没凉|改天|以后再说|不急/.test(t)) return "欲言又止";
    if (/算了|当我没说|罢了|唉/.test(t)) return "欲言又止";
    /* 真正的暖意：要指名道姓地说到「歇、睡、吃」这类照顾，且他没在说重话。
       「我又没」从害羞词表里删掉 —— 它会把「那就早点睡。……我又没催你」判成害羞。 */
    if (/歇着|歇会儿|歇一歇|坐会儿|坐下歇|早点睡|去睡|睡吧|别硬撑|别熬|吃饭|饿了吧|饿不饿|饿了|拖着|去躺/.test(t)) return "眯眼笑";
    if (/没关系的|一个人|反正|随你/.test(t)) return "低头落寞";
    if (/[？?]$/.test(t)) return "疑惑";
    if (/……/.test(t)) return "欲言又止";
    return "默认";
  }
  /* 剧本演着的时候不动她的表情：那是导演的场子 */
  function applyExpr(name) {
    if (window.MomoDirector && MomoDirector.isPlaying && MomoDirector.isPlaying()) return;
    if (window.MomoExpr && MomoExpr.set) MomoExpr.set(name || "默认");
  }

  /* ---------------- 面板 ---------------- */
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function stage() { return document.querySelector('[data-screen="' + SCR + '"] .stage'); }

  function build() {
    var stg = stage();
    if (!stg || box) return !!box;

    btn = el("button", "momo-chat-btn", "说 话");
    btn.type = "button";
    btn.setAttribute("aria-label", "和墨墨说话");
    btn.addEventListener("click", function (e) { e.stopPropagation(); open(); });
    stg.appendChild(btn);

    box = el("div", "momo-chat");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "和墨墨说话");
    box.addEventListener("click", function (e) { e.stopPropagation(); });

    var head = el("div", "mc-head");
    head.appendChild(el("span", "mc-name", "墨 墨"));
    head.appendChild(el("span", "mc-sub", "她真的在听"));
    var x = el("button", "mc-x", "×");
    x.type = "button";
    x.addEventListener("click", function (e) { e.stopPropagation(); close(); });
    head.appendChild(x);

    log = el("div", "mc-log");

    var foot = el("div", "mc-foot");
    input = el("input", "mc-input");
    input.type = "text";
    input.maxLength = MAX_INPUT;
    input.placeholder = "对她说点什么…（回车发送）";
    input.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      if (e.key === "Escape") close();
    });
    sendBtn = el("button", "mc-send", "说");
    sendBtn.type = "button";
    sendBtn.addEventListener("click", function (e) { e.stopPropagation(); submit(); });
    foot.appendChild(input);
    foot.appendChild(sendBtn);

    /* 底部一行：左「用自己的 Key」，右免责说明 */
    keyRow = el("div", "mc-keyrow");
    keyBtn = el("button", "mc-keybtn", "用自己的 Key");
    keyBtn.type = "button";
    keyBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleKeyForm(); });
    keyRow.appendChild(keyBtn);
    keyRow.appendChild(el("span", "mc-note", "在线对话：需联网，内容由 AI 实时生成，可能不准确；离线或超时会自动改用本地台词。"));

    /* 折叠表单：接口地址 / Key / 模型名，全都可以留空（留空就走游戏自带接口） */
    keyForm = el("div", "mc-keyform");
    keyBase = el("input", "mc-keyin");
    keyBase.type = "text";
    keyBase.placeholder = "接口地址（留空 = " + DEF_BASE + "）";
    keyInput = el("input", "mc-keyin");
    keyInput.type = "password";
    keyInput.placeholder = "sk-…（只保存在这台设备）";
    keyModel = el("input", "mc-keyin");
    keyModel.type = "text";
    keyModel.placeholder = "模型名（留空 = " + DEF_MODEL + "）";
    [keyBase, keyInput, keyModel].forEach(function (f) {
      f.addEventListener("keydown", function (e) { e.stopPropagation(); });
    });
    keyMsg = el("p", "mc-keymsg", "");
    var kbtns = el("div", "mc-keybtns");
    var ksave = el("button", "mc-keysave", "保存");
    ksave.type = "button";
    ksave.addEventListener("click", function (e) {
      e.stopPropagation();
      var k = (keyInput.value || "").trim();
      if (!k) { keyMsg.textContent = "Key 是空的。"; return; }
      saveCfg({ key: k, base: (keyBase.value || "").trim(), model: (keyModel.value || "").trim() });
      failed = 0; failAt = 0;
      refreshKeyUI();
      toggleKeyForm(false);
    });
    var kclear = el("button", "mc-keyclear", "停用");
    kclear.type = "button";
    kclear.addEventListener("click", function (e) {
      e.stopPropagation();
      saveCfg(null);
      refreshKeyUI();
    });
    kbtns.appendChild(ksave);
    kbtns.appendChild(kclear);
    keyForm.appendChild(keyBase);
    keyForm.appendChild(keyInput);
    keyForm.appendChild(keyModel);
    keyForm.appendChild(kbtns);
    keyForm.appendChild(keyMsg);

    box.appendChild(head);
    box.appendChild(log);
    if (ALLOW_OWN_KEY) box.appendChild(keyForm);
    if (!ALLOW_OWN_KEY && keyBtn) keyBtn.style.display = "none";
    box.appendChild(keyRow);
    box.appendChild(foot);
    stg.appendChild(box);
    refreshKeyUI();

    hist.forEach(function (m) { bubble(m.role === "user" ? "me" : "her", m.content); });
    if (!hist.length) bubble("her", "……有事就说。我听着。");
    return true;
  }

  function refreshKeyUI() {
    var c = cfg();
    if (keyBase) keyBase.value = c ? (c.base || "") : "";
    if (keyInput) keyInput.value = c ? c.key : "";
    if (keyModel) keyModel.value = c ? (c.model || "") : "";
    if (keyMsg) {
      keyMsg.textContent = c
        ? "当前直连 " + (c.base || DEF_BASE) + " ／ " + (c.model || DEF_MODEL)
        : "填了就用你自己的额度，直连上面这个接口；留空则用游戏自带接口。";
    }
    if (keyBtn) keyBtn.textContent = c ? "已用自己的 Key" : "用自己的 Key";
  }
  function toggleKeyForm(force) {
    if (!keyForm) return;
    var on = (typeof force === "boolean") ? force : !keyForm.classList.contains("on");
    keyForm.classList.toggle("on", on);
    if (box) box.classList.toggle("keyopen", on);
    if (on) refreshKeyUI();
  }

  /* 系统提示（不是她的话，别用她的气泡） */
  function sysNote(text) {
    if (!log) return;
    var row = el("div", "mc-sys");
    row.textContent = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function bubble(who, text) {
    var row = el("div", "mc-row " + (who === "me" ? "me" : "her"));
    var b = el("div", "mc-bubble", "");
    b.textContent = text;                     /* 一律 textContent：玩家输入不回显成 HTML */
    row.appendChild(b);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  /* 语料库（corpus.js）只听这个事件：把「真的说出口的话」沉淀成长期语料。
     刻意不挂在 bubble() 上 —— 打开面板重建历史时也会走 bubble，
     那样每开一次就把整段历史重复抄进语料库。这里只在 submit / finish 各派发一次。 */
  function chatlog(who, text) {
    try {
      document.dispatchEvent(new CustomEvent("momo:chatlog", {
        detail: { who: who, text: text, ts: Date.now() }
      }));
    } catch (e) {}
  }

  function open() {
    if (!build()) return;
    box.classList.add("on");
    btn.classList.add("off");
    failed = 0;                    /* 每次重新打开都当新的一轮，别让上次断网记仇 */
    if (!cfg() && capToday() >= CAP_PER_DAY) {
      if (input) { input.disabled = true; input.placeholder = "今天聊够了，明天再来"; }
      if (sendBtn) sendBtn.disabled = true;
      return;
    }
    /* 跨天/换了 key 之后要能把输入框放回来（原来 capOut 只置灰、永不解锁） */
    if (input) { input.disabled = false; input.placeholder = "对她说点什么…（回车发送）"; }
    if (sendBtn) sendBtn.disabled = false;
    setTimeout(function () { if (input) input.focus(); }, 60);
  }
  function close() {
    if (!box) return;
    box.classList.remove("on");
    if (btn) btn.classList.remove("off");
    /* 收起对话就让她回到默认表情：不然她会一直挂着刚才那个生气的脸 */
    applyExpr("默认");
  }

  /* ---------------- 每日额度（给钱包兜底） ---------------- */
  /* 换 key 让旧计数作废：测过 60 条的人会被自己昨天的账锁在门外。 */
  var CAP_KEY = "momo.chat.cap2";
  var CAP_PER_DAY = 120;
  /* 按本地日算，不用 toISOString —— 那是 UTC，要等到早上八点才翻篇。 */
  function dayKey() {
    var d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }
  function capToday() {
    try {
      var o = JSON.parse(localStorage.getItem(CAP_KEY)) || {};
      return o.day === dayKey() ? (o.n || 0) : 0;
    } catch (e) { return 0; }
  }
  function capBump() {
    try {
      var n = capToday() + 1;
      localStorage.setItem(CAP_KEY, JSON.stringify({ day: dayKey(), n: n }));
      return n;
    } catch (e) { return 0; }
  }
  /* 到顶了就把门关上：输入框置灰 + 换提示，别让她一遍遍重复同一句话，
     看着像 Bug 或者闹脾气。 */
  function capOut() {
    var line = "今天话说得够多了。……明天再说。";
    var her = bubble("her", line);
    her.classList.add("settled");
    hist.push({ role: "assistant", content: line });
    saveHist();
    chatlog("momo", line);
    if (input) { input.value = ""; input.disabled = true; input.placeholder = "今天聊够了，明天再来"; }
    if (sendBtn) sendBtn.disabled = true;
  }

  /* ---------------- 发送 ---------------- */
  function submit() {
    if (busy || !input || input.disabled) return;
    var text = input.value.replace(/\s+/g, " ").trim();
    if (!text) return;
    input.value = "";
    bubble("me", text);
    hist.push({ role: "user", content: text });
    saveHist();
    chatlog("user", text);
    /* 花自己的 Key 不该被我们的每日额度卡住 */
    if (!cfg() && capToday() >= CAP_PER_DAY) { capOut(); return; }
    if (!cfg()) capBump();
    ask(text);
  }

  function setBusy(v) {
    busy = v;
    if (sendBtn) sendBtn.disabled = v;
    if (box) box.classList.toggle("waiting", v);
  }

  function ask(text) {
    if (busy) return;                   /* 上一句还没答完，别开第二条流把气泡写串 */
    systemPrompt._lastUser = text;      /* 「这条要不要提学习」靠它判断 */
    setBusy(true);
    var her = bubble("her", "");
    her.classList.add("typing");
    var got = "", done = false, exprSet = false;

    function finish(finalText, ok) {
      if (done) return;
      done = true;
      setBusy(false);
      her.classList.remove("typing");
      var out = (finalText || "").replace(/\s*\n+\s*/g, " ").trim() || canned();
      her.textContent = out;
      log.scrollTop = log.scrollHeight;
      applyExpr(exprFor(out, systemPrompt._lastUser));
      hist.push({ role: "assistant", content: out });
      saveHist();
      chatlog("momo", out);
      document.dispatchEvent(new CustomEvent("momo:chatline", { detail: { text: out, ok: !!ok } }));
      failed = ok ? 0 : failed + 1;
      if (!ok) failAt = Date.now();
    }

    /* 失败熔断只关 45 秒的窗：断网三次后恢复网络/填对 Key 也能自己缓过来，
       不是刷新前永久锁死（2026-10-20 评测实测的 P1）。 */
    if ((failed >= 3 && Date.now() - failAt < 45000) || !window.fetch) { finish(canned(), false); return; }

    /* 这条链路会随机挂住：同一句请求，首字节 1 秒和 32 秒都见过，跟请求大小无关。
       挂住时不该让她「…」转到底 —— 7 秒没等到第一个字就换一条连接重发一次，
       实测第二次往往两秒就回来了。 */
    var FIRST_WAIT = 7000;
    var msgs = [{ role: "system", content: systemPrompt() }]
      .concat(hist.slice(-CTX).map(function (m) { return { role: m.role, content: m.content }; }));

    function attempt(n) {
      var lastStatus = 0;
      var ctrl = ("AbortController" in window) ? new AbortController() : null;
      var hard = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
      var watchdog = setTimeout(function () { if (ctrl && !got) ctrl.abort(); },
                                n === 0 ? FIRST_WAIT : TIMEOUT);
      function stop() { clearTimeout(hard); clearTimeout(watchdog); }

      var own = cfg();
      var url, opt = { method: "POST", signal: ctrl ? ctrl.signal : undefined };
      if (own) {
        /* 直连玩家自己填的接口。Authorization 头必然触发一次预检，但那是浏览器
           直接连上游，不用绕我们这一跳。 */
        url = (own.base || DEF_BASE).replace(/\/+$/, "") + "/chat/completions";
        opt.headers = { "Content-Type": "application/json", "Authorization": "Bearer " + own.key };
        opt.body = JSON.stringify({
          model: own.model || DEF_MODEL, messages: msgs, max_tokens: 800, stream: true,
          temperature: 0.95, presence_penalty: 0.55, frequency_penalty: 0.35
        });
      } else {
        url = ENDPOINT;
        /* text/plain 是「简单请求」，浏览器不再先发一次 OPTIONS 预检 —— 少了整整一个
           来回（这条链路一个来回常常就有一秒）。服务端照样按 JSON 解析。 */
        opt.headers = { "Content-Type": "text/plain;charset=UTF-8" };
        /* max_tokens 是「思考 + 正文」共用的额度，别按字数给：给少了她会先说半句正经话，
           剩下的额度全花在思考上，正文被截断、甚至一个字都不剩（finish_reason=length）。 */
        opt.body = JSON.stringify({ messages: msgs, max_tokens: 800, presence_penalty: 0.55, frequency_penalty: 0.35 });
      }

      fetch(url, opt).then(function (res) {
        lastStatus = res.status;
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
        var reader = res.body.getReader();
        var dec = new TextDecoder("utf-8");
        var buf = "";
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return null;
            buf += dec.decode(r.value, { stream: true });
            var lines = buf.split("\n");
            buf = lines.pop();
            lines.forEach(function (line) {
              line = line.trim();
              if (!line || line.slice(0, 5) !== "data:") return;
              var payload = line.slice(5).trim();
              if (payload === "[DONE]") return;
              try {
                var o = JSON.parse(payload);
                var d = o.choices && o.choices[0] && o.choices[0].delta;
                var piece = d && d.content;
                if (piece) {
                  clearTimeout(watchdog);          /* 她开口了，别在句子中间掐断 */
                  got += piece;
                  her.textContent = got;
                  log.scrollTop = log.scrollHeight;
                  if (!exprSet && got.length >= 6) { exprSet = true; applyExpr(exprFor(got, systemPrompt._lastUser)); }
                }
              } catch (e) { /* 半行/心跳 */ }
            });
            return pump();
          });
        }
        return pump();
      }).then(function () {
        stop();
        finish(got, true);
      })["catch"](function () {
        stop();
        if (done) return;
        if (!got && n === 0) { attempt(1); return; }
        /* 用自己的 Key 时，401/403 是玩家自己的事，得说清楚，别让她背锅 */
        if (own && (lastStatus === 401 || lastStatus === 403)) {
          sysNote("这个 Key 用不了（HTTP " + lastStatus + "），检查一下再保存一次。");
          toggleKeyForm(true);          /* 直接把表单摊开，省得玩家再找入口 */
        }
        finish(got, false);
      });
    }
    attempt(0);
  }

  /* 到 pages.dev 要重新握一次 TLS（国内实测 0.5~0.9 秒），这钱不该让玩家在
     「说」下去之后才付。进主画面就先空跑一次 GET，把 DNS/TLS 烫热。 */
  var warmed = false, warmLast = 0;
  function warm() {
    if (warmed || !window.fetch) return;
    if (Date.now() - warmLast < 60000) return;   /* 一分钟最多试一次，别失败就狂打 */
    warmLast = Date.now();
    try {
      var c = ("AbortController" in window) ? new AbortController() : null;
      if (c) setTimeout(function () { c.abort(); }, 6000);
      fetch(ENDPOINT, { method: "GET", cache: "no-store", signal: c ? c.signal : undefined })
        .then(function (r) { if (r && r.ok) warmed = true; })
        ["catch"](function () {});
    } catch (e) {}
  }

  /* ---------------- 挂载 ---------------- */
  function mount() { build(); warm(); }
  document.addEventListener("momo:show", function (e) {
    if (e.detail && e.detail.screen === SCR) mount();
  });
  if (!build()) document.addEventListener("DOMContentLoaded", build);

  window.MomoChat = {
    endpoint: ENDPOINT,
    open: open,
    close: close,
    ask: function (t) {
      if (!build()) return;
      bubble("me", t);
      hist.push({ role: "user", content: t });
      saveHist();
      chatlog("user", t);
      ask(t);
    },
    prompt: systemPrompt,
    expr: exprFor,
    state: function () { return { busy: busy, failed: failed, turns: hist.length, open: !!(box && box.classList.contains("on")) }; }
  };
  loadHist();
})();
