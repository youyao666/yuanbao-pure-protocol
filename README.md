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
#                YUANBAO_TOOLS=off  (关闭工具调用模拟)
#                YUANBAO_WATERMARK_FREE=off  (关闭无水印换链，默认返回无水印原图)
#   端点: GET  /v1/models
#         POST /v1/chat/completions（流式/非流式；支持 tools/tool_calls 工具调用）
#         POST /v1/images/generations（文生图，同步；size 可指定画幅 16:9/9:16/4:3/3:4
#               或 OpenAI 风格 1792x1024 等）
#         POST /v1/images/async + GET /v1/images/async/{id}（异步生图：提交即返回、轮询取图）
#         POST /v1/files/chat（multipart：file + prompt，文档上传→解析→问答一条龙）
#         POST /v1/images/edits（图生图，标准 multipart） | GET /healthz
#   模型: 任一模型名加 -search 后缀 = 强制联网搜索模式（回答末尾附参考链接），
#         如 hy4-search / deepseek-search

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
- **无水印换链**：SSE 返回的生图直链是 `h1_`（带"元宝 AI生成"水印）版；会话详情接口里每张图另带 `originUrl`（`h0_` 原始无水印版）。生图端点完成后自动按路径匹配替换为 `originUrl` 返回（实测 h0 3786KB vs h1 3527KB，确为两个文件）。总开关 `YUANBAO_WATERMARK_FREE=off`。图生图另有模型侧去水印：模型扩写 prompt 时会主动加"去除水印"指令。
- **工具调用是提示词注入式模拟**：元宝协议不透传 `tools`，服务把工具定义注入 prompt 并解析模型输出的 `<<TOOL_CALL>>` 标记转换为 OpenAI `tool_calls` 格式（流式请求带 tools 时自动切换为缓冲模式）。可靠性依赖模型遵循指令（Hy4 实测稳定）。服务级总开关 `YUANBAO_TOOLS=off`；请求级开关天然存在（不带 tools 数组即不启用）。
- **异步生图任务表是内存态**：服务重启即清空，未做持久化。
- **搜索模式已升级为协议级**：`-search` 后缀走"深度研究"技能（`applicationIdList: ["application_id_deep_research"]`，浏览器抓包实证）。深度研究 agent 可能先反问确认——**问卷会透传给客户端**（结构化 Markdown，含选项与推荐项），客户端把回答作为下一轮消息发来即在同一会话继续研究直至出报告。`YUANBAO_NO_CLARIFY=on` 可恢复"不提问直接答"模式。引用来自 SSE `searchGuid.docs`。
- **会话粘性池的键设计**：`user` 字段（多人 gateway 的租户隔离，OpenAI 标准参数）+ messages 前缀指纹（去掉最后一条消息的全量 hash，含 assistant 回复与 tool_calls 序列化）。首轮历史为空不查池（必新建）；响应完成后以"历史 + 本轮回复"为下一轮存锚；复用时只发最新一条消息，历史由元宝服务端记忆（LRU 100 / TTL 30 分钟）。实测同 user 多轮上下文延续、异 user 不串。残余限制：同 user 且整段历史逐字相同的两条独立对话仍会互粘——这是无状态请求协议的本质极限，多人共用请务必传 `user`。
- **技能广场（skill market）半开矿脉**：端点族 `/api/v1/yuanbao_skill_market/{skills|panel_skills|details|install|uninstall|report_use|connectors}`（纯协议可拉清单，当前 20 个技能：腾讯文档/携程/行情/选股/旅游计划等）；另有连接器授权体系 `/api/connector/v1/connectors/authGuide`（第三方技能需 OAuth）。chat 带 `skillId` 会触发更严格校验（实测"服务繁忙"），正确激活需技能详情（真实 skillId 形态）+ 可能的连接器授权，待续。
- **文档对话已打通**（`/v1/files/chat`，multipart：file + prompt）：上传→COS→asyncFileParse→chat 引用，实测 txt 内容精确读取（连续三问三中）。关键坑：资源 `type` 必须按扩展名映射（txt→`txt`、pdf→`pdf`、doc/docx→`doc`、xls/xlsx/csv→`excel`、代码→`code`，源自码模块 8879/10854），填 `doc` 或 `file` 模型都读不到。
- **图片编辑五件套（协议已验证，待上游恢复）**：`POST /api/image/{clarity|style|outpainting|elimination|removewatermark}`，body `{imageUrl, initOperateType(1清晰度/2去水印/3风格/4扩图/5消除), isReset}`，无需 QIMEI 签名，响应 SSE（`step`→`progress` 0~0.99→结果/错误）。实测 removewatermark 协议全通（进度流正常走完），但上游修图微服务（内部 `:8001/openapi/v1/images/retouch/watermark_removals`，30s 超时，多 IP 负载均衡）当日持续超时，待恢复即可接入。
- **技能 applicationId 激活规律**：`deep_research` 经 `applicationIdList` 可激活专属 agent（已集成 `-search`）；`ai_coding` 等技能型 ID 在普通 chat 入口不响应（`applicationIdList`/`skillId` 双形态实测均维持 `main_agent_hy_for_pc`），需技能广场（skill market）配套上下文才能激活。全量 ID 清单（源码枚举）：`deep_research`、`web_search`、`knowledge_search`、`ai_coding`、`ai_reading`、`ai_answering`、`ai_writing`、`ai_image`、`ppt_generation`、`data_analysis`、`investment_analysis`、`professional_writing`、`personal_plan`、`teaching_assistant`、`voice_recorder`、`working_agent`。
- **视频生成（灰度中）**：`GET /api/user/agent/ai_video/get_user_limits` 纯协议可查（实测日配额 5 次）；`text2video/image2video`（generationType=3）、AIGC 创作页（`/chat/ai-creation`）配置端点族齐全，但当前账号 `get-tab-list` 返回空（未下发模板）。待 tab 非空后在创作页抓包 `directGenerate` 即可复刻。
- **搜索控制状态机**（源码逆向，模块 27889）：`supportFunctions` 含 `openInternetSearch`→强开 / `closeInternetSearch`→强关 / `autoInternetSearch`→智能；`chatModelExtInfo.internetSearch` 同值域。纯协议下仅改这些值不生效，需配合 applicationIdList。
- **生图比例走 prompt 指令**：`size` 参数映射为"画幅比例 X:Y"追加到 prompt（元宝生图无原生比例参数），实测 16:9 → 2048x1152 精确生效。
- **凭据过期识别**：上游错误码 20001/23000 会被转成 HTTP 401 + `code: yuanbao_token_expired`，提示运行登录器。
- **token 寿命**：实测持续有效中（具体寿命待观察）；401 即重跑登录器。
- **意图路由对措辞敏感**（服务端意图模型判定，非本工具问题）：文生图 prompt 需带绘画动词（缺了 server 会自动补"画："前缀）；图生图带 `plugin:""`（`Adaptive` 会走图片理解分支只出文字）；"用户：xxx"式对话前缀会触发搜索模式（prompt 膨胀、输出碎片化），所以 server 的 messages 拼接刻意避开。
- **请求头必须整套**：网关校验浏览器头完整性，缺 `x-requested-with`/`x-commit-tag`/`x-instance-id` 等会返回"服务繁忙，请稍后再试"（= 签名/风控拒绝）。
- **Windows Git Bash 的 curl -F 测 multipart 会把中文转 GBK 乱码**（上游意图模型收到乱码即不生图），请用 Node/标准客户端测试 `/v1/images/edits`。
- **匿名路径**：已验证走不通——匿名凭据虽可 create，但 chat 被服务端拒绝（`requireLogin:true`）；自行签发匿名凭据还会被图灵盾（Turing Shield）拦截。不要在这条路上花时间。

## 七、安全注意

- `yuanbao-cookie.json` 等于你的元宝账号登录态，**严禁**提交 git / 打包分享 / 发给他人。
- 本包 zip 中不含任何凭据；拿到包后需自行 `node yuanbao-login.js` 生成。
- 生图消耗账号额度，注意使用频率。
