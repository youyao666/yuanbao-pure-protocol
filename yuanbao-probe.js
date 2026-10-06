// 元宝网页版纯协议探针：零浏览器，Node 直连。
// 签名来自 qimei-standalone.js（从元宝网页抠出的 QIMEI SDK 模块搬迁运行）。
// 用法：node yuanbao-probe.js [消息文本] [chatModelId]
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { createSigner } = require('./qimei-standalone.js');

const cookie = JSON.parse(fs.readFileSync(process.env.YUANBAO_COOKIE
  ? process.env.YUANBAO_COOKIE
  : path.join(__dirname, 'yuanbao-cookie.json'), 'utf8'));
const signer = createSigner();

const BASE = 'https://yuanbao.tencent.com';
const WEB_VERSION = '2.87.2';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function baseHeaders(sec) {
  const h = {
    'Cookie': `hy_source=web; hy_user=${cookie.hy_user}; hy_token=${cookie.hy_token}`,
    'chat_version': 'v1',
    'x-agentid': cookie.agentId,
    'x-id': cookie.hy_user,
    't-userid': cookie.hy_user,
    'x-requested-with': 'XMLHttpRequest',
    'x-source': 'web',
    'x-platform': 'win',
    'x-language': 'zh-CN',
    'x-webversion': WEB_VERSION,
    'x-commit-tag': '02746073',
    'x-instance-id': '5',
    'x-ybuitest': '0',
    'x-webdriver': '0',
    'x-web-third-source': 'main',
    'x-os-version': 'Windows(10)-Blink',
    'content-type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Origin': BASE,
    'Referer': `${BASE}/chat/${cookie.agentId}`,
    'User-Agent': UA,
    // QIMEI 设备指纹头
    'x-hy92': signer.getH38(),
    'x-hy93': signer.getDeviceId() || signer.getH38(),
    'x-device-id': signer.getDeviceId() || signer.getH38(),
  };
  if (sec) Object.assign(h, sec);
  return h;
}

// 签名三元组（仅 /chat/ 与 /conversation/create 需要）
function signHeaders() {
  const s = signer.sign();
  return {
    'x-uskey': s['X-Uskey'],
    'x-bus-params-md5': s['X-Bus-Params-Md5'],
    'x-timestamp': s['X-Timestamp'],
  };
}

async function createConversation() {
  const res = await fetch(`${BASE}/api/user/agent/conversation/create`, {
    method: 'POST',
    headers: baseHeaders(signHeaders()),
    body: JSON.stringify({ agentId: cookie.agentId }),
  });
  if (!res.ok) throw new Error(`create HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const cid = json?.id || json?.data?.convId || json?.data?.conversationId || json?.data?.cid;
  if (!cid) throw new Error('create 未返回会话ID: ' + JSON.stringify(json).slice(0, 300));
  return cid;
}

// PNG 宽高（IHDR 固定在 16/20 偏移，大端）
function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}
const randHex = n => Array.from(nodeCrypto.randomBytes(n)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, n);

// 图生图：上传三步（genUploadInfo → COS PUT → asyncFileParse）→ multimedia 引用
async function uploadImage(filePath) {
  const buf = fs.readFileSync(filePath);
  const { width, height } = pngSize(buf);
  const fileName = path.basename(filePath);
  const contentType = /\.jpe?g$/i.test(fileName) ? 'image/jpeg' : 'image/png';
  console.log(`[probe] 上传 ${fileName} (${Math.round(buf.length / 1024)}KB, ${width}x${height})`);

  const r1 = await fetch(`${BASE}/api/resource/genUploadInfo`, {
    method: 'POST',
    headers: baseHeaders(),
    body: JSON.stringify({ fileName, docFrom: 'localDoc', docOpenId: '', needAuth: true }),
  });
  if (!r1.ok) throw new Error(`genUploadInfo HTTP ${r1.status}: ${(await r1.text()).slice(0, 150)}`);
  const info = await r1.json();
  if (!info.cosURL) throw new Error('genUploadInfo 未返回 cosURL: ' + JSON.stringify(info).slice(0, 200));
  console.log('[probe] resourceID =', info.resourceID);

  const putRes = await fetch(info.cosURL, {
    method: 'PUT',
    headers: { authorization: info.putAuthorization, 'content-type': contentType },
    body: buf,
  });
  console.log('[probe] COS PUT →', putRes.status, putRes.ok ? 'OK' : await putRes.text().then(t => t.slice(0, 100)));
  if (!putRes.ok) throw new Error('COS PUT 失败');

  await fetch(`${BASE}/api/resource/asyncFileParse`, {
    method: 'POST',
    headers: baseHeaders(),
    body: JSON.stringify({ resourceList: [{ resourceUrl: info.resourceUrl, type: 'image', size: buf.length, purpose: 'doc_reparse' }] }),
  });

  return {
    type: 'image', docType: 'image',
    url: info.resourceUrl, signUrl: '',
    fileName, size: buf.length, width, height,
    fileId: randHex(15), uploadStatus: 'success', progress: 100,
  };
}

async function chat(cid, prompt, chatModelId, plugin, multimedia) {
  const body = {
    model: 'gpt_175B_0404',
    prompt,
    plugin: plugin || '',
    displayPrompt: prompt,
    displayPromptType: 1,
    agentId: cookie.agentId,
    isTemporary: false,
    projectId: '',
    chatModelId,
    supportFunctions: ['openAutoSearchSwitch', 'autoInternetSearch'],
    docOpenid: '',
    options: { imageIntention: { needIntentionModel: true, backendUpdateFlag: 2, intentionStatus: true } },
    multimedia: multimedia || [],
    supportHint: 1,
    chatModelExtInfo: JSON.stringify({
      modelId: chatModelId,
      agentModeModelSetting: { modelId: chatModelId },
      supportFunctions: { internetSearch: '' },
      internetSearch: 'autoInternetSearch',
    }),
    applicationIdList: [],
    version: 'v2',
    extReportParams: null,
    isAtomInput: false,
    conversationId: cid,
    offsetOfHour: 8,
    offsetOfMinute: 0,
  };
  const res = await fetch(`${BASE}/api/chat/${cid}`, {
    method: 'POST',
    headers: baseHeaders(signHeaders()),
    body: JSON.stringify(body),
  });
  if (process.env.YUANBAO_DUMP_REQ) {
    try { fs.writeFileSync(path.join(__dirname, process.env.YUANBAO_DUMP_REQ), JSON.stringify(body, null, 2)); } catch {}
  }
  if (!res.ok) throw new Error(`chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

// SSE 流解析：拼出思考、正文、生图URL
async function readSse(res, onEvent) {
  const dec = new TextDecoder();
  const dump = process.env.YUANBAO_DUMP_SSE ? fs.createWriteStream(path.join(__dirname, process.env.YUANBAO_DUMP_SSE)) : null;
  let buf = '';
  let text = '', think = '', images = [];
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data: ') || line.startsWith('event: ')) dump?.write(line + '\n');
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') { onEvent?.({ done: true }); return { text, think, images }; }
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      onEvent?.(ev);
      if (ev.type === 'deepSearchAgent' && Array.isArray(ev.contents)) {
        for (const c of ev.contents) {
          if (c.type === 'think' && c.text) think += c.text;
          if (c.type === 'text' && c.text) text += c.text;
          // 生图路径1：toolCall(image_generation/generate) → items[].multimedias[].url
          if (c.type === 'toolCall' && Array.isArray(c.items)) {
            for (const item of c.items) {
              for (const m of (item.multimedias || [])) {
                if (m.mediaType === 'image' && m.url) images.push(m.url);
              }
            }
          }
        }
      } else if (ev.type === 'replace' && ev.replace && Array.isArray(ev.replace.multimedias)) {
        // 生图路径2：replace 事件（带 assetId 的终态）直接携带图片直链
        if (ev.replace.assetId) {
          for (const m of ev.replace.multimedias) {
            if (m.mediaType === 'image' && m.url) images.push(m.url);
          }
        }
      } else if (ev.type === 'text' && ev.msg) {
        text += ev.msg;
      }
    }
  }
  return { text, think, images };
}

async function main() {
  const raw = process.argv.slice(2);
  const isImage = raw.includes('--image');
  const i2iIdx = raw.indexOf('--image2img');
  const img2imgFile = i2iIdx !== -1 ? raw[i2iIdx + 1] : null;
  const download = raw.includes('--download') || isImage || !!img2imgFile;
  const args = raw.filter((a, i) => a !== '--image' && a !== '--download' && a !== '--image2img' && i !== i2iIdx + 1);
  const prompt = args[0] || '请只回复两个字：收到';
  const chatModelId = args[1] || 'hunyuan_omnipotent_hy4';
  console.log(`[probe] 模型=${chatModelId} 生图=${isImage} 图生图=${img2imgFile || '无'} 消息="${prompt}"`);
  console.log('[probe] h38(node指纹) =', signer.getH38());

  const cid = await createConversation();
  console.log('[probe] 会话ID =', cid);

  let multimedia = null;
  if (img2imgFile) multimedia = [await uploadImage(img2imgFile)];

  const res = await chat(cid, prompt, chatModelId, isImage ? 'Adaptive' : '', multimedia);
  console.log('[probe] chat HTTP', res.status, '内容类型:', res.headers.get('content-type'));

  const t0 = Date.now();
  const { text, think, images } = await readSse(res, ev => {
    if (ev.type === 'meta') {
      console.log('[probe] meta: stopReason=%s tokens=%s', ev.stopReason, JSON.stringify(ev.tokenUsageInfo || {}));
    }
  });
  console.log('[probe] 耗时 %dms', Date.now() - t0);
  console.log('--- 思考 ---\n' + (think || '(无)'));
  console.log('--- 正文 ---\n' + (text || '(空!)'));
  if (images.length) {
    console.log('--- 生图 ' + images.length + ' 张 ---');
    if (download) {
      const dir = path.join(__dirname, 'images');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      for (let i = 0; i < images.length; i++) {
        try {
          const r = await fetch(images[i]);
          const buf = Buffer.from(await r.arrayBuffer());
          const file = path.join(dir, stamp + '-' + (i + 1) + '.png');
          fs.writeFileSync(file, buf);
          console.log(`[图${i + 1}] ${file} (${Math.round(buf.length / 1024)}KB)`);
        } catch (e) {
          console.log(`[图${i + 1}] 下载失败: ${e.message} URL=${images[i].slice(0, 120)}`);
        }
      }
    } else {
      images.forEach((u, i) => console.log(`[图${i + 1}] ` + u.slice(0, 150)));
    }
  }
  process.exit(0);
}

main().catch(e => { console.error('[probe] 失败:', e.message); process.exit(1); });
