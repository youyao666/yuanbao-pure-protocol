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
// 工具调用总开关：YUANBAO_TOOLS=off 关闭（提示词注入式模拟，关闭后请求带 tools 也会被忽略）
const TOOLS_ENABLED = !/^off|0|false|no$/i.test(process.env.YUANBAO_TOOLS || '');
// 无水印开关：YUANBAO_WATERMARK_FREE=off 关闭（生图后从会话详情换 originUrl(h0) 原始版）
const WM_FREE_ENABLED = !/^off|0|false|no$/i.test(process.env.YUANBAO_WATERMARK_FREE || '');
const BASE = 'https://yuanbao.tencent.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const cookie = JSON.parse(fs.readFileSync(process.env.YUANBAO_COOKIE
  ? process.env.YUANBAO_COOKIE
  : path.join(__dirname, 'yuanbao-cookie.json'), 'utf8'));

// OpenAI 模型名 → 元宝内部 chatModelId（-search 后缀 = 强制联网搜索模式）
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
const SEARCH_SUFFIX = '-search';
function resolveModel(name) {
  const n = String(name || '');
  const search = n.toLowerCase().endsWith(SEARCH_SUFFIX);
  const base = search ? n.slice(0, -SEARCH_SUFFIX.length) : n;
  const chatModelId = MODEL_ALIAS[base.toLowerCase()] || MODEL_ALIAS[base] || 'hunyuan_omnipotent_hy4';
  return { chatModelId, search, display: n };
}

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

// 清理元宝富文本内联标记（如 [](@mark_underline=1)），OpenAI 客户端不识别
const cleanRich = s => s.replace(/\[\]\(@[a-z_]+=\d+\)/g, '');

// 逐事件回调读 SSE（供流式转发）；返回汇总 {text, think, images, usage}
async function readSse(res, onEvent) {
  const dec = new TextDecoder();
  const dump = process.env.YUANBAO_DUMP_SSE ? fs.createWriteStream(path.join(__dirname, process.env.YUANBAO_DUMP_SSE)) : null;
  const evCount = {};
  let buf = '', text = '', think = '';
  const images = [], usage = {}, citations = [];
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
        return { text, think, images, usage, citations };
      }
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      evCount[ev.type] = (evCount[ev.type] || 0) + 1;
      // 联网搜索引用（searchGuid.docs）
      if (ev.type === 'searchGuid' && Array.isArray(ev.docs)) {
        for (const d of ev.docs) if (d.url) citations.push({ title: d.title || d.url, url: d.url });
      }
      if (ev.type === 'deepSearchAgent' && Array.isArray(ev.contents)) {
        for (const c of ev.contents) {
          if (c.type === 'think' && c.text) { think += c.text; onEvent?.('reasoning', c.text); }
          if (c.type === 'text' && c.text) { const t = cleanRich(c.text); text += t; onEvent?.('content', t); }
          if (c.type === 'toolCall' && Array.isArray(c.items)) {
            for (const item of c.items) for (const m of (item.multimedias || []))
              if (m.mediaType === 'image' && m.url) images.push(m.url);
          }
        }
      } else if (ev.type === 'replace' && ev.replace?.assetId && Array.isArray(ev.replace.multimedias)) {
        for (const m of ev.replace.multimedias) if (m.mediaType === 'image' && m.url) images.push(m.url);
      } else if (ev.type === 'text' && ev.msg) { const t = cleanRich(ev.msg); text += t; onEvent?.('content', t); }
      if (ev.type === 'meta' && ev.tokenUsageInfo) {
        usage.prompt = ev.tokenUsageInfo.promptTokens; usage.completion = ev.tokenUsageInfo.completionTokens;
        usage.total = ev.tokenUsageInfo.totalTokens;
      }
    }
  }
  return { text, think, images, usage, citations };
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
  const last = turns[turns.length - 1];
  const contentOf = m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  const history = turns.slice(0, -1);
  let prompt = '';
  if (sys) prompt += sys + '\n\n';
  if (history.length) {
    prompt += '先前的交流背景（供参考）：\n';
    for (const m of history) {
      if (m.role === 'tool') {
        prompt += `- 工具返回结果：${contentOf(m)}\n`;
      } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const calls = m.tool_calls.map(c => `${c.function.name}(${c.function.arguments})`).join('; ');
        prompt += `- 此前请求调用工具：${calls}（等待结果中）\n`;
      } else {
        prompt += `- ${m.role === 'assistant' ? '此前的回答' : '此前的问题'}：${contentOf(m)}\n`;
      }
    }
    prompt += '\n';
  }
  prompt += contentOf(last ?? { content: '' });
  return prompt;
}

// ---------------- 工具调用（提示词注入式 function calling） ----------------
// 元宝协议不透传 tools，采用社区通行方案：工具定义注入 prompt，
// 解析模型输出的 <<TOOL_CALL>> 标记转换为 OpenAI tool_calls 格式。
function buildToolDirective(tools) {
  const defs = tools.map(t => {
    const f = t.function || t;
    return { name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } };
  });
  return [
    '你可以调用以下工具来获取回答问题所需的信息：',
    ...defs.map(d => `- 工具名：${d.name}\n  说明：${d.description}\n  参数JSON Schema：${JSON.stringify(d.parameters)}`),
    '',
    '规则：',
    '1. 当且仅当确实需要工具提供的信息时才调用；能直接回答就直接回答。',
    '2. 需要调用时，回复中只输出如下格式的一行（不要输出任何其它内容）：',
    '<<TOOL_CALL>>{"name":"工具名","arguments":{参数对象}}',
    '3. 输出调用后即停止，等待工具结果再继续。',
    '4. 绝不编造工具返回的结果。',
  ].join('\n');
}

function extractToolCall(text) {
  const idx = text.indexOf('<<TOOL_CALL>>');
  if (idx === -1) return null;
  const rest = text.slice(idx + '<<TOOL_CALL>>'.length);
  const start = rest.indexOf('{');
  const end = rest.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const call = JSON.parse(rest.slice(start, end + 1));
    if (!call.name) return null;
    return {
      name: call.name,
      arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}),
    };
  } catch { return null; }
}

const newCallId = () => 'call-' + crypto.randomBytes(10).toString('hex');

// ---------------- OpenAI 适配层 ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function handleModels(req, res) {
  const ids = [...Object.keys(MODEL_ALIAS), ...Object.keys(MODEL_ALIAS).map(id => id + SEARCH_SUFFIX)];
  json(res, 200, {
    object: 'list',
    data: ids.map((id, i) => ({
      id, object: 'model', created: 1704067200 + i, owned_by: 'yuanbao',
    })),
  });
}

async function handleChat(req, res, body) {
  const model = resolveModel(body.model);
  const hasTools = TOOLS_ENABLED && Array.isArray(body.tools) && body.tools.length > 0;
  let prompt = messagesToPrompt(body.messages || []);
  if (model.search) prompt = '请联网搜索相关资料后回答：\n' + prompt;
  if (hasTools) prompt = buildToolDirective(body.tools) + '\n\n' + prompt;
  const stream = body.stream === true;
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);

  const cid = await createConversation();
  const upstream = await yuanbaoChat(cid, prompt, model.chatModelId, '', []);

  if (!stream) {
    const { text, think, usage, citations } = await readSse(upstream);
    const tc = extractToolCall(text);
    if (tc) {
      return json(res, 200, {
        id, object: 'chat.completion', created, model: body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: null,
            tool_calls: [{ id: newCallId(), type: 'function', function: tc }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: usage.prompt || 0, completion_tokens: usage.completion || 0, total_tokens: usage.total || 0 },
      });
    }
    let content = text;
    if (model.search && citations.length) {
      content += '\n\n参考链接：\n' + citations.slice(0, 8).map((c, i) => `${i + 1}. [${c.title}](${c.url})`).join('\n');
    }
    return json(res, 200, {
      id, object: 'chat.completion', created, model: body.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content, ...(think ? { reasoning_content: think } : {}) },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: usage.prompt || 0, completion_tokens: usage.completion || 0, total_tokens: usage.total || 0 },
    });
  }
  // 流式：SSE 转发。带 tools 时用缓冲模式（等完整响应再判定 tool_calls / 普通内容一次性发）
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
  });
  const sendChunk = (delta, finish = null) => res.write('data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created, model: body.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + '\n\n');
  const finishStream = (finish, usage) => {
    res.write('data: ' + JSON.stringify({
      id, object: 'chat.completion.chunk', created, model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: usage.prompt || 0, completion_tokens: usage.completion || 0, total_tokens: usage.total || 0 },
    }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  };
  sendChunk({ role: 'assistant' });

  if (hasTools) {
    const { text, usage } = await readSse(upstream);
    const tc = extractToolCall(text);
    if (tc) {
      sendChunk({ tool_calls: [{ index: 0, id: newCallId(), type: 'function', function: tc }] });
      return finishStream('tool_calls', usage);
    }
    if (text) sendChunk({ content: text });
    return finishStream('stop', usage);
  }
  const { usage, citations } = await readSse(upstream, (kind, piece) => {
    if (kind === 'content') sendChunk({ content: piece });
    if (kind === 'reasoning') sendChunk({ reasoning_content: piece });
  });
  if (model.search && citations.length) {
    sendChunk({ content: '\n\n参考链接：\n' + citations.slice(0, 8).map((c, i) => `${i + 1}. [${c.title}](${c.url})`).join('\n') });
  }
  finishStream('stop', usage);
}

// 无水印换链：SSE 返回的 text2img 直链为 h1（带水印）版，会话详情里每张图带
// originUrl（h0 原始版）。生图完成后按路径匹配替换。失败时原样返回。
async function enrichWatermarkFree(cid, urls) {
  if (!WM_FREE_ENABLED || !urls.length) return urls;
  try {
    const res = await fetch(`${BASE}/api/user/agent/conversation/v1/detail`, {
      method: 'POST', headers: baseHeaders(),
      body: JSON.stringify({ conversationId: cid, agentId: cookie.agentId }),
    });
    const j = await res.json();
    const map = new Map();
    const walk = o => {
      if (o && typeof o === 'object') {
        if (o.originUrl && o.url) map.set(o.url.split('?')[0], o.originUrl);
        for (const v of Object.values(o)) walk(v);
      }
    };
    walk(j);
    return urls.map(u => map.get(u.split('?')[0]) || u);
  } catch {
    return urls;
  }
}

// 生图比例：OpenAI size 风格与比例风格统一映射为画幅指令（1:1 是元宝默认，不加指令）
const SIZE_RATIO = {
  '1024x1024': '1:1', '1:1': '1:1', 'square': '1:1',
  '1792x1024': '16:9', '1536x1024': '3:2', '16:9': '16:9', 'landscape': '16:9', '横版': '16:9',
  '1024x1792': '9:16', '1024x1536': '2:3', '9:16': '9:16', 'portrait': '9:16', '竖版': '9:16',
  '1440x1080': '4:3', '4:3': '4:3',
  '1080x1440': '3:4', '3:4': '3:4',
};
function ratioHint(size) {
  if (!size) return '';
  const r = SIZE_RATIO[String(size).toLowerCase()];
  return r && r !== '1:1' ? `，画幅比例 ${r}` : '';
}

async function handleImageGen(req, res, body) {
  let prompt = body.prompt || '';
  if (!prompt) return json(res, 400, { error: { message: 'prompt required' } });
  // 元宝意图判定依赖绘画动词，缺了会走纯文字回复（实测 oneAgentId=main_agent_hy_for_pc）
  if (!/^(画|绘|生成|创作|draw|create|imagine)/i.test(prompt)) prompt = '画：' + prompt;
  prompt += ratioHint(body.size);
  const b64 = body.response_format === 'b64_json';
  const cid = await createConversation();
  const upstream = await yuanbaoChat(cid, prompt, 'hunyuan_omnipotent_hy4', 'Adaptive', []);
  const { images } = await readSse(upstream);
  const urls = await enrichWatermarkFree(cid, images);
  const n = Math.max(1, Math.min(body.n || 4, urls.length));
  let data = urls.slice(0, n);
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

// ---------------- 异步生图（任务式：提交即返回，轮询取结果） ----------------
// 任务表为内存态，服务重启即清空（研究工具定位，未做持久化）
const asyncTasks = new Map();

async function handleImageGenAsync(req, res, body) {
  let prompt = body.prompt || '';
  if (!prompt) return json(res, 400, { error: { message: 'prompt required' } });
  if (!/^(画|绘|生成|创作|draw|create|imagine)/i.test(prompt)) prompt = '画：' + prompt;
  prompt += ratioHint(body.size);
  const b64 = body.response_format === 'b64_json';
  const id = 'imgtask-' + crypto.randomBytes(10).toString('hex');
  const task = { id, status: 'processing', created_at: Math.floor(Date.now() / 1000), data: null, error: null };
  asyncTasks.set(id, task);
  // 超过 200 条清理最旧任务，防内存膨胀
  if (asyncTasks.size > 200) {
    const oldest = asyncTasks.keys().next().value;
    asyncTasks.delete(oldest);
  }
  (async () => {
    try {
      const cid = await createConversation();
      const upstream = await yuanbaoChat(cid, prompt, 'hunyuan_omnipotent_hy4', 'Adaptive', []);
      const { images } = await readSse(upstream);
      if (!images.length) throw new Error('未生成任何图片（意图未路由到生图，可尝试加绘画动词）');
      const urls = await enrichWatermarkFree(cid, images);
      task.data = b64
        ? await Promise.all(urls.map(async u => {
            const r = await fetch(u);
            return { b64_json: Buffer.from(await r.arrayBuffer()).toString('base64') };
          }))
        : urls.map(u => ({ url: u }));
      task.status = 'succeeded';
    } catch (e) {
      task.error = e.message;
      task.status = 'failed';
    }
  })();
  json(res, 200, { id, object: 'image_generation_task', status: task.status, created_at: task.created_at });
}

function handleImageTaskStatus(req, res, id) {
  const task = asyncTasks.get(id);
  if (!task) return json(res, 404, { error: { message: 'task not found: ' + id } });
  const out = { id: task.id, object: 'image_generation_task', status: task.status, created_at: task.created_at };
  if (task.data) out.data = task.data;
  if (task.error) out.error = { message: task.error };
  json(res, 200, out);
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
  const urls = await enrichWatermarkFree(cid, images);
  let data = urls;
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
    if (req.method === 'POST' && req.url === '/v1/images/async') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return await handleImageGenAsync(req, res, body);
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/images/async/')) {
      return handleImageTaskStatus(req, res, req.url.slice('/v1/images/async/'.length).split('?')[0]);
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
    const msg = String(e.message || '');
    // 元宝凭据过期（实测错误码：20001 token无效 / 23000 登录已过期）
    if (/20001|23000|token无效|登录已过期/.test(msg)) {
      return json(res, 401, {
        error: { message: 'yuanbao cookie 已过期：请运行 node yuanbao-login.js 重新扫码登录', type: 'invalid_credentials', code: 'yuanbao_token_expired' },
      });
    }
    json(res, 502, { error: { message: 'yuanbao upstream error: ' + msg, type: 'upstream_error' } });
  }
});

server.listen(PORT, () => {
  console.log(`[yuanbao-server] OpenAI 兼容层就绪: http://127.0.0.1:${PORT}/v1`);
  console.log(`[yuanbao-server] 模型: ${Object.keys(MODEL_ALIAS).join(', ')}`);
  console.log(`[yuanbao-server] 鉴权: ${API_KEY ? '已开启 (YUANBAO_API_KEY)' : '关闭（局域网裸奔，注意）'}`);
  console.log(`[yuanbao-server] 工具调用: ${TOOLS_ENABLED ? '开启（请求带 tools 即启用；YUANBAO_TOOLS=off 可关）' : '已关闭 (YUANBAO_TOOLS=off)'}`);
});
