/* 墨墨 · 对话代理（Cloudflare Worker）
   =====================================================================
   前端（H5 产物）直接 POST 到这里，由 Worker 替你拿着 API key 去请求模型。
   key 只存在 Worker 的 secret 里（wrangler secret put MOMO_API_KEY），
   永远不会出现在 dist/ 或前端代码里 —— 上传包是可以被任何人下载的。

   接口
     POST /chat    { messages: [{role, content}, ...], max_tokens?: number }
                   → text/event-stream（上游 SSE 原样透传，前端逐字打）
     GET  /ping    → { ok, model }   用来确认部署与 key 是否就位

   环境变量（wrangler secret / vars）
     MOMO_API_KEY   必填。DeepSeek / OpenAI / 任何 OpenAI 兼容服务的 key。
     MOMO_API_BASE  选填。默认 https://api.deepseek.com/v1
     MOMO_MODEL     选填。默认 deepseek-chat
     MOMO_ORIGIN    选填。允许的前端来源，默认 *（游戏从 TapTap 域名打开）

   几条要紧的规矩
     · 只认 messages 数组，条数与单条长度都夹死：这个入口是公开的，谁都能打。
     · 限流按 IP、每分钟 20 次，超了直接 429 —— 不做的话被当成免费 API 用。
     · 出错一律回 JSON（不要让前端拿到 HTML 报错页，那边解析会炸）。
   ===================================================================== */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

const MAX_TURNS = 14;          // 最多带最近 14 条上下文
const MAX_CHARS = 1200;        // 单条最长
const MAX_TOKENS = 260;        // 她一句话说不了那么长，省点钱也省点延迟
const RATE_PER_MIN = 20;

const hits = new Map();        // ip → { n, t }（isolate 级，够用）

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function limited(ip) {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now - cur.t > 60000) {
    hits.set(ip, { n: 1, t: now });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  cur.n++;
  return cur.n > RATE_PER_MIN;
}

function clampMessages(list) {
  const out = [];
  const slice = list.slice(-MAX_TURNS);
  for (const m of slice) {
    if (!m || typeof m.content !== "string") continue;
    const role = m.role === "assistant" || m.role === "system" ? m.role : "user";
    const content = m.content.slice(0, MAX_CHARS);
    if (!content.trim()) continue;
    out.push({ role, content });
  }
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname === "/ping") {
      return json({ ok: true, model: env.MOMO_MODEL || "deepseek-chat", hasKey: !!env.MOMO_API_KEY });
    }
    if (url.pathname !== "/chat" || req.method !== "POST") return json({ error: "not found" }, 404);

    const key = env.MOMO_API_KEY;
    if (!key) return json({ error: "worker 还没配置 MOMO_API_KEY" }, 500);

    const ip = req.headers.get("cf-connecting-ip") || "anon";
    if (limited(ip)) return json({ error: "慢一点，你说得太快了" }, 429);

    let body;
    try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }

    const messages = clampMessages(Array.isArray(body.messages) ? body.messages : []);
    if (!messages.length) return json({ error: "messages 为空" }, 400);

    const base = (env.MOMO_API_BASE || "https://api.deepseek.com/v1").replace(/\/+$/, "");
    const model = env.MOMO_MODEL || "deepseek-chat";
    const maxTokens = Math.min(MAX_TOKENS, Math.max(60, Number(body.max_tokens) || 200));

    let up;
    try {
      up = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.95,
          top_p: 0.95,
          presence_penalty: Math.min(1.5, Math.max(0, Number(body.presence_penalty) || 0.4)),
          frequency_penalty: Math.min(1.5, Math.max(0, Number(body.frequency_penalty) || 0.3)),
          stream: true
        })
      });
    } catch (e) {
      return json({ error: "上游连不上：" + (e && e.message) }, 502);
    }

    if (!up.ok || !up.body) {
      let detail = "";
      try { detail = (await up.text()).slice(0, 400); } catch (e) {}
      return json({ error: "上游 " + up.status, detail }, 502);
    }

    return new Response(up.body, {
      headers: {
        ...CORS,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no"
      }
    });
  }
};
