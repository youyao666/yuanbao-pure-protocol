// QIMEI SDK 独立运行器：从元宝网页抠出的 webpack 模块子树，在 Node 里跑 getUSKeySync。
// 用法：const { createSigner } = require('./qimei-standalone.js')
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

const tree = JSON.parse(fs.readFileSync(path.join(__dirname, 'qimei-modules.json'), 'utf8'));

// ---------------- 环境 shim ----------------
// localStorage 用内存实现，可选从 qimei-storage.json 持久化（保住 h38/uuid 指纹）
const storageFile = path.join(__dirname, 'qimei-storage.json');
let persisted = {};
try { persisted = JSON.parse(fs.readFileSync(storageFile, 'utf8')); } catch {}
const storage = { ...persisted };
function saveStorage() {
  try { fs.writeFileSync(storageFile, JSON.stringify(storage)); } catch {}
}
const localStorageShim = {
  getItem: k => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); saveStorage(); },
  removeItem: k => { delete storage[k]; saveStorage(); },
  clear: () => { for (const k of Object.keys(storage)) delete storage[k]; saveStorage(); },
  get length() { return Object.keys(storage).length; },
  key: i => Object.keys(storage)[i] ?? null,
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// canvas / WebGL 指纹桩：QIMEI 用 2d 渲染哈希 + webgl 参数做指纹，返回固定形状即可
const ctx2dShim = {
  canvas: null, fillStyle: '', font: '10px sans-serif', textBaseline: 'alphabetic', globalAlpha: 1,
  globalCompositeOperation: 'source-over', lineWidth: 1, shadowBlur: 0, shadowColor: '',
  fillText() {}, strokeText() {}, measureText: t => ({ width: String(t).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
  getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
  putImageData() {}, createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
  drawImage() {}, fillRect() {}, strokeRect() {}, clearRect() {}, beginPath() {}, closePath() {},
  moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, ellipse() {}, rect() {}, clip() {},
  quadraticCurveTo() {}, bezierCurveTo() {}, fill() {}, stroke() {}, save() {}, restore() {},
  translate() {}, rotate() {}, scale() {}, setTransform() {}, resetTransform() {}, transform() {},
  setLineDash() {}, getLineDash: () => [], isPointInPath: () => false, createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}),
};
const glShim = {
  getParameter: p => (p === 37445 || p === 37446) ? 'WebGL Stub Vendor' : (p === 7936 || p === 7937 || p === 7938 ? 'WebGL 1.0 stub' : 8),
  getExtension: name => name === 'WEBGL_debug_renderer_info' ? { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 } : (name === 'EXT_texture_filter_anisotropic' ? { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 34046 } : null),
  getSupportedExtensions: () => ['ANGLE_instanced_arrays', 'EXT_texture_filter_anisotropic', 'WEBGL_debug_renderer_info'],
  getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
  createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => true, getShaderInfoLog: () => '',
  createProgram: () => ({}), attachShader() {}, linkProgram() {}, getProgramParameter: () => true, getProgramInfoLog: () => '',
  useProgram() {}, getUniformLocation: () => ({}), getAttribLocation: () => 0,
  createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
  createTexture: () => ({}), bindTexture() {}, texImage2D() {}, texParameteri() {}, generateMipmap() {},
  createFramebuffer: () => ({}), bindFramebuffer() {}, framebufferTexture2D() {}, checkFramebufferStatus: () => 36053,
  createRenderbuffer: () => ({}), bindRenderbuffer() {}, renderbufferStorage() {}, framebufferRenderbuffer() {},
  viewport() {}, clearColor() {}, enable() {}, disable() {}, blendFunc() {}, clear() {}, drawArrays() {}, drawElements() {},
  shaderSourceBind() {}, isContextLost: () => false, getContextAttributes: () => ({ alpha: true, antialias: true }),
};
function makeCanvasElement() {
  const cv = {
    tagName: 'CANVAS', width: 300, height: 150, style: {}, dataset: {},
    className: '', id: '', innerHTML: '', textContent: '', offsetWidth: 300, offsetHeight: 150,
    clientWidth: 300, clientHeight: 150, parentNode: null, parentElement: null, firstChild: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false, length: 0 },
    getContext: type => String(type).includes('webgl') ? glShim : ctx2dShim,
    toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    toBlob: cb => cb(null),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k] ?? null; },
    removeAttribute(k) { delete this[k]; }, hasAttribute(k) { return k in this; },
    appendChild(c) { this.children = this.children || []; this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c) { this.children = this.children || []; this.children.push(c); return c; },
    removeChild(c) { this.children = (this.children || []).filter(x => x !== c); return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    cloneNode() { return makeCanvasElement(); },
    contains: () => false, closest: () => null, matches: () => false,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 300, bottom: 150, width: 300, height: 150, x: 0, y: 0 }),
    getElementsByTagName: () => [],
  };
  ctx2dShim.canvas = cv;
  return cv;
}

const documentShim = {
  cookie: '',
  referrer: 'https://yuanbao.tencent.com/',
  visibilityState: 'visible',
  hidden: false,
  readyState: 'complete',
  currentScript: null,
  documentElement: { style: {}, getElementsByTagName: () => [], clientWidth: 1920, clientHeight: 1080 },
  body: { appendChild() {}, removeChild() {}, style: {} },
  head: { appendChild() {} },
  createElement: tag => {
    if (String(tag).toLowerCase() === 'canvas') return makeCanvasElement();
    const el = { style: {}, dataset: {}, attributes: {}, children: [], tagName: String(tag).toUpperCase(),
      className: '', id: '', innerHTML: '', textContent: '', offsetWidth: 0, offsetHeight: 0,
      clientWidth: 0, clientHeight: 0, parentNode: null, parentElement: null, firstChild: null,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false, length: 0 },
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k] ?? null; },
      removeAttribute(k) { delete this.attributes[k]; },
      hasAttribute(k) { return k in this.attributes; },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      insertBefore(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      cloneNode() { return documentShim.createElement(tag); },
      contains: () => false, closest: () => null, matches: () => false,
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
      focus() {}, blur() {}, click() {},
      getElementsByTagName: () => [], getContext: () => null, toDataURL: () => '' };
    return el;
  },
  createTextNode: () => ({}),
  getElementsByTagName: () => [],
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
const navigatorShim = {
  userAgent: UA,
  appVersion: '5.0 (Windows)',
  platform: 'Win32',
  language: 'zh-CN',
  languages: ['zh-CN', 'zh'],
  webdriver: false,
  cookieEnabled: true,
  onLine: true,
  doNotTrack: null,
  hardwareConcurrency: 8,
  maxTouchPoints: 0,
  product: 'Gecko',
  productSub: '20030107',
  vendor: 'Google Inc.',
  deviceMemory: 8,
  plugins: { length: 5, 0: { name: 'Chrome PDF Plugin' }, 1: { name: 'Chrome PDF Viewer' } },
  mimeTypes: { length: 2 },
  javaEnabled: () => false,
  sendBeacon: () => true,
  connection: { effectiveType: '4g', rtt: 50, downlink: 10 },
};
const locationShim = {
  href: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
  protocol: 'https:',
  host: 'yuanbao.tencent.com',
  hostname: 'yuanbao.tencent.com',
  port: '',
  origin: 'https://yuanbao.tencent.com',
  pathname: '/chat/naQivTmsDa',
  search: '',
  hash: '',
  ancestorOrigins: { length: 0, contains: () => false },
  replace() {}, assign() {}, reload() {},
};

const fakeWindow = {};
fakeWindow.window = fakeWindow;
fakeWindow.self = fakeWindow;
fakeWindow.top = fakeWindow;
fakeWindow.parent = fakeWindow;
fakeWindow.frames = fakeWindow;
fakeWindow.globalThis = fakeWindow;
Object.assign(fakeWindow, {
  document: documentShim,
  navigator: navigatorShim,
  localStorage: localStorageShim,
  sessionStorage: localStorageShim,
  location: locationShim,
  history: { length: 2, state: null, pushState() {}, replaceState() {}, go() {}, back() {}, forward() {} },
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24, availLeft: 0, availTop: 0 },
  devicePixelRatio: 1,
  innerWidth: 1536, innerHeight: 760, outerWidth: 1552, outerHeight: 840,
  screenX: 0, screenY: 0, pageXOffset: 0, pageYOffset: 0, scrollX: 0, scrollY: 0,
  isSecureContext: true,
  origin: 'https://yuanbao.tencent.com',
  name: '',
  status: '',
  closed: false,
  opener: null,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  postMessage() {}, focus() {}, blur() {}, close() {}, print() {}, alert() {}, confirm() { return false; }, prompt() { return null; },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  CSS: { supports: () => false, escape: s => String(s) },
  styleMedia: { type: 'screen', matchMedium: () => true },
  matchMedia: () => ({ matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: cb => setTimeout(cb, 16),
  cancelAnimationFrame: id => clearTimeout(id),
  requestIdleCallback: cb => setTimeout(cb, 1),
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  PerformanceObserver: class { observe() {} disconnect() {} },
  XMLHttpRequest: class XHRShim {
    constructor() { this.readyState = 0; this.timeout = 0; this.withCredentials = false; }
    open() { this.readyState = 1; } send() {} abort() {}
    setRequestHeader() {} getResponseHeader() { return null; }
    getAllResponseHeaders() { return ''; }
    addEventListener() {} removeEventListener() {}
    overrideMimeType() {}
  },
  fetch: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
  Event: class {}, CustomEvent: class {},
  MessageChannel: class { constructor() { this.port1 = {}; this.port2 = {}; } },
  WebSocket: class { constructor() {} close() {} send() {} addEventListener() {} },
  Worker: class { constructor() { this.onmessage = null; } postMessage() {} terminate() {} addEventListener() {} set onerror(v) {} },
  RTCPeerConnection: class RTCShim {
    constructor() { this.signalingState = 'stable'; this.iceConnectionState = 'closed'; this.localDescription = null; }
    createDataChannel() { return {}; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: '' }); }
    close() { this.signalingState = 'closed'; }
    addEventListener() {} removeEventListener() {}
    addIceCandidate() { return Promise.resolve(); }
  },
  OffscreenCanvas: class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return null; } convertToBlob() { return Promise.resolve(null); } },
  indexedDB: { open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }), deleteDatabase() {} },
  webkitIndexedDB: { open: () => ({}) },
  performance: {
    now: () => Date.now(),
    timeOrigin: Date.now(),
    timing: { navigationStart: Date.now() - 3000 },
    getEntriesByType: () => [],
    mark() {}, measure() {},
  },
  crypto: nodeCrypto.webcrypto,
  atob: s => Buffer.from(String(s), 'base64').toString('binary'),
  btoa: s => Buffer.from(String(s), 'binary').toString('base64'),
  TextEncoder, TextDecoder,
  URL, URLSearchParams,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Symbol, Map, Set, WeakMap, WeakSet, Promise, Proxy, Reflect, BigInt, ArrayBuffer, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, DataView,
  escape, unescape, encodeURI, encodeURIComponent, decodeURI, decodeURIComponent, isNaN, isFinite, parseInt, parseFloat,
});
// DOM 类桩：UMD/env 探测模块在顶层会触碰这些
fakeWindow.open = () => null;
for (const cls of ['HTMLAnchorElement','HTMLElement','HTMLDocument','HTMLCanvasElement','HTMLImageElement','HTMLVideoElement','HTMLIFrameElement','MouseEvent','KeyboardEvent','TouchEvent','PointerEvent','ErrorEvent','ProgressEvent','FileReader','Audio','Image','Notification','ServiceWorker','BroadcastChannel','AbortController','AbortSignal','FormData','Headers','Request','Response','ReadableStream','WritableStream','DOMParser']) {
  if (!(cls in fakeWindow)) fakeWindow[cls] = class { constructor() {} };
}
if (!('Blob' in fakeWindow) && typeof Blob !== 'undefined') fakeWindow.Blob = Blob;
if (!URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:fake-' + Math.random().toString(36).slice(2);
  URL.revokeObjectURL = () => {};
}
fakeWindow.globalThis = fakeWindow;

for (const [k, v] of Object.entries({
  window: fakeWindow, self: fakeWindow, document: documentShim, navigator: navigatorShim,
  localStorage: localStorageShim, sessionStorage: localStorageShim, location: locationShim,
  matchMedia: fakeWindow.matchMedia, requestAnimationFrame: fakeWindow.requestAnimationFrame,
  MutationObserver: fakeWindow.MutationObserver, XMLHttpRequest: fakeWindow.XMLHttpRequest,
  performance: fakeWindow.performance, atob: fakeWindow.atob, btoa: fakeWindow.btoa,
})) {
  if (!(k in globalThis)) globalThis[k] = v;
}
// DOM 类桩同样要挂全局（模块顶层环境探测直接按标识符查找）
for (const k of Object.keys(fakeWindow)) {
  if (!(k in globalThis)) {
    try { globalThis[k] = fakeWindow[k]; } catch {}
  }
}

// ---------------- 迷你 webpack 5 runtime ----------------
const moduleCache = {};
function __webpack_require__(id) {
  const key = String(id);
  if (moduleCache[key]) return moduleCache[key].exports;
  const module = { id: key, loaded: false, exports: {} };
  moduleCache[key] = module;
  // 调试支持：存在 qimei-<id>-instrumented.js 时优先使用（打印 VM 内部调用目标）
  let factorySrc;
  try { factorySrc = fs.readFileSync(path.join(__dirname, `qimei-${key}-instrumented.js`), 'utf8'); } catch {}
  if (!factorySrc) factorySrc = tree.modules[key];
  if (!factorySrc) throw new Error('QIMEI 加载失败：模块缺失 ' + key + '（网页改版，需重新 dump）');
  const factory = eval('(' + factorySrc + ')');
  try {
    factory(module, module.exports, __webpack_require__);
  } catch (e) {
    if (!e.__qimeiMod) {
      e.__qimeiMod = key;
      e.message = '[模块 ' + key + '] ' + e.message;
    }
    throw e;
  }
  module.loaded = true;
  return module.exports;
}

__webpack_require__.d = (exports, definition) => {
  for (const key of Object.keys(definition)) {
    if (Object.prototype.hasOwnProperty.call(exports, key)) continue;
    Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
  }
};
__webpack_require__.n = module => {
  const getter = module && module.__esModule ? () => module.default : () => module;
  __webpack_require__.d(getter, { a: getter });
  return getter;
};
__webpack_require__.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
__webpack_require__.r = exports => {
  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
  }
  Object.defineProperty(exports, '__esModule', { value: true });
};
__webpack_require__.t = function (value, mode) {
  if (mode & 1) value = this(value);
  if (mode & 8) return value;
  if (mode & 4 && typeof value === 'object' && value && value.__esModule) return value;
  const ns = Object.create(null);
  this.r(ns);
  Object.defineProperty(ns, 'default', { enumerable: true, value });
  if (mode & 2 && typeof value !== 'string') {
    for (const k of Object.keys(value)) {
      const hit = (m => v => m !== v)(k);
      if (hit) this.d(ns, () => value[k]);
    }
  }
  return ns;
};
__webpack_require__.g = (function () {
  try {
    if (typeof globalThis === 'object') return globalThis;
  } catch {}
  try {
    return this || (0, eval)('globalThis');
  } catch {
    if (typeof window === 'object') return window;
    if (typeof self === 'object') return self;
  }
})();
__webpack_require__.e = async chunkId => {
  console.warn('[qimei] 异步 chunk 请求被忽略:', chunkId);
  return Promise.resolve();
};
__webpack_require__.amd = undefined;
__webpack_require__.p = 'https://yuanbao.tencent.com/';
__webpack_require__.b = new URL('https://yuanbao.tencent.com/');

// ---------------- 对外 API ----------------
const QIMEI_ENTRY = '77004';
let sdkInstance = null;

function getSdk() {
  if (sdkInstance) return sdkInstance;
  const mod = __webpack_require__(QIMEI_ENTRY);
  const appKey = mod.PU || '0WEB05U9OEC1ZNRY';
  const inst = mod.I5(appKey);
  sdkInstance = inst;
  return inst;
}

// 生成一次完整签名头集合（与网页模块 28850 中 m 函数完全一致的算法）
function createSigner() {
  const inst = getSdk();
  const mod = __webpack_require__(QIMEI_ENTRY);
  return {
    instance: inst,
    appKey: mod.PU,
    appKeyEvt: mod.Ye,
    getH38() {
      const q = inst.getLocalQimei36() || {};
      return q.h38 || '';
    },
    getDeviceId() {
      return storage['_qimei_uuid42'] || (inst.getLocalQimei36() || {}).q36 || '';
    },
    // 返回 { 'X-Uskey', 'X-Bus-Params-Md5', 'X-Timestamp' }
    sign() {
      const h38 = this.getH38();
      const ts = Date.now();
      const params = `h38=${h38}&timestamp=${ts}&platform=web`;
      const uskey = h38 ? inst.getUSKeySync('7800385', h38, params) : '';
      return {
        'X-Uskey': uskey ? encodeURIComponent(uskey) : '',
        'X-Bus-Params-Md5': nodeCrypto.createHash('md5').update(params, 'utf8').digest('hex'),
        'X-Timestamp': String(ts),
      };
    },
  };
}

module.exports = { createSigner, getSdk, __webpack_require__ };

// 直接运行时做冒烟测试
if (require.main === module) {
  const signer = createSigner();
  const h38 = signer.getH38();
  console.log('h38 =', h38);
  console.log('deviceId =', signer.getDeviceId());
  const t0 = Date.now();
  const headers = signer.sign();
  const dt = Date.now() - t0;
  console.log('签名耗时:', dt, 'ms');
  console.log('X-Timestamp:', headers['X-Timestamp']);
  console.log('X-Bus-Params-Md5:', headers['X-Bus-Params-Md5']);
  console.log('X-Uskey 长度:', headers['X-Uskey'].length, '前80:', headers['X-Uskey'].slice(0, 80));
  const h2 = signer.sign();
  console.log('两次签名不同(非确定性):', headers['X-Uskey'] !== h2['X-Uskey']);
}
