// 元宝自动登录：拉起 Chrome 扫码 → CDP 自动抓取 hy_user/hy_token → 生成凭据文件
// 用法：node yuanbao-login.js          （正式登录，等扫码，写 yuanbao-cookie.json）
//       node yuanbao-login.js --anon   （匿名游客凭据，免扫码，写 yuanbao-anon-cookie.json）
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const START_URL = 'https://yuanbao.tencent.com/chat/naQivTmsDa';
const TIMEOUT_MS = 5 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function log(msg) { console.log('[login] ' + msg); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

// 等待调试端口就绪并拿到 yuanbao 页面的 ws 调试地址
async function waitDebugger(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json`);
      const page = targets.find(t => t.type === 'page' && t.url.includes('yuanbao.tencent.com'))
        || targets.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP 调试端口 60 秒内未就绪');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  return {
    ready: new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
    }),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

async function main() {
  const isAnon = process.argv.includes('--anon');
  const chrome = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!chrome) throw new Error('未找到 Chrome/Edge');
  const port = 9300 + Math.floor(Math.random() * 200);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), isAnon ? 'yuanbao-anon-' : 'yuanbao-login-'));

  log('启动浏览器：' + path.basename(chrome));
  const proc = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--window-size=1100,800',
    START_URL,
  ], { detached: false, stdio: 'ignore' });

  const cleanup = async () => {
    // Windows 上直接 proc.kill() 会留子进程并触发 libuv 断言，用 taskkill 树杀
    if (proc.pid) {
      try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    }
    await sleep(800);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  };

  try {
    const wsUrl = await waitDebugger(port);
    log('CDP 已连接，等待扫码登录…（请在浏览器里完成登录）');
    const conn = cdp(wsUrl);
    await conn.ready;

    const deadline = Date.now() + (isAnon ? 90 * 1000 : TIMEOUT_MS);
    let hyUser = null, hyToken = null;
    let sawAnonymous = false;
    // 语义验证式登录判定：不依赖 hy_user 格式（各登录渠道格式各异：微信32hex/QQ快登16hex）。
    // 记录初始 hy_user（登录前为匿名 a_did_ 或空），值发生变化 + hy_token 存在时，
    // 发真实 create 验证凭据有效性——通过才落盘，失败继续等。
    const initialUser = { value: undefined };
    let verifying = false;
    const prevCookies = new Map(); // cookie 名 -> 值哈希（观察登录瞬间的全量变化）
    while (Date.now() < deadline) {
      if (verifying) { await sleep(300); continue; } // 语义验证进行中，勿并发
      try {
        const { cookies } = await conn.send('Storage.getCookies');
        // 打印 cookie 增量变化（只打名与是否变化，不打值）
        for (const c of cookies) {
          const sig = c.value.length + ':' + c.value.slice(0, 8);
          if (!prevCookies.has(c.name)) {
            if (prevCookies.size > 0) log(`cookie 新增: ${c.name} (${c.value.length}字符)`);
            prevCookies.set(c.name, sig);
          } else if (prevCookies.get(c.name) !== sig) {
            log(`cookie 变化: ${c.name} (新长度 ${c.value.length})`);
            prevCookies.set(c.name, sig);
          }
        }
        const u = cookies.find(c => c.name === 'hy_user')?.value || null;
        const t = cookies.find(c => c.name === 'hy_token')?.value || null;
        if (initialUser.value === undefined) initialUser.value = u;
        if (isAnon) {
          // 匿名模式：a_did_ 游客凭据出现即收工（免扫码，秒级）
          if (u && u.startsWith('a_did_') && t) { hyUser = u; hyToken = t; break; }
        } else {
          if (u && !sawAnonymous && u.startsWith('a_did_')) {
            sawAnonymous = true;
            log('当前是匿名态（a_did_），继续等待扫码登录…');
          }
          // 登录判定 = hy_user 相对初始值发生变化 + 有 token → 语义验证（create）
          const changed = initialUser.value !== undefined && u && u !== initialUser.value;
          if (changed && t) {
            verifying = true;
            log(`检测到 hy_user 变化（${initialUser.value?.slice(0, 8)}…→${u.slice(0, 8)}…），验证凭据…`);
            (async () => {
              try {
                const vr = await fetch('https://yuanbao.tencent.com/api/user/agent/conversation/create', {
                  method: 'POST',
                  headers: { Cookie: `hy_source=web; hy_user=${u}; hy_token=${t}`, 'Content-Type': 'application/json', 'User-Agent': UA || 'Mozilla/5.0' },
                  body: JSON.stringify({ agentId: 'naQivTmsDa' }),
                });
                const vb = await vr.json().catch(() => ({}));
                verifying = false;
                if (vr.status === 200 && vb?.id) {
                  hyUser = u; hyToken = t;
                  log('语义验证通过：凭据有效');
                } else {
                  log(`语义验证未过（HTTP ${vr.status}），继续等待…`);
                }
              } catch (e) {
                verifying = false;
                log('语义验证网络错误，继续等待…');
              }
            })();
          }
        }
      } catch {}
      await sleep(1500);
    }
    conn.close();
    if (!hyUser && prevCookies.size) {
      log('诊断：当前全部 cookie 名 → ' + [...prevCookies.keys()].join(', '));
    }

    if (!hyUser || !hyToken) throw new Error(isAnon ? '超时：页面未签发匿名凭据（a_did_）' : '超时：未捕获到有效登录凭据（5 分钟内未完成登录？）');

    const cred = { hy_user: hyUser, hy_token: hyToken, agentId: 'naQivTmsDa' };
    const credPath = path.join(__dirname, isAnon ? 'yuanbao-anon-cookie.json' : 'yuanbao-cookie.json');
    fs.writeFileSync(credPath, JSON.stringify(cred, null, 2) + '\n');
    log('凭据已生成 → ' + credPath);
    log('hy_user = ' + hyUser);
    log('hy_token 长度 = ' + hyToken.length);

    // 立即验证：用新 cookie + Node 签名发一次 create（不产生对话内容）
    const { createSigner } = require('./qimei-standalone.js');
    const signer = createSigner();
    const res = await fetch('https://yuanbao.tencent.com/api/user/agent/conversation/create', {
      method: 'POST',
      headers: {
        'Cookie': `hy_source=web; hy_user=${hyUser}; hy_token=${hyToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        ...(() => { const s = signer.sign(); return { 'x-uskey': s['X-Uskey'], 'x-bus-params-md5': s['X-Bus-Params-Md5'], 'x-timestamp': s['X-Timestamp'] }; })(),
      },
      body: JSON.stringify({ agentId: 'naQivTmsDa' }),
    });
    const body = await res.json();
    if (res.status === 200 && body?.id) log('验证通过：新凭据可用（会话ID ' + body.id + '）');
    else log('注意：验证返回 HTTP ' + res.status + ' ' + JSON.stringify(body).slice(0, 120));
  } finally {
    await cleanup();
    log('浏览器已关闭');
  }
  process.exit(0);
}

main().catch(e => { console.error('[login] 失败:', e.message); process.exit(1); });
