# 行为验收（真实 DSH profile）

自动化测试用临时 profile 覆盖了清单增删和升级的状态机；下面这两项必须在**真实 DSH 实例**里观察，因为验收的是“用户三秒内看到什么”，而不只是数据。

> 请在一个**一次性测试 profile** 里做，不要改动日常 profile。测试完删除 fixture 与测试 profile。

## 准备

1. 构建插件：

   ```bash
   pnpm install
   pnpm run build
   ```

2. 造一个监听已删除事件的 fixture 插件（`session/events` 不在当前宿主词表中；当前事件是 `session/event`）：

   ```text
   dsh-sentinel-fixture/
   ├── package.json
   └── index.js
   ```

   `package.json`：

   ```json
   {
     "name": "dsh-sentinel-fixture",
     "version": "0.0.1",
     "private": true,
     "type": "module",
     "main": "./index.js",
     "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
   }
   ```

   `index.js`：

   ```js
   export const name = 'sentinel-fixture'
   export function apply(ctx) {
     ctx.on('session/events', () => {
       console.log('this listener can never fire')
     })
   }
   ```

   `cordis.patch.yml`：

   ```yaml
   - insert:
       - id: sentinel-fixture
         name: dsh-sentinel-fixture
   ```

3. 把 `dsh-sentinel` 与 `dsh-sentinel-fixture` 都安装进测试 profile（插件管理页“从本地目录安装”，或 `plugin_manager` 的 `install_bundle`），重启 DSH。

## 验收 1：损坏项置顶、不可折叠

1. 打开右侧边栏的引导页（guide）。
2. 打开 **插件健康** 卡片。
3. 期望：
   - 顶部第一组是 **● 确定性损坏 (1)**；
   - 列出 `dsh-sentinel-fixture@0.0.1`；
   - 下面一行写着“监听 session/events，但当前版本词表中不存在”；
   - 有“检查更新或联系作者”的建议；
   - 这一组没有折叠控件；**健康** 组默认折叠；
   - 底部显示引擎状态、词表来源（内置快照时带“可能滞后”提示）和检查时间。

## 验收 2：卸载后无需重启自动消失

1. 在插件管理页卸载 `dsh-sentinel-fixture`（或从测试 profile 的依赖里移除）。
2. 不要重启 DSH，等待约 1–6 秒（清单监听 400ms 防抖 + 面板 5s 刷新）。
3. 期望：
   - “确定性损坏”组变成 0 / 显示“未发现确定性损坏”；
   - 报告里的 `scanned_packages` 减 1；
   - 面板没有被替换成错误页。

## 验收 3：工具与 JSON 与面板一致

1. 在对话里让 Agent 调用 `plugin_health_report`（不带参数），确认文本摘要与面板一致。
2. 再调用 `plugin_health_report` 并传 `format: "json"`，确认返回合法 JSON。
3. 在已登录的 Web 页面同源打开 `/dsh-sentinel/report.json`，确认与工具 JSON 一致；`damaged`、`unknown`、`healthy_count` 三组分值与面板相同。

## 验收 4：降级路径

- **词表不可用**：自动化用例 `tests/catalog.test.mjs` / `tests/report.test.mjs` 覆盖；真实环境可临时把 `snapshot/catalog.json` 指向不存在的位置复现（不要提交该改动），期望状态为“词表不可用”、`damaged` 为空。
- **面板不可用**：在浏览器控制台禁用侧边栏服务不现实；`tests/client.test.mjs` 用缺 `sidebarRightTabs` 的宿主验证了客户端不抛异常并上报 `panel_register_failed`，宿主工具返回状态“自检失败”。

## 收尾

- 卸载两个测试插件；
- 删除测试 profile；
- 确认日常 profile 的 `package.json` / `cordis.patch.yml` 未被测试改动。
