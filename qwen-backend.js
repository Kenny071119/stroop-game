// qwen-backend.js —— 正式版后端（一个服务同时：托管网页 + 转发百炼 + 限流防刷）
// 适配阿里云函数计算 FC「Web函数」：默认监听 9000，绑定 0.0.0.0。
//
// 它做三件事：
//   GET  任意路径        → 返回前端页面 math-analyzer.html（同目录）
//   POST 任意路径        → 把请求转发给百炼 chat/completions（用服务器持有的 Key）
//   OPTIONS              → CORS 预检
//
// 部署到函数计算：上传本文件 + math-analyzer.html，启动命令 `node qwen-backend.js`，
// 监听端口 9000，并在「环境变量」里配置 BAILIAN_API_KEY。
//
// 本地也能跑：BAILIAN_API_KEY=sk-你的key node qwen-backend.js  然后开 http://localhost:9000/
const http = require('http');
const fs = require('fs');
const path = require('path');

// ===== 配置（Key 从环境变量读，绝不写进代码）=====
const API_KEY = process.env.BAILIAN_API_KEY;                  // 必填：你的百炼 API Key
const PORT = process.env.PORT || 9000;                        // 函数计算 Web函数默认 9000
const UPSTREAM = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const ALLOWED_MODELS = new Set([                              // 与前端下拉选项一致，防止被刷贵模型
  'qwen-plus', 'qwen-turbo', 'qwen3.7-plus', 'qwen3.7-max',
  'qwen-vl-max-latest', 'qwen-vl-plus', 'qwen-vl-ocr',
]);

// ===== 读取前端页面（与本文件同目录）=====
let HTML = '<h1>缺少 math-analyzer.html，请和本文件一起部署</h1>';
try { HTML = fs.readFileSync(path.join(__dirname, 'math-analyzer.html'), 'utf8'); }
catch (e) { console.error('⚠️ 没读到 math-analyzer.html：', e.message); }

// ===== 简单按 IP 限流（固定时间窗）=====
const WINDOW_MS = 60 * 60 * 1000;                             // 1 小时
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT || 60);  // 每 IP 每小时最多次数
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let r = hits.get(ip);
  if (!r || now > r.reset) { r = { count: 0, reset: now + WINDOW_MS }; hits.set(ip, r); }
  r.count++;
  return r.count > MAX_PER_WINDOW;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const sendJSON = (res, code, obj) =>
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify(obj));

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // GET → 返回网页（同源托管前端，避免跨域）
  if (req.method === 'GET') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end('Method Not Allowed'); }

  // POST → 转发给百炼
  if (!API_KEY) return sendJSON(res, 500, { error: '服务器未配置 BAILIAN_API_KEY' });

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
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { ...CORS, 'Content-Type': 'application/json' });
    res.end(text);
  } catch (e) {
    sendJSON(res, 502, { error: String(e) });
  }
}).listen(PORT, '0.0.0.0', () => {     // 函数计算要求绑定 0.0.0.0
  console.log(`✅ 已启动: http://0.0.0.0:${PORT}  （网页 + 接口同源）`);
  if (!API_KEY) console.log('⚠️ 还没配置环境变量 BAILIAN_API_KEY，接口会报错，网页能打开。');
});
