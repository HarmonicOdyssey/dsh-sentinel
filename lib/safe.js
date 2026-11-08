/**
 * Every degradation path goes through this module.
 *
 * The rules it exists to enforce:
 *  - `apply` never throws. Each surface is guarded independently.
 *  - A failure is recorded as an enum plus one readable sentence, never as a
 *    boolean and never as a stack trace shown to the user.
 *  - The startup self-check answers one question: can this DSH host give the
 *    sentinel what it needs to read files and publish a report at all?
 */
import fs from 'node:fs';
/** One readable sentence per reason. Used by the panel, the tool, and the JSON. */
export const DEGRADATION_TEXT = Object.freeze({
    panel_register_failed: '侧边栏注册接口不可用，已回退到仅工具/JSON 输出',
    tool_register_failed: 'Agent 工具注册失败，报告只能从侧边栏或 JSON 读取',
    catalog_load_failed: '事件词表加载失败，无法给出任何“损坏”结论',
    scan_failed: '插件扫描失败，结果可能不完整',
    profile_watch_failed: '无法监听 profile 插件清单变化，新增/卸载不会自动反映',
    self_check_failed: '体检插件与当前 DSH 版本不兼容，部分能力已静默',
});
/** Turn any thrown value into one safe line. */
export function describeError(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
/**
 * Run a synchronous step. A throw is recorded and swallowed.
 *
 * @returns the step's value, or `undefined` after a failure.
 */
export function guard(reason, record, step) {
    try {
        return step();
    }
    catch (error) {
        record(reason, describeError(error));
        return undefined;
    }
}
/** Run an asynchronous step. A rejection is recorded and swallowed. */
export async function guardAsync(reason, record, step) {
    try {
        return await step();
    }
    catch (error) {
        record(reason, describeError(error));
        return undefined;
    }
}
/**
 * The startup self-check.
 *
 * It is deliberately shallow and synchronous: read the sentinel's own manifest
 * and the profile manifest. Both are files the engine will need later, so a
 * failure here means scanning would fail for the same reason. Service
 * availability (`tools`, `webServer`, the sidebar) is checked where each
 * surface is registered, so a missing service degrades that surface only.
 */
export function selfCheck(options) {
    const failures = [];
    try {
        const own = fs.readFileSync(`${options.packageRoot}/package.json`, 'utf8');
        const parsed = JSON.parse(own);
        if (parsed.name !== 'dsh-sentinel') {
            failures.push('包根目录不可识别（package.json 名称不是 dsh-sentinel）');
        }
    }
    catch (error) {
        failures.push(`无法读取插件自身文件：${describeError(error)}`);
    }
    if (options.profileDir === null || options.profileDir === '') {
        failures.push('无法定位 DSH profile 目录（缺少 DSH_PROFILE_DIR / DSH_PROFILE）');
    }
    else {
        try {
            fs.readFileSync(`${options.profileDir}/package.json`, 'utf8');
        }
        catch (error) {
            failures.push(`无法读取 profile 插件清单：${describeError(error)}`);
        }
    }
    return { ok: failures.length === 0, failures };
}
