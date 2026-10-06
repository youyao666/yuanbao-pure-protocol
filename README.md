# 元宝纯协议工具包（yuanbao-pure-protocol）

腾讯元宝网页版（yuanbao.tencent.com）的纯协议实现：**零浏览器、纯 Node 直连**，支持文本对话（流式）、AI 生图（文生图 + 图生图）、扫码自动登录。

研究性质项目，请勿商用；账号风险自负。

---

## 一、原理一句话

元宝网页版 2.83 之后对 `/chat/` 和 `/conversation/create` 两个路径强制 QIMEI 签名校验（`X-Uskey` / `X-Bus-Params-Md5` / `X-Timestamp`）。签名函数 `getUSKeySync` 被 jsvmp 字节码虚拟机保护、无法静态逆向——本工具改为**整体搬迁**：从元宝网页 dump 出全部 2524 个 webpack 模块（`qimei-modules.json`），在 Node 里用迷你 webpack runtime + 浏览器环境桩把它原样跑起来，签名与浏览器产出逐字节同源。

- 身份 = cookie `hy_user` + `hy_token`（扫码登录获得）
- 设备指纹（`X-HY92`/`X-HY93`）= QIMEI 本地生成，与身份解耦，换环境自动生成新指纹即可
- `X-Bus-Params-Md5` = `md5("h38=<指纹>&timestamp=<毫秒>&platform=web")`，纯算法

## 二、环境要求

- Node.js ≥ 20（实测 24.13；用到原生 fetch / WebSocket / TextDecoder）
- 无需任何 npm 依赖，无需浏览器常驻
- Windows / Linux / macOS 均可（登录器找 Chrome 的路径表目前只写了 Windows 常见位置）

## 三、文件清单

| 文件 | 作用 |
|---|---|
| `qimei-standalone.js` | 核心：QIMEI SDK 搬迁运行器，对外导出 `createSigner()` |
| `qimei-modules.json` | 核心依赖：从元宝网页 dump 的全部 webpack 模块（约 10.6MB） |
| `yuanbao-probe.js` | 探针：文本对话 + 生图（文生图/图生图）+ SSE 解析 + 图片落盘 |
| `yuanbao-server.js` | OpenAI 兼容服务：`/v1/chat/completions`（流式/非流式）、`/v1/models`、`/v1/images/generations`、`/v1/images/edits` |
| `yuanbao-login.js` | 登录器：拉起 Chrome 扫码，自动抓凭据并验证（`--anon` 为匿名游客模式，仅研究用） |
| `README.md` | 本文档 |

运行后本地生成（**敏感，勿外传**）：

| 文件 | 内容 |
|---|---|
| `yuanbao-cookie.json` | `hy_user` + `hy_token` 凭据（登录器写入） |
| `qimei-storage.json` | Node 环境 QIMEI 设备指纹（删除后会自动生成新指纹，不影响使用） |

## 四、快速开始

```bash
# 1. 首次：扫码登录，生成凭据（约 30 秒）
node yuanbao-login.js
# 浏览器弹出后扫码；日志出现"验证通过"即成功，浏览器自动关闭。

# 2. 文本对话（默认 Hy4 preview）
node yuanbao-probe.js "你好"

# 3. 指定模型（实测可用内部 ID）
node yuanbao-probe.js "你好" deep_seek_v3            # DeepSeek（深度思考）
node yuanbao-probe.js "你好" hunyuan_gpt_175B_0404   # Hy3（日常）
node yuanbao-probe.js "你好" hunyuan_omnipotent_hy4  # Hy4 preview（复杂任务，默认）

# 4. AI 生图（约 15~25 秒，一次 4 张，自动下载到 images/）
node yuanbao-probe.js --image "画一只毛茸茸的小猫"

# 5. 图生图（上传本地图片 + 改造指令，自动下载结果到 images/）
node yuanbao-probe.js --image2img 输入图.png "把这张图里的猫变成素描风格"
#    上传链路: genUploadInfo → COS PUT(授权放 authorization 头) → asyncFileParse
#    chat 的 multimedia[] 引用 resourceId 即可，signUrl 可省略

# 6. 启动 OpenAI 兼容服务（Cherry Studio 等客户端直连）
node yuanbao-server.js                          # 默认 http://127.0.0.1:8788/v1
#   可选环境变量: YUANBAO_PORT=8788  YUANBAO_API_KEY=sk-xxx(开启后校验 Bearer)
#   端点: GET /v1/models | POST /v1/chat/completions(流式/非流式)
#         POST /v1/images/generations | POST /v1/images/edits(标准multipart) | GET /healthz

# 7. cookie 过期后（表现为 401）：重跑登录器
node yuanbao-login.js
```

## 五、协议速记（对接其它实现时用）

```
流程:  POST /api/user/agent/conversation/create  {"agentId":"naQivTmsDa"}
       → 响应 {"id":"<会话ID>"}
       POST /api/chat/{会话ID}  （SSE 流式响应）

chat 请求体要点:
  model: "gpt_175B_0404"            # 固定马甲字段，永远填它
  chatModelId: <真实模型ID>          # 见上文三个 ID
  plugin: ""                        # 生图时填 "Adaptive"
  version: "v2", isTemporary: false
  chatModelExtInfo: '{"modelId":"<模型ID>",...}'   # JSON 字符串

SSE 响应:
  文本: {"type":"deepSearchAgent","contents":[{"type":"think"|"text","text":...}]}
  生图: {"type":"replace","replace":{...,"assetId":...,"multimedias":[{url}]}}
  收尾: {"type":"meta","tokenUsageInfo":{...}} → data: [DONE]

公共头: Cookie(hy_user/hy_token) + x-agentid/x-id/t-userid + x-hy92/x-hy93
签名头(仅 create 与 /chat/): x-uskey / x-bus-params-md5 / x-timestamp
```

## 六、维护与排障

- **网页改版后签名失效**：表现为 create 返回 400/401 或"服务繁忙"。此时需重新 dump `qimei-modules.json`：用浏览器打开元宝 → 控制台执行 `webpackChunk_N_E.push([[tag],{},q=>window.__wr=q])` 钩出模块表 → 导出 `__wr.m` 全量源码合并为 `{modules:{id:source}}` JSON。入口模块 ID 会漂移（当前为 77004，历史上有 12601 等），可扫描含 `getUSKeySync` 字符串的模块定位。
- **控制台噪音**：SDK 初始化时会向 console 打印环境探测对象（无害），关键输出均带 `[probe]`/`[login]` 前缀，可 grep 过滤。
- **token 寿命**：实测持续有效中（具体寿命待观察）；401 即重跑登录器。
- **意图路由对措辞敏感**（服务端意图模型判定，非本工具问题）：文生图 prompt 需带绘画动词（缺了 server 会自动补"画："前缀）；图生图带 `plugin:""`（`Adaptive` 会走图片理解分支只出文字）；"用户：xxx"式对话前缀会触发搜索模式（prompt 膨胀、输出碎片化），所以 server 的 messages 拼接刻意避开。
- **请求头必须整套**：网关校验浏览器头完整性，缺 `x-requested-with`/`x-commit-tag`/`x-instance-id` 等会返回"服务繁忙，请稍后再试"（= 签名/风控拒绝）。
- **Windows Git Bash 的 curl -F 测 multipart 会把中文转 GBK 乱码**（上游意图模型收到乱码即不生图），请用 Node/标准客户端测试 `/v1/images/edits`。
- **匿名路径**：已验证走不通——匿名凭据虽可 create，但 chat 被服务端拒绝（`requireLogin:true`）；自行签发匿名凭据还会被图灵盾（Turing Shield）拦截。不要在这条路上花时间。

## 七、安全注意

- `yuanbao-cookie.json` 等于你的元宝账号登录态，**严禁**提交 git / 打包分享 / 发给他人。
- 本包 zip 中不含任何凭据；拿到包后需自行 `node yuanbao-login.js` 生成。
- 生图消耗账号额度，注意使用频率。
