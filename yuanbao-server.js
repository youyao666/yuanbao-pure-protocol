// 元宝 OpenAI 兼容服务：零依赖纯 Node，把元宝网页版变成 http://127.0.0.1:8788/v1
// 端点: /v1/models | /v1/chat/completions(流式/非流式) | /v1/images/generations | /v1/images/edits | /healthz
// 环境变量: YUANBAO_PORT(默认8788) YUANBAO_API_KEY(可选，设置后校验 Bearer)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createSigner } = require('./qimei-standalone.js');

const signer = createSigner();
const PORT = process.env.YUANBAO_PORT || 8788;
const API_KEY = process.env.YUANBAO_API_KEY || '';
const BASE = 'https://yuanbao.tencent.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const cookie = JSON.parse(fs.readFileSync(process.env.YUANBAO_COOKIE
  ? process.env.YUANBAO_COOKIE
  : path.join(__dirname, 'yuanbao-cookie.json'), 'utf8'));

// OpenAI 模型名 → 元宝内部 chatModelId
const MODEL_ALIAS = {
  'deepseek': 'deep_seek_v3',
  'deepseek-v3': 'deep_seek_v3',
  'deep_seek_v3': 'deep_seek_v3',
  'hy3': 'hunyuan_gpt_175B_0404',
  'hunyuan': 'hunyuan_gpt_175B_0404',
  'hunyuan-t1': 'hunyuan_gpt_175B_0404',
  'hunyuan_gpt_175B_0404': 'hunyuan_gpt_175B_0404',
  'hy4': 'hunyuan_omnipotent_hy4',
  'hunyuan_omnipotent_hy4': 'hunyuan_omnipotent_hy4',
};
const resolveModel = name => MODEL_ALIAS[(name || '').toLowerCase()] || MODEL_ALIAS[name] || 'hunyuan_omnipotent_hy4';

// ---------------- 元宝协议层（与探针同源） ----------------
function baseHeaders(sec) {
  const h = {
    'Cookie': `hy_source=web; hy_user=${cookie.hy_user}; hy_token=${cookie.hy_token}`,
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'Origin': BASE,
    'Referer': `${BASE}/chat/${cookie.agentId}`,
    // 与探针/真实浏览器逐头对齐（网关校验头完整性，缺头会被判"服务繁忙"）
    'chat_version': 'v1', 'x-agentid': cookie.agentId, 'x-id': cookie.hy_user, 't-userid': cookie.hy_user,
    'x-requested-with': 'XMLHttpRequest', 'x-source': 'web', 'x-platform': 'win', 'x-language': 'zh-CN',
    'x-webversion': '2.87.2', 'x-commit-tag': '02746073', 'x-instance-id': '5', 'x-ybuitest': '0',
    'x-webdriver': '0', 'x-web-third-source': 'main', 'x-os-version': 'Windows(10)-Blink',
    'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9',
    'x-hy92': signer.getH38(), 'x-hy93': signer.getDeviceId() || signer.getH38(),
  };
  if (sec) Object.assign(h, sec);
  return h;
}
function signHeaders() {
  const s = signer.sign();
  if (!s['X-Uskey'] || s['X-Uskey'].length < 50) console.error('[sign] 警告: X-Uskey 异常, 长度 =', (s['X-Uskey'] || '').length);
  return { 'x-uskey': s['X-Uskey'], 'x-bus-params-md5': s['X-Bus-Params-Md5'], 'x-timestamp': s['X-Timestamp'] };
}

async function createConversation() {
  const res = await fetch(`${BASE}/api/user/agent/conversation/create`, {
    method: 'POST', headers: baseHeaders(signHeaders()), body: JSON.stringify({ agentId: cookie.agentId }),
  });
  if (!res.ok) throw new Error(`create HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const cid = (await res.json())?.id;
  if (!cid) throw new Error('create 未返回会话ID');
  return cid;
}

async function yuanbaoChat(cid, prompt, chatModelId, plugin, multimedia) {
  const body = {
    model: 'gpt_175B_0404', prompt, plugin,
    displayPrompt: prompt, displayPromptType: 1,
    agentId: cookie.agentId, isTemporary: false, projectId: '',
    chatModelId,
    supportFunctions: ['openAutoSearchSwitch', 'autoInternetSearch'],
    docOpenid: '',
    options: { imageIntention: { needIntentionModel: true, backendUpdateFlag: 2, intentionStatus: true } },
    multimedia: multimedia || [], supportHint: 1,
    chatModelExtInfo: JSON.stringify({
      modelId: chatModelId, agentModeModelSetting: { modelId: chatModelId },
      supportFunctions: { internetSearch: '' }, internetSearch: 'autoInternetSearch',
    }),
    applicationIdList: [], version: 'v2', extReportParams: null, isAtomInput: false,
    conversationId: cid, offsetOfHour: 8, offsetOfMinute: 0,
  };
  const res = await fetch(`${BASE}/api/chat/${cid}`, {
    method: 'POST', headers: baseHeaders(signHeaders()), body: JSON.stringify(body),
  });
  if (process.env.YUANBAO_DUMP_REQ) {
    try { fs.writeFileSync(path.join(__dirname, process.env.YUANBAO_DUMP_REQ), JSON.stringify(body, null, 2)); } catch {}
  }
  if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res;
}

// 逐事件回调读 SSE（供流式转发）；返回汇总 {text, think, images, usage}
async function readSse(res, onEvent) {
  const dec = new TextDecoder();
  const dump = process.env.YUANBAO_DUMP_SSE ? fs.createWriteStream(path.join(__dirname, process.env.YUANBAO_DUMP_SSE)) : null;
  const evCount = {};
  let buf = '', text = '', think = '';
  const images = [], usage = {};
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (dump && (line.startsWith('data: ') || line.startsWith('event: '))) dump.write(line + '\n');
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') {
        if (dump) dump.end();
        console.log('[sse] 事件统计:', JSON.stringify(evCount), 'text长度:', text.length);
        return { text, think, images, usage };
      }
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      evCount[ev.type] = (evCount[ev.type] || 0) + 1;
      if (ev.type === 'deepSearchAgent' && Array.isArray(ev.contents)) {
        for (const c of ev.contents) {
          if (c.type === 'think' && c.text) { think += c.text; onEvent?.('reasoning', c.text); }
          if (c.type === 'text' && c.text) { text += c.text; onEvent?.('content', c.text); }
          if (c.type === 'toolCall' && Array.isArray(c.items)) {
            for (const item of c.items) for (const m of (item.multimedias || []))
              if (m.mediaType === 'image' && m.url) images.push(m.url);
          }
        }
      } else if (ev.type === 'replace' && ev.replace?.assetId && Array.isArray(ev.replace.multimedias)) {
        for (const m of ev.replace.multimedias) if (m.mediaType === 'image' && m.url) images.push(m.url);
      } else if (ev.type === 'text' && ev.msg) { text += ev.msg; onEvent?.('content', ev.msg); }
      if (ev.type === 'meta' && ev.tokenUsageInfo) {
        usage.prompt = ev.tokenUsageInfo.promptTokens; usage.completion = ev.tokenUsageInfo.completionTokens;
        usage.total = ev.tokenUsageInfo.totalTokens;
      }
    }
  }
  return { text, think, images, usage };
}

function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}
const randHex = n => crypto.randomBytes(n).toString('hex').slice(0, n);

async function uploadImage(buf, fileName) {
  const { width, height } = pngSize(buf);
  const contentType = /\.jpe?g$/i.test(fileName) ? 'image/jpeg' : 'image/png';
  const r1 = await fetch(`${BASE}/api/resource/genUploadInfo`, {
    method: 'POST', headers: baseHeaders(),
    body: JSON.stringify({ fileName, docFrom: 'localDoc', docOpenId: '', needAuth: true }),
  });
  const info = await r1.json();
  if (!info.cosURL) throw new Error('genUploadInfo 失败: ' + JSON.stringify(info).slice(0, 150));
  const putRes = await fetch(info.cosURL, {
    method: 'PUT', headers: { authorization: info.putAuthorization, 'content-type': contentType }, body: buf,
  });
  if (!putRes.ok) throw new Error('COS PUT HTTP ' + putRes.status);
  await fetch(`${BASE}/api/resource/asyncFileParse`, {
    method: 'POST', headers: baseHeaders(),
    body: JSON.stringify({ resourceList: [{ resourceUrl: info.resourceUrl, type: 'image', size: buf.length, purpose: 'doc_reparse' }] }),
  });
  return {
    type: 'image', docType: 'image', url: info.resourceUrl, signUrl: '',
    fileName, size: buf.length, width, height,
    fileId: randHex(15), uploadStatus: 'success', progress: 100,
  };
}

// messages → 单条 prompt
// 注意：元宝会检测"用户：/元宝："式对话前缀并路由进搜索模式（实测 prompt 膨胀24倍、
// 输出碎片化），因此只发裸 prompt：system 前置 + 历史以间接表述附加 + 最后一条 user 原文
function messagesToPrompt(messages) {
  const sys = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n');
  const turns = messages.filter(m => m.role !== 'system' && m.role !== 'developer');
  const lastUser = turns[turns.length - 1]?.role === 'user' ? turns[turns.length - 1] : turns[turns.length - 1];
  const contentOf = m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  const history = turns.slice(0, -1);
  let prompt = '';
  if (sys) prompt += sys + '\n\n';
  if (history.length) {
    prompt += '先前的交流背景（供参考）：\n';
    for (const m of history) prompt += `- ${m.role === 'assistant' ? '此前的回答' : '此前的问题'}：${contentOf(m)}\n`;
    prompt += '\n';
  }
  prompt += contentOf(lastUser ?? { content: '' });
  return prompt;
}

// ---------------- OpenAI 适配层 ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function handleModels(req, res) {
  json(res, 200, {
    object: 'list',
    data: Object.keys(MODEL_ALIAS).map((id, i) => ({
      id, object: 'model', created: 1704067200 + i, owned_by: 'yuanbao',
    })),
  });
}

async function handleChat(req, res, body) {
  const model = resolveModel(body.model);
  const prompt = messagesToPrompt(body.messages || []);
  const stream = body.stream === true;
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);

  const cid = await createConversation();
  const upstream = await yuanbaoChat(cid, prompt, model, '', []);

  if (!stream) {
    const { text, think, usage } = await readSse(upstream);
    return json(res, 200, {
      id, object: 'chat.completion', created, model: body.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text, ...(think ? { reasoning_content: think } : {}) },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: usage.prompt || 0, completion_tokens: usage.completion || 0, total_tokens: usage.total || 0 },
    });
  }
  // 流式：SSE 转发
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
  });
  const sendChunk = delta => res.write('data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created, model: body.model,
    choices: [{ index: 0, delta, finish_reason: null }],
  }) + '\n\n');
  sendChunk({ role: 'assistant' });
  const { usage } = await readSse(upstream, (kind, piece) => {
    if (kind === 'content') sendChunk({ content: piece });
    if (kind === 'reasoning') sendChunk({ reasoning_content: piece });
  });
  res.write('data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created, model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: usage.prompt || 0, completion_tokens: usage.completion || 0, total_tokens: usage.total || 0 },
  }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleImageGen(req, res, body) {
  let prompt = body.prompt || '';
  if (!prompt) return json(res, 400, { error: { message: 'prompt required' } });
  // 元宝意图判定依赖绘画动词，缺了会走纯文字回复（实测 oneAgentId=main_agent_hy_for_pc）
  if (!/^(画|绘|生成|创作|draw|create|imagine)/i.test(prompt)) prompt = '画：' + prompt;
  const b64 = body.response_format === 'b64_json';
  const cid = await createConversation();
  const upstream = await yuanbaoChat(cid, prompt, 'hunyuan_omnipotent_hy4', 'Adaptive', []);
  const { images } = await readSse(upstream);
  const n = Math.max(1, Math.min(body.n || 4, images.length));
  let data = images.slice(0, n);
  if (b64) {
    data = await Promise.all(data.map(async u => {
      const r = await fetch(u);
      return { b64_json: Buffer.from(await r.arrayBuffer()).toString('base64') };
    }));
  } else {
    data = data.map(u => ({ url: u }));
  }
  json(res, 200, { created: Math.floor(Date.now() / 1000), data });
}

async function handleImageEdit(req, res, fields, files) {
  const prompt = fields.prompt || '';
  const imageFile = files.image || files.file;
  if (!prompt || !imageFile) return json(res, 400, { error: { message: 'prompt 与 image(multipart) required' } });
  const b64 = fields.response_format === 'b64_json';
  const mm = await uploadImage(imageFile.data, imageFile.filename || 'image.png');
  const cid = await createConversation();
  // 注意：带图时 plugin 必须为空串（'Adaptive' 会走图片理解分支，实测只出文字不出图）
  const upstream = await yuanbaoChat(cid, prompt, 'hunyuan_omnipotent_hy4', '', [mm]);
  const { images } = await readSse(upstream);
  let data = images.length ? images : [];
  if (b64 && data.length) {
    data = await Promise.all(data.map(async u => {
      const r = await fetch(u);
      return { b64_json: Buffer.from(await r.arrayBuffer()).toString('base64') };
    }));
  } else {
    data = data.map(u => ({ url: u }));
  }
  json(res, 200, { created: Math.floor(Date.now() / 1000), data });
}

// ---------------- 基础设施 ----------------
function readBody(req) {
  return new Promise((ok, bad) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', bad);
  });
}

// 极简 multipart/form-data 解析（够 edits 用）
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentNameSafe(contentType));
  const boundary = '--' + (m[1] || m[2]).trim();
  const fields = {}, files = {};
  const parts = [];
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    const next = buf.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = buf.slice(start + boundary.length + 2, next - 2); // 去 \r\n
    if (part.length) parts.push(part);
    start = next;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString('utf8');
    const data = part.slice(headerEnd + 4);
    const nameM = /name="([^"]*)"/.exec(headerText);
    const fileM = /filename="([^"]*)"/.exec(headerText);
    const ctM = /Content-Type:\s*(.+)/i.exec(headerText);
    if (!nameM) continue;
    if (fileM) files[nameM[1]] = { filename: fileM[1], contentType: ctM?.[1]?.trim() || 'application/octet-stream', data };
    else fields[nameM[1]] = data.toString('utf8');
  }
  return { fields, files };
}
const contentNameSafe = s => s || '';

const server = http.createServer(async (req, res) => {
  try {
    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      });
      return res.end();
    }
    if (API_KEY && req.url.startsWith('/v1/')) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${API_KEY}`) return json(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      return json(res, 200, { ok: true, h38: signer.getH38(), hy_user: cookie.hy_user });
    }
    if (req.method === 'GET' && req.url === '/v1/models') return handleModels(req, res);

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return await handleChat(req, res, body);
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return await handleImageGen(req, res, body);
    }
    if (req.method === 'POST' && req.url === '/v1/images/edits') {
      const raw = await readBody(req);
      const ct = req.headers['content-type'] || '';
      if (!ct.includes('multipart')) return json(res, 400, { error: { message: 'multipart/form-data required' } });
      const { fields, files } = parseMultipart(raw, ct);
      return await handleImageEdit(req, res, fields, files);
    }
    json(res, 404, { error: { message: 'not found: ' + req.url } });
  } catch (e) {
    json(res, 502, { error: { message: 'yuanbao upstream error: ' + e.message, type: 'upstream_error' } });
  }
});

server.listen(PORT, () => {
  console.log(`[yuanbao-server] OpenAI 兼容层就绪: http://127.0.0.1:${PORT}/v1`);
  console.log(`[yuanbao-server] 模型: ${Object.keys(MODEL_ALIAS).join(', ')}`);
  console.log(`[yuanbao-server] 鉴权: ${API_KEY ? '已开启 (YUANBAO_API_KEY)' : '关闭（局域网裸奔，注意）'}`);
});
