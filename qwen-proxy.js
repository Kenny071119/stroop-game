// qwen-proxy.js —— 本地 CORS 代理（仅本地测试用）
// 作用：浏览器无法直接跨域调用阿里云百炼，这个小代理把请求原样转发过去，
//      并补上 CORS 响应头，解决浏览器里的 “Failed to fetch / CORS” 报错。
// 你的 API Key 不写在这里：网页发请求时带的 Authorization 头会被原样转发。
//
// 运行：需要 Node 18 及以上（自带 fetch）。在终端执行  node qwen-proxy.js
const http = require('http');

const TARGET = 'https://dashscope.aliyuncs.com';   // 阿里云百炼
const PORT = 8787;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }   // 预检请求
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const upstream = await fetch(TARGET + req.url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers['authorization'] || '',   // 透传网页里填的 Key
      },
      body: Buffer.concat(chunks),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { ...CORS, 'Content-Type': 'application/json' });
    res.end(text);
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: String(e) }));
  }
}).listen(PORT, () => {
  console.log(`✅ 代理已启动: http://localhost:${PORT}  →  转发到 ${TARGET}`);
  console.log('   网页“接口地址”请填: http://localhost:' + PORT + '/compatible-mode/v1');
});
