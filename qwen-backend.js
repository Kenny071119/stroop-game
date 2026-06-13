// qwen-backend.js —— 正式版最小后端（持有 Key + 转发百炼 + 限流防刷）
// 与 qwen-proxy.js 的区别：proxy 是“测试版”用、透传用户自己填的 Key；
// 本后端是“正式版”用、Key 藏在服务器，前端/用户完全看不到。
//
// 运行（需要 Node 18+，自带 fetch）。先用环境变量传入 Key，再启动：
//   Mac/Linux:  BAILIAN_API_KEY=sk-你的key node qwen-backend.js
//   Windows  :  set BAILIAN_API_KEY=sk-你的key  然后  node qwen-backend.js
//
// 启动后，把前端正式版里的 PROD_API_BASE 填成：
//   http://localhost:8080/compatible-mode/v1     （本机自测）
//   https://你的域名/compatible-mode/v1          （部署到服务器后）
const http = require('http');

// ===== 配置（都从环境变量读，Key 绝不写进代码）=====
const API_KEY = process.env.BAILIAN_API_KEY;                  // 必填：你的百炼 API Key
const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';      // 上线建议改成你的网页域名，如 https://yourapp.com
const UPSTREAM = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
// 只允许这些模型，防止有人拿你的 Key 调贵模型刷钱
const ALLOWED_MODELS = new Set([
  'qwen3.7-max', 'qwen3.7-plus', 'qwen-plus',
  'qwen-vl-max-latest', 'qwen-vl-ocr',
]);

// ===== 简单按 IP 限流（固定时间窗）=====
const WINDOW_MS = 60 * 60 * 1000;                              // 1 小时
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT || 60);   // 每个 IP 每小时最多多少次
const hits = new Map();                                        // ip -> { count, reset }
function rateLimited(ip) {
  const now = Date.now();
  let r = hits.get(ip);
  if (!r || now > r.reset) { r = { count: 0, reset: now + WINDOW_MS }; hits.set(ip, r); }
  r.count++;
  return r.count > MAX_PER_WINDOW;
}

if (!API_KEY) {
  console.error('❌ 未设置环境变量 BAILIAN_API_KEY，无法启动。');
  process.exit(1);
}

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const sendJSON = (res, code, obj) =>
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify(obj));

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }     // CORS 预检
  if (req.method === 'GET') { res.writeHead(200, CORS); return res.end('ok'); }     // 健康检查
  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end('Method Not Allowed'); }

  // 取客户端 IP（部署在反向代理后时优先用 x-forwarded-for）
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) return sendJSON(res, 429, { error: '请求过于频繁，请稍后再试' });

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { return sendJSON(res, 400, { error: '请求体不是合法 JSON' }); }

  if (!ALLOWED_MODELS.has(body.model)) {
    return sendJSON(res, 400, { error: '不支持的模型: ' + body.model });
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
      body: JSON.stringify(body),                 // 直接把前端的请求体转发给百炼
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { ...CORS, 'Content-Type': 'application/json' });
    res.end(text);
  } catch (e) {
    sendJSON(res, 502, { error: String(e) });
  }
}).listen(PORT, () => {
  console.log(`✅ 正式版后端已启动: http://localhost:${PORT}`);
  console.log(`   前端 PROD_API_BASE 填: http://localhost:${PORT}/compatible-mode/v1`);
  console.log(`   限流: 每个 IP ${MAX_PER_WINDOW} 次/小时 | 允许模型: ${[...ALLOWED_MODELS].join(', ')}`);
});
