/* 墨墨 · 主画面「氛围光效」
   一层暖米黄的细小光点：慢慢上浮、轻轻明灭、几乎看不清 —— 只做氛围，不参与任何逻辑。

   两条设计要点（前两版踩过的坑）：
     · 位置用「抖动网格」而不是纯随机。纯随机会扎堆、会在某些横向留出大片空档
       （看起来「只有半边有」）。这里把画面切成 cols×rows 个格子，一格一颗、
       在格内小幅抖动 —— 于是每一列都有光，疏密天然均匀。
       粒子飘出顶上时只换 y（回到画面下方），列永远不变，所以均匀性不会随时间散掉。
     · 光晕收得很紧（半径只有 0.8~1.8px，光晕是它的 3.4 倍 ≈ 3~6px）。
       大光晕 + 叠加混合会糊成一团「粗制滥造」的光斑，小光点才显得干净、高级。

   三条硬规矩：
     1. 不打点 —— pointer-events:none。elementFromPoint 永远命中不到它，
        所以主画面所有热区（学习 / 地图 / 头像 / 时间条）的命中判定一点不受影响。
     2. 压不到字 —— 它在 .stage 里的 DOM 顺序排在立绘之后、对话与按钮之前，
        光点会飘过墨墨，但不会盖到对话框、姓名条、按钮和时间条上。
     3. 不空转 —— 只有「主画面」是当前屏时才继续画；切走即停，切回来接着飘
        （粒子保留原位，不会重新撒一遍）。

   数量、亮度、颜色、速度都集中在 CONF 里 —— 想更密/更亮只改这一处。 */
(function () {
  "use strict";
  var CONF = {
    cols: 12, rows: 7,         // 抖动网格：12 列 × 7 行 = 84 颗，保证「哪儿都有、不扎堆」
    colors: [[255, 240, 208],  // 米黄
             [247, 214, 168]], // 暖金
    alpha: [0.16, 0.46],       // 基础透明度：低到只是「空气里有光」
    radius: [0.8, 1.8],        // 光点半径（舞台坐标 px）—— 小才精致
    halo: 3.4,                 // 光晕半径 = 光点半径 × 这个倍数（3~6px，收得很紧）
    coreShare: 0.30,           // 「亮核」占光晕半径的比例（0~1，其余是过渡）
    riseY: [4, 16],            // 上浮速度（px/秒）
    driftX: [2, 7],            // 横漂幅度（px/秒，正弦摆动）
    driftW: [0.10, 0.28],      // 横漂频率（弧度/秒）
    pulseW: [0.35, 0.90]       // 明灭频率（弧度/秒）
  };

  var scr = document.querySelector('[data-screen="主画面"]');
  var canvas = scr && scr.querySelector(".motes");
  if (!canvas || !canvas.getContext) return;
  var W = canvas.width, H = canvas.height;
  var ctx = canvas.getContext("2d");
  var colW = W / CONF.cols, rowH = H / CONF.rows;
  var motes = [], raf = 0, last = 0, drew = false;
  var reduced = false;
  try {
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { /* 老浏览器没有 matchMedia，按「允许动」处理 */ }

  function rand(a, b) { return a + Math.random() * (b - a); }

  /* col：所在列，飘出去后还回这一列 —— 横向均匀靠它守住 */
  function make(col, y) {
    var c = CONF.colors[Math.floor(Math.random() * CONF.colors.length)];
    return {
      col: col,
      x: col * colW + rand(colW * 0.08, colW * 0.92),
      y: y,
      r: rand(CONF.radius[0], CONF.radius[1]),
      a: rand(CONF.alpha[0], CONF.alpha[1]),
      rise: rand(CONF.riseY[0], CONF.riseY[1]) / 60,   // 换算成「每帧」
      drift: rand(CONF.driftX[0], CONF.driftX[1]) / 60,
      dw: rand(CONF.driftW[0], CONF.driftW[1]),
      pw: rand(CONF.pulseW[0], CONF.pulseW[1]),
      ph: rand(0, Math.PI * 2),
      rgb: c[0] + "," + c[1] + "," + c[2]
    };
  }

  /* 一格一颗：横向按列钉死，纵向先铺满整屏，之后靠上浮 + 底部补位自然错开 */
  function seed() {
    motes = [];
    for (var col = 0; col < CONF.cols; col++) {
      for (var row = 0; row < CONF.rows; row++) {
        motes.push(make(col, row * rowH + rand(0, rowH)));
      }
    }
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    /* 叠加混合：光点交叠处自然更亮，像真的空气里的光 */
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];
      var a = m.a * (0.6 + 0.4 * Math.sin(t * m.pw + m.ph));   // 明灭
      var R = m.r * CONF.halo;
      var g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, R);
      /* 三段色标：0 → 亮核，coreShare → 过渡，1 → 全透明。
         偏移必须落在 0~1 且递增，传半径进去会直接抛 IndexSizeError。 */
      g.addColorStop(0, "rgba(" + m.rgb + "," + a + ")");
      g.addColorStop(CONF.coreShare, "rgba(" + m.rgb + "," + (a * 0.45) + ")");
      g.addColorStop(1, "rgba(" + m.rgb + ",0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(m.x, m.y, R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    drew = true;
  }

  function step(now) {
    raf = window.requestAnimationFrame(step);
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    /* 换了屏就只歇着，不重画 —— 位置留到切回来那一刻 */
    if (!scr.classList.contains("active")) return;
    for (var i = 0; i < motes.length; i++) {
      var m = motes[i];
      m.y -= m.rise * dt * 60;
      m.x += Math.sin(now / 1000 * m.dw + m.ph) * m.drift * dt * 60;
      if (m.y < -m.r * CONF.halo) {                 // 飘出顶上 → 同一列从底下补一颗
        motes[i] = make(m.col, H + rand(8, 120));
      }
    }
    draw(now / 1000);
  }

  function start() {
    seed();
    /* 先静画一帧：即使一进来不是主画面（或用户关了动效），也有光在那里 */
    draw(0);
    if (reduced) return;                            // 关动效 = 只留一层静止的光点
    if (!raf) raf = window.requestAnimationFrame(step);
  }

  start();

  /* 供自动化验证；只读。columns 报告每一列的亮点数 —— 用来断言「均匀」 */
  window.MomoMotes = {
    state: function () {
      var d = ctx.getImageData(0, 0, W, H).data;
      var per = [], step = Math.floor(W / CONF.cols), lit = 0;
      for (var c = 0; c < CONF.cols; c++) per.push(0);
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var a = d[(y * W + x) * 4 + 3];
          if (a > 2) { lit++; per[Math.min(CONF.cols - 1, Math.floor(x / step))]++; }
        }
      }
      return {
        count: motes.length,
        size: [W, H],
        pointer: window.getComputedStyle(canvas).pointerEvents,
        drawn: drew,
        animated: !reduced && !!raf,
        lit: lit,
        columns: per
      };
    }
  };
})();