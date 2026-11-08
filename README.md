# dsh-sentinel

> 插件健康哨兵：在 DSH 启动和插件清单变化时，静态检查已安装插件是否有“确定性损坏”，把结果放到侧边栏、Agent 工具和结构化 JSON 里；自身任何故障只降级、不炸宿主。

确定性损坏的定义：**插件源码仍在监听某个事件，但当前 DSH 版本的事件词表里已经没有这个名字。** 这个监听器永远不会被触发，插件的某项功能已经静默失效。哨兵只做静态解析，不执行、不加载、不 import 被检查的插件。

- 只读：不修改、不启用、不卸载任何插件。
- 静态：不执行被检查代码，不解析其运行时依赖。
- 可降级：`apply` 永不抛出异常；每个输出表面独立守卫。
- 可解释：每一条“损坏”都给出事件名，每一条“未检查”都给出原因，报告底部给出词表来源。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [安装](#安装)
- [三种输出](#三种输出)
- [判定规则](#判定规则)
- [触发与增量](#触发与增量)
- [事件词表从哪里来](#事件词表从哪里来)
- [状态与降级](#状态与降级)
- [扫描范围与已知限制](#扫描范围与已知限制)
- [开发与测试](#开发与测试)
- [与 `tech_design.md` 的实现差异](#与-tech_designmd-的实现差异)
- [安全与隐私](#安全与隐私)

---

## 它解决什么问题

DSH 的插件通过 `ctx.on(event, handler)` / `ctx.waterfall(event, handler)` 订阅事件。事件名是字符串，TypeScript 的类型检查只在编译期有效；插件安装之后，宿主升级就可能删掉某个事件。此时插件照常加载、照常启动，只是那段功能再也不执行 —— 没有报错、没有日志，用户只会觉得“这个插件的某个按钮没反应”。

哨兵把这件事变成可见的：

- 哪个插件可能坏了；
- 坏在监听哪个事件；
- 这个结论建立在哪份词表上；
- 哪些插件因为写法无法静态判断，因此**没有**下结论。

---

## 安装

要求 DSH ≥ 0.1.6（低于该版本时哨兵无法保证非致命加载，但仍会尽量降级）。

```bash
pnpm install
pnpm run build
```

然后在 DSH 中安装这个目录（设置 → 插件 → 从本地目录安装，或通过 `plugin_manager` 的 `install_bundle`）。发布到 npm 之后也可以：

```bash
dsh plugin add dsh-sentinel
```

### 可选环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_SENTINEL_CATALOG` | 指定一份**带分发模式列**的 Markdown 词表；优先于按约定搜索到的 `persistence-catalog.md` |
| `DSH_PROFILE_DIR` | DSH 会为插件进程注入；哨兵用它定位 profile 的 `package.json` 与 `node_modules` |

profile 目录按以下顺序解析：`DSH_PROFILE_DIR` → `$DSH_HOME/profiles/$DSH_PROFILE`。词表按 `DSH_SENTINEL_CATALOG`、`<profile>/docs/persistence-catalog.md`、`<profile>/persistence-catalog.md`、`<cwd>/persistence-catalog.md`、`<cwd>/docs/persistence-catalog.md`、`$DSH_HOME/...` 的顺序查找。

---

## 三种输出

### 1. 侧边栏面板

右侧边栏的引导页（guide）里会出现一张 **插件健康** 卡片，打开后是一个原生 tab：

- **确定性损坏**：置顶、不可折叠。每个包给出 `package@version`、缺失的事件名，以及“检查更新或联系作者”的建议。
- **未检查**：变量/拼接事件名、没有监听任何事件、源码不可读，分别给出原因。
- **健康**：默认折叠，只显示数量。
- **体检引擎状态**：底部显示 `正常 / 词表不可用 / 自检失败 / 部分扫描`、词表来源与版本、检查时间、降级原因。

面板每 5 秒读取一次宿主缓存的报告（只在 tab 可见时轮询；这不是重新扫描），因此清单变化后面板会自动更新，不需要刷新页面或重启。

### 2. Agent 工具 `plugin_health_report`

在对话里让 Agent 调取当前报告：

- 无参数：返回文本摘要；
- `format: "json"`：返回结构化 JSON 字符串。

工具描述明确说明它返回“当前已安装插件的健康检查结果，包括确定性损坏和无法检查的插件”。

### 3. 结构化 JSON

宿主注册了一个精确路由：

```text
GET /dsh-sentinel/report.json
```

响应即下面的报告（`Cache-Control: no-store`）。首次扫描完成前返回 `{ "status": "scanning" }`。同一进程内还有 `POST /dsh-sentinel/degraded`，仅供浏览器半边在面板注册失败时上报降级，不对外提供能力。

```json
{
  "generated_at": "2026-11-07T10:00:00.000Z",
  "catalog_source": "builtin_snapshot",
  "catalog_version_hint": "0.2.2-rc.1",
  "catalog_generated_at": "2026-11-08T00:13:43.719Z",
  "engine_status": "normal",
  "engine_reason": "",
  "degradations": [],
  "damaged": [
    {
      "package": "some-plugin",
      "version": "1.2.0",
      "events": ["session/events"],
      "reason": "event_not_in_catalog"
    }
  ],
  "unknown": [
    {
      "package": "unknown-plugin",
      "version": "0.1.0",
      "reason": "no_literal_event_names"
    }
  ],
  "healthy_count": 12,
  "scanned_packages": 15,
  "scan_errors": []
}
```

`damaged[].reason` 目前只有一个值：`event_not_in_catalog`。`unknown[].reason` 的枚举：

| 原因 | 含义 |
| --- | --- |
| `no_literal_event_names` | 有监听，但事件名是变量、拼接或带插值的模板，无法静态确定 |
| `no_event_listeners` | 源码里没有监听任何事件 |
| `source_unreadable` | 入口或源码不可读，或词法解析失败 |

---

## 判定规则

对每个包，扫描器收集 `ctx.on(...)` / `ctx.waterfall(...)` 的**字符串字面量**事件名，与词表求差：

| 情况 | 结果 |
| --- | --- |
| 至少一个监听事件不在词表中 | `damaged`，列出所有缺失事件 |
| 所有监听事件都在词表中 | `healthy` |
| 没有任何字面量事件名 | `unknown`，不判损坏也不判健康 |
| 源码不可读 / 解析失败 | `unknown(source_unreadable)`，并把引擎标成 `scan_partial` |

只报告“缺失”，不报告“新增事件”，也不比较分发模式是否变化 —— 模式变化的影响需要人工判断，哨兵不做这个判断。

---

## 触发与增量

**启动**：`apply` 只做注册（面板、工具、路由、清单监听），然后返回；全量检查在一个 `setTimeout(0)` 里异步执行，不在 `apply` 内做任何文件扫描。

**清单变化**：监听 profile 目录里的 `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-lock.yaml` 写入，做 400ms 防抖后：

1. 重新读取 `package.json` 的 `dependencies`；
2. 从每个已安装包的 `package.json` 读取**真实版本号**（因此 `link:`、`^1.2.0` 这类范围也能识别升级）；
3. 与上一份快照比较，只重新扫描**新增 / 版本变化**的包；
4. 对清单里已消失的包，直接删除其扫描结果 —— 不需要卸载钩子，清单里不再出现就视为已卸载。

**不做什么**：不监听运行期 `emit` / `waterfall` 事件（那会引入事件兼容性风险，与哨兵定位矛盾），不做后台定时轮询，不因为面板打开而触发重扫。

---

## 事件词表从哪里来

这是本插件最需要解释清楚的一点，也是与开发文档描述差得最多的地方。

### 来源 A：`persistence-catalog.md`

加载器接受一份 Markdown 表格，必须同时有**事件名列**和**分发模式列**：

```markdown
| Event | Mode |
| --- | --- |
| `session/event` | `emit` |
| `tools/pre-execute` | `waterfall` |
```

表头识别是宽松的：`Event` / `Event name` / `Name` 都行，`Mode` / `Dispatch` / `Dispatch mode` 都行；单元格里的反引号、加粗、`event:` 前缀会被去掉。**如果表格有事件名却没有模式列，加载器会显式抛错，而不是静默返回空集** —— 空集会让每个监听都变成“损坏”，这是最危险的误报。

**现实情况**：DSH 0.2.x 的 `docs/persistence-catalog.md` 由 `pnpm run gen-persistence-catalog` 生成，记录的是**持久化 Session 事件类型**（形如 `event:session/title`、`event:tool/call`），没有 Cordis 分发模式列。它描述的是“写进会话日志的事件”，不是“`ctx.on` 能监听到的事件”。因此严格按结构判断时它属于“不兼容”，加载器会记录一条 warning 并回退到来源 B。这正是开发文档 §3.1 写明的兼容性兜底路径。

### 来源 B：内置快照 `snapshot/catalog.json`

只包含 `{ name, mode }` 两个字段，当前由 DSH **0.2.2-rc.1** 的机器可读 Cordis 事件目录生成：

```text
packages/extensions/tool-cordis/src/api-catalog.ts#EVENT_API
```

这个文件是 `cordis_inspect` 背后的同一份数据，也是已发布 DSH 产物里**唯一同时带事件名和分发模式**的清单（90 个事件）。重新生成：

```bash
# 需要先 pnpm install && pnpm run build
node scripts/gen-snapshot.mjs \
  --from-cordis-api <deepseek-harness>/packages/extensions/tool-cordis/src/api-catalog.ts \
  --dsh-version 0.2.2-rc.1
```

也支持从一个带模式列的 Markdown 词表生成：

```bash
node scripts/gen-snapshot.mjs --from-markdown ./persistence-catalog.md --dsh-version 0.2.2-rc.1
```

快照只反映生成时的 DSH 版本。使用来源 B 时，面板和工具都会明确显示“内置快照，可能滞后于当前 DSH 版本”。

### 两者都不可用

引擎进入 `catalog_unavailable`，**不输出任何“损坏”结论**，只报告“无法获取词表”。这是刻意的 fail-closed：没有基线就没有结论。

---

## 状态与降级

`engine_status` 只有四个值：

| 状态 | 触发条件 | 结论 |
| --- | --- | --- |
| `normal` | 词表可用，所有包都完整扫描 | 完整报告 |
| `catalog_unavailable` | 词表和快照都不可用 | 无损坏结论，只报告原因 |
| `self_check_failed` | 启动自检失败（读不到自身文件 / profile 清单），或侧边栏注册失败 | 保留已有报告；写明降级原因 |
| `scan_partial` | 至少一个包源码不可读 / 解析失败 | 其余包的结论仍然有效 |

降级原因使用枚举，不向 UI 暴露堆栈：

| 原因 | 用户看到的话 |
| --- | --- |
| `panel_register_failed` | 侧边栏注册接口不可用，已回退到仅工具/JSON 输出 |
| `tool_register_failed` | Agent 工具注册失败，报告只能从侧边栏或 JSON 读取 |
| `catalog_load_failed` | 事件词表加载失败，无法给出任何“损坏”结论 |
| `scan_failed` | 插件扫描失败，结果可能不完整 |
| `profile_watch_failed` | 无法监听 profile 插件清单变化，新增/卸载不会自动反映 |
| `self_check_failed` | 体检插件与当前 DSH 版本不兼容，部分能力已静默 |

自身隔离分三层：

1. **不进入 required 名单**：`cordis.patch.yml` 只插入一行普通条目；DSH 0.1.6+ 对非 required 条目失败只打 warning。
2. **`apply` 永不抛出**：路由、工具、监听、异步扫描分别 `try/catch`，失败只记录枚举原因。
3. **启动自检**：`apply` 最开始检查自身 `package.json` 与 profile 清单是否可读；不可读就进入 `self_check_failed`，不执行扫描，工具仍可调用并解释原因。侧边栏不可用由浏览器半边检测，并回报给宿主，工具/JSON 继续工作。

---

## 扫描范围与已知限制

**扫描什么**

- 入口：`package.json` 的 `main` / `module` / `exports["."]`，都没有时退回 `index.{js,mjs,cjs,ts,mts,cts,jsx,tsx}`；
- 入口文件的**一层直接相对导入**（`import`、`export from`、`require()`、动态 `import()`），覆盖常见的单文件/两文件插件结构；
- 单包最多解析 48 个文件，超过会把该包标成 `scan_partial`。

**不扫描什么**

- 浏览器半边（`exports["./client"]`）—— 那是另一套客户端事件词表，混进来只会误报；
- 更深层的跨文件传递、barrel 文件再导出；
- `node_modules` 依赖、动态生成的代码。

**明确不做的判断**

- `const c = ctx; c.on(...)` 这类别名不会被识别（只认接收者字面量 `ctx`）；
- 事件名是变量、拼接、带 `${}` 的模板时不猜测，记入“未检查”；
- 第三方插件通过 Cordis 声明合并自定义的事件不在官方词表里。监听这类事件的插件会被判为“缺失”——这是“确定性损坏”定义的边界：哨兵只认宿主版本的事件词表，不读其他插件的类型声明；
- 不判断插件版本范围是否与 DSH 兼容（那是安装前检查的事）；
- 不判断分发模式变化是否影响插件；
- 不持久化报告：重启后重新计算，不写 `$DSH_HOME`。

**安全边界**

- 只读 `readFileSync` / `statSync` / `realpathSync`，不 `import()`、不 `require()`、不执行被检查代码；
- 入口与相对导入都做 `realpath` 校验，符号链接不能把扫描带出包目录；
- 宿主进程不发起任何网络请求；HTTP 路由只读本地内存里的报告；
- 面板不读其他插件的 DOM/样式，只使用宿主主题 token。

---

## 开发与测试

需要 Node.js ≥ 22.19。

```bash
pnpm install
pnpm run build      # tsc -> lib/
pnpm test           # build + node --test
pnpm run check      # build + client 语法检查 + 测试
```

`src/` 是 TypeScript 源码，`lib/` 是提交到仓库的构建产物（`main` 指向 `lib/index.js`，这样从 git/本地目录安装无需构建）。`client/client.js` 是手写的浏览器 bundle，遵循 DSH 的 `window.__ModuleLoader__` 格式，因此不参与 `tsc`。

### 测试与验收标准的对应

| 开发文档 §7 | 测试文件 | 覆盖内容 |
| --- | --- | --- |
| 1. `diff` 函数 | `tests/diff.test.mjs` | 空集、全重叠、全不重叠、重复名、三类分组 |
| 2. `catalog` 解析 | `tests/catalog.test.mjs` | Markdown 表格、名称/模式列、缺模式列抛错、快照回退、双源不可用 |
| 3. `scanner` 解析 | `tests/scanner.test.mjs` | 字面量、注释/字符串/正则、变量与拼接、模板、一层导入、只扫根导出 |
| 4. `apply` 不抛 | `tests/apply.test.mjs` | 缺 tools/webServer、`inject` 抛错、自检失败 |
| 5. 面板失败但工具可用 | `tests/apply.test.mjs`、`tests/client.test.mjs` | 客户端上报降级、工具返回 `self_check_failed` 报告 |
| 6. 词表不可用 | `tests/catalog.test.mjs`、`tests/report.test.mjs` | `catalog_unavailable`、不输出损坏结论 |
| 7–8. 行为（真实 profile） | `tests/manifest.test.mjs` + [`docs/manual-verification.md`](docs/manual-verification.md) | 清单增删/升级的增量逻辑；真实面板的手工验收步骤 |

行为测试在真实 DSH profile 中需要安装 fixture 插件、观察面板和卸载后的变化；自动化部分用临时 profile 目录覆盖了同样的状态机，手工步骤见 [docs/manual-verification.md](docs/manual-verification.md)。

---

## 文件结构

```text
dsh-sentinel/
├── package.json
├── cordis.patch.yml          # bundle patch：只插入一行普通条目
├── icon.svg                  # 插件管理页图标
├── locale/{en,zh}.json       # 插件管理页标题与描述
├── src/
│   ├── index.ts              # 宿主入口：apply、工具、路由、清单监听、扫描编排
│   ├── scanner.ts            # 静态解析：ctx.on / ctx.waterfall 的字面量事件名
│   ├── catalog.ts            # 读取 Markdown 词表或内置快照
│   ├── diff.ts               # 纯函数：监听集合 × 词表 → damaged/unknown/healthy
│   ├── report.ts             # 组装 JSON 与文本报告
│   ├── safe.ts               # 降级原因枚举、try/catch 包装器、启动自检
│   └── types.ts              # 共享类型
├── client/
│   └── client.js             # 浏览器半边：侧边栏 tab、面板渲染、失败上报
├── snapshot/
│   └── catalog.json          # 内置最小词表（name + mode）
├── scripts/
│   └── gen-snapshot.mjs      # 从 Cordis 目录或 Markdown 词表生成快照
├── tests/                    # node --test，52 个用例
├── docs/manual-verification.md
├── lib/                      # 构建产物（提交进仓库）
├── README.md
├── tech_design.md            # 原始开发文档
└── LICENSE
```

`src/index.ts` 是**唯一**接触 DSH 宿主 API 的源码文件；`scanner.ts`、`catalog.ts`、`diff.ts`、`report.ts` 不依赖宿主，可以在 Node 中单独测试；`safe.ts` 统一所有降级路径。

---

## 与 `tech_design.md` 的实现差异

实现时以“能在当前 DSH 0.2.2 上真实工作”为准，以下是三处必要的差异，均不影响文档定义的输出契约：

1. **Host / Client 两半。**
   文档把面板注册写在 `index.ts` 里，并称它是唯一碰 DSH API 的文件。实际 DSH 的 `ctx.sidebarRightTabs` / `ctx.slots` 是浏览器侧服务，宿主进程拿不到。因此增加了 `client/client.js`：它只负责原生 tab 注册、面板渲染和失败上报；宿主 `src/index.ts` 仍然只碰 `tools`、`webServer`、`fs.watch` 这些宿主能力。面板通过 `GET /dsh-sentinel/report.json` 读宿主报告，与 JSON 消费方看同一份数据。
   如果目标 DSH 没有侧边栏 API，客户端会跳过注册并把 `panel_register_failed` 上报给宿主；工具与 JSON 不受影响。

2. **词表来源的落地方式。**
   文档假设 `persistence-catalog.md` 带 `emit` / `waterfall` / `parallel` 分发模式。DSH 0.2.x 的实际文件记录的是持久化 Session 事件类型，没有模式列。加载器仍然完整实现文档要求的 Markdown 解析与“结构不符就抛错”，但真实环境的这份文件会被判定为不兼容并回退到内置快照；快照改由 `api-catalog.ts#EVENT_API` 生成（90 个宿主事件，版本 0.2.2-rc.1）。报告中会明确标注来源，不会把滞后词表伪装成权威词表。

3. **`self_check_failed` 的时机。**
   文档说自检失败就“不执行任何扫描”，但 §7.5 又要求面板失败时工具返回 `self_check_failed` 的报告。实现上区分两种情形：
   - 启动自检失败（读不到自身文件 / profile 清单）：不扫描，立即给出一份只含状态与原因的 report；
   - 侧边栏注册失败：已经得到的扫描结果保留，状态改为 `self_check_failed` 并写明“已回退到仅工具/JSON 输出”。

另外，JSON 在文档要求的字段之外增加了 `engine_reason`、`degradations`、`catalog_generated_at`、`scanned_packages`、`scan_errors` 五个字段，均为只增不改；`damaged` / `unknown` / `healthy_count` / `catalog_source` / `catalog_version_hint` / `engine_status` 的语义与文档一致。

---

## 安全与隐私

- 不收集遥测，不联网，不写用户 profile；
- 报告只存在于进程内存，HTTP 路由 `no-store`；
- 扫描器只读取**已安装插件包内部**的文本文件，符号链接会被 `realpath` 拦在包外；
- 面板与工具展示错误时只给可读句子，不展示内部堆栈；
- 路由返回的包名/版本本来就是本机 profile 的公开信息，不包含源码内容。

---

## License

[MIT](./LICENSE)
