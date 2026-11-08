/**
 * The static scanner.
 *
 * It answers one question for a package: which event names does its source
 * literally pass to `ctx.on(...)` / `ctx.waterfall(...)`? It never executes,
 * imports, or evaluates the package under inspection.
 *
 * Scope (development document §3.2):
 *  - entry files from `main` / `module` / `exports`, plus `index.*` fallbacks;
 *  - direct relative imports one level deep (the common one- or two-file
 *    plugin layout). Deeper cross-file variable passing is out of scope.
 *
 * Only string literals (and template literals with no substitution) count as
 * determined names. Anything else is reported as dynamic, never guessed.
 */
import fs from 'node:fs';
import path from 'node:path';
const REGEX_PREFIX_PUNCT = new Set([
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '{',
    '}',
    ';',
    '=>',
    '+=',
    '-=',
    '*=',
    '/=',
    '&&',
    '||',
    '??',
]);
const REGEX_PREFIX_WORDS = new Set([
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'case',
    'delete',
    'void',
    'throw',
    'new',
    'yield',
    'await',
]);
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
function isDigit(char) {
    return char >= '0' && char <= '9';
}
/** Tokenize enough JavaScript/TypeScript to find call expressions safely. */
function tokenize(source) {
    const tokens = [];
    let error = null;
    let index = 0;
    let line = 1;
    const fail = (message) => {
        if (error === null)
            error = message;
    };
    const previous = () => tokens[tokens.length - 1];
    const canStartRegex = () => {
        const prev = previous();
        if (prev === undefined)
            return true;
        if (prev.kind === 'id')
            return REGEX_PREFIX_WORDS.has(prev.value);
        if (prev.kind === 'punct')
            return REGEX_PREFIX_PUNCT.has(prev.value);
        return false;
    };
    while (index < source.length) {
        const char = source[index] ?? '';
        if (char === '\n') {
            line++;
            index++;
            continue;
        }
        if (char === ' ' || char === '\t' || char === '\r' || char === '\f' || char === '\v') {
            index++;
            continue;
        }
        // Comments.
        if (char === '/' && source[index + 1] === '/') {
            index += 2;
            while (index < source.length && source[index] !== '\n')
                index++;
            continue;
        }
        if (char === '/' && source[index + 1] === '*') {
            const startLine = line;
            index += 2;
            let closed = false;
            while (index < source.length) {
                if (source[index] === '\n')
                    line++;
                if (source[index] === '*' && source[index + 1] === '/') {
                    index += 2;
                    closed = true;
                    break;
                }
                index++;
            }
            if (!closed)
                fail(`第 ${startLine} 行的块注释未闭合`);
            continue;
        }
        // Strings.
        if (char === "'" || char === '"') {
            const quote = char;
            const startLine = line;
            index++;
            let value = '';
            let closed = false;
            while (index < source.length) {
                const current = source[index] ?? '';
                if (current === quote) {
                    index++;
                    closed = true;
                    break;
                }
                if (current === '\n')
                    break;
                if (current === '\\') {
                    const next = source[index + 1] ?? '';
                    if (next === '\n')
                        line++;
                    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
                        value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
                        index += 6;
                        continue;
                    }
                    const escapes = {
                        n: '\n',
                        r: '\r',
                        t: '\t',
                        b: '\b',
                        f: '\f',
                        v: '\v',
                        '0': '\0',
                    };
                    value += escapes[next] ?? next;
                    index += 2;
                    continue;
                }
                value += current;
                index++;
            }
            if (!closed)
                fail(`第 ${startLine} 行的字符串未闭合`);
            tokens.push({ kind: 'string', value, line: startLine });
            continue;
        }
        // Template literals.
        if (char === '`') {
            const startLine = line;
            index++;
            let value = '';
            let closed = false;
            let dynamic = false;
            while (index < source.length) {
                const current = source[index] ?? '';
                if (current === '`') {
                    index++;
                    closed = true;
                    break;
                }
                if (current === '\\') {
                    const next = source[index + 1] ?? '';
                    if (next === '\n')
                        line++;
                    value += next;
                    index += 2;
                    continue;
                }
                if (current === '$' && source[index + 1] === '{') {
                    dynamic = true;
                    // Skip the substitution, honouring nested braces and strings.
                    let depth = 1;
                    index += 2;
                    while (index < source.length && depth > 0) {
                        const inner = source[index] ?? '';
                        if (inner === '\n')
                            line++;
                        else if (inner === '{')
                            depth++;
                        else if (inner === '}')
                            depth--;
                        else if (inner === "'" || inner === '"' || inner === '`') {
                            const innerQuote = inner;
                            index++;
                            while (index < source.length) {
                                const quoted = source[index] ?? '';
                                if (quoted === '\\') {
                                    index += 2;
                                    continue;
                                }
                                if (quoted === '\n')
                                    line++;
                                if (quoted === innerQuote)
                                    break;
                                index++;
                            }
                        }
                        index++;
                    }
                    continue;
                }
                if (current === '\n')
                    line++;
                value += current;
                index++;
            }
            if (!closed)
                fail(`第 ${startLine} 行的模板字符串未闭合`);
            tokens.push({ kind: 'template', value, line: startLine, dynamic });
            continue;
        }
        // Regular-expression literals can contain `ctx.on(`; skip them so they are
        // never mistaken for a call site.
        if (char === '/' && canStartRegex()) {
            const startLine = line;
            index++;
            let inClass = false;
            let closed = false;
            while (index < source.length) {
                const current = source[index] ?? '';
                if (current === '\\') {
                    index += 2;
                    continue;
                }
                if (current === '\n')
                    break;
                if (current === '[')
                    inClass = true;
                else if (current === ']')
                    inClass = false;
                else if (current === '/' && !inClass) {
                    index++;
                    while (/[A-Za-z]/.test(source[index] ?? ''))
                        index++;
                    closed = true;
                    break;
                }
                index++;
            }
            if (!closed)
                fail(`第 ${startLine} 行的正则字面量未闭合`);
            tokens.push({ kind: 'other', value: '/regex/', line: startLine });
            continue;
        }
        // Identifiers and keywords.
        if (IDENT_START.test(char)) {
            const start = index;
            index++;
            while (index < source.length && IDENT_PART.test(source[index] ?? ''))
                index++;
            tokens.push({ kind: 'id', value: source.slice(start, index), line });
            continue;
        }
        // Numbers (enough to keep token boundaries correct).
        if (isDigit(char) || (char === '.' && isDigit(source[index + 1] ?? ''))) {
            const start = index;
            index++;
            while (index < source.length && /[0-9a-fA-FxXoObBeE._n]/.test(source[index] ?? '')) {
                index++;
            }
            tokens.push({ kind: 'number', value: source.slice(start, index), line });
            continue;
        }
        // Punctuators.
        const three = source.slice(index, index + 3);
        const two = source.slice(index, index + 2);
        if (three === '...' || three === '===' || three === '!==' || three === '**=') {
            tokens.push({ kind: 'punct', value: three, line });
            index += 3;
            continue;
        }
        if (two === '?.' || two === '=>' || two === '++' || two === '--' || two === '**') {
            tokens.push({ kind: 'punct', value: two, line });
            index += 2;
            continue;
        }
        tokens.push({ kind: 'punct', value: char, line });
        index++;
    }
    return { tokens, error };
}
/**
 * Extract literal listener names from one source file.
 *
 * A dynamic first argument is recorded in `dynamic`; concatenations such as
 * `'a' + name` are dynamic too, because only a single literal is accepted.
 */
export function extractListeners(source, file) {
    const { tokens, error } = tokenize(source.replace(/^\uFEFF/, ''));
    const listeners = [];
    const dynamic = [];
    const seen = new Set();
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token === undefined || token.kind !== 'id' || token.value !== 'ctx')
            continue;
        const before = tokens[index - 1];
        if (before !== undefined && (before.value === '.' || before.value === '?.'))
            continue;
        let cursor = index + 1;
        const dot = tokens[cursor];
        if (dot === undefined || (dot.value !== '.' && dot.value !== '?.'))
            continue;
        cursor++;
        const method = tokens[cursor];
        if (method === undefined || method.kind !== 'id')
            continue;
        if (method.value !== 'on' && method.value !== 'waterfall')
            continue;
        const mode = method.value;
        cursor++;
        // TypeScript type arguments: `ctx.on<Payload>('event', …)`.
        if (tokens[cursor]?.value === '<') {
            let depth = 0;
            while (cursor < tokens.length) {
                const current = tokens[cursor];
                if (current?.value === '<')
                    depth++;
                else if (current?.value === '>') {
                    depth--;
                    if (depth === 0) {
                        cursor++;
                        break;
                    }
                }
                cursor++;
            }
        }
        const optionalCall = tokens[cursor];
        if (optionalCall !== undefined && optionalCall.value === '?.')
            cursor++;
        const open = tokens[cursor];
        if (open === undefined || open.value !== '(')
            continue;
        const argument = tokens[cursor + 1];
        const after = tokens[cursor + 2];
        if (argument === undefined)
            continue;
        // A literal followed by `+` is a concatenation, not a determined name.
        const concatenated = after !== undefined && after.value === '+';
        const literal = !concatenated &&
            (argument.kind === 'string' ||
                (argument.kind === 'template' && argument.dynamic !== true))
            ? argument.value
            : null;
        if (literal !== null && literal.trim() !== '') {
            const key = `${mode}\u0000${literal}\u0000${file}\u0000${token.line}`;
            if (!seen.has(key)) {
                seen.add(key);
                listeners.push({ name: literal.trim(), mode, file, line: token.line });
            }
        }
        else {
            const key = `${mode}\u0000${file}\u0000${token.line}`;
            if (!seen.has(key)) {
                seen.add(key);
                dynamic.push({ mode, file, line: token.line });
            }
        }
    }
    return { listeners, dynamic, parseError: error };
}
/** Collect relative import/require specifiers, ignoring strings in comments. */
export function collectRelativeImports(source) {
    const { tokens } = tokenize(source.replace(/^\uFEFF/, ''));
    const specifiers = new Set();
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token === undefined || token.kind !== 'string')
            continue;
        if (!token.value.startsWith('.'))
            continue;
        const previous = tokens[index - 1];
        const beforePrevious = tokens[index - 2];
        const isFrom = previous !== undefined && previous.kind === 'id' && previous.value === 'from';
        const isBareImport = previous !== undefined && previous.kind === 'id' && previous.value === 'import';
        const isCall = previous !== undefined &&
            previous.value === '(' &&
            beforePrevious !== undefined &&
            beforePrevious.kind === 'id' &&
            (beforePrevious.value === 'require' ||
                beforePrevious.value === 'import' ||
                beforePrevious.value === 'export');
        if (isFrom || isBareImport || isCall)
            specifiers.add(token.value);
    }
    return [...specifiers];
}
const PARSE_EXTENSIONS = [
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.mts',
    '.cts',
    '.jsx',
    '.tsx',
];
const DEFAULT_ENTRIES = [
    'index.js',
    'index.mjs',
    'index.cjs',
    'index.ts',
    'index.mts',
    'index.cts',
    'index.jsx',
    'index.tsx',
];
function isInside(root, target) {
    const relative = path.relative(root, target);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
/**
 * True when `target` is a real file whose real path stays inside `root`.
 *
 * Both sides go through `realpath`, so a symlink inside a package cannot make
 * the scanner read an arbitrary file outside the package (the scan is read-only
 * but still must not be a confused deputy).
 */
function isFileInside(root, target) {
    try {
        if (!fs.statSync(target).isFile())
            return false;
        const rootReal = fs.realpathSync(root);
        const targetReal = fs.realpathSync(target);
        return isInside(rootReal, targetReal);
    }
    catch {
        return false;
    }
}
/** Resolve one relative import to a real file, trying TS-for-JS renames. */
function resolveSpecifier(fromFile, specifier, packageDir) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    const candidates = [base];
    if (/\.(js|mjs|cjs)$/.test(specifier)) {
        const replaced = base.replace(/\.(js|mjs|cjs)$/, '');
        for (const extension of ['.ts', '.tsx', '.mts', '.cts']) {
            candidates.push(`${replaced}${extension}`);
        }
    }
    for (const extension of PARSE_EXTENSIONS)
        candidates.push(`${base}${extension}`);
    for (const extension of PARSE_EXTENSIONS) {
        candidates.push(path.join(base, `index${extension}`));
    }
    for (const candidate of candidates) {
        if (!PARSE_EXTENSIONS.includes(path.extname(candidate).toLowerCase()))
            continue;
        if (!isInside(packageDir, candidate))
            continue;
        if (!isFileInside(packageDir, candidate))
            continue;
        return path.resolve(candidate);
    }
    return null;
}
function collectExportTargets(value, output, depth = 0) {
    if (depth > 8)
        return;
    if (typeof value === 'string') {
        if (value.startsWith('./') && !value.includes('*') && !value.endsWith('.d.ts')) {
            output.push(value);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            collectExportTargets(item, output, depth + 1);
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const item of Object.values(value)) {
            collectExportTargets(item, output, depth + 1);
        }
    }
}
/**
 * The root export only.
 *
 * A package's `exports` map often also publishes `./client` (the browser half)
 * and `./locale/*.json`; scanning those would inspect a different runtime with
 * a different event vocabulary. The package root is the host entry this engine
 * is asked about.
 */
function rootExportTarget(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value))
        return value;
    if (value !== null && typeof value === 'object') {
        const record = value;
        if ('.' in record)
            return record['.'];
        const keys = Object.keys(record);
        // A bare condition object such as `{ import: './index.js' }`.
        if (keys.every((key) => !key.startsWith('.')))
            return record;
    }
    return undefined;
}
function collectEntrySpecifiers(manifest) {
    const specs = [];
    for (const key of ['main', 'module']) {
        const value = manifest[key];
        if (typeof value === 'string' && value.trim() !== '')
            specs.push(value);
    }
    if (manifest['exports'] !== undefined) {
        collectExportTargets(rootExportTarget(manifest['exports']), specs);
    }
    return [...new Set(specs.map((spec) => spec.trim()).filter((spec) => spec !== ''))];
}
function toPosix(value) {
    return value.split(path.sep).join('/');
}
/**
 * Scan one package directory. Never throws: read/parse failures land in
 * `errors` and the package becomes unknown rather than healthy.
 */
export function scanPackage(packageDir, packageName, versionSpec, options = {}) {
    const maxFiles = options.maxFiles ?? 48;
    const result = {
        package: packageName,
        version: versionSpec,
        dir: packageDir,
        events: [],
        dynamic: [],
        files: [],
        errors: [],
    };
    let manifest = {};
    try {
        const raw = fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') {
            throw new Error('package.json 不是对象');
        }
        manifest = parsed;
        if (typeof manifest['version'] === 'string' && manifest['version'].trim() !== '') {
            result.version = manifest['version'];
        }
    }
    catch (error) {
        result.errors.push(`无法读取 package.json：${error.message}`);
        return result;
    }
    const roots = [];
    for (const spec of collectEntrySpecifiers(manifest)) {
        const candidate = path.resolve(packageDir, spec);
        if (!isInside(packageDir, candidate))
            continue;
        const resolved = isFileInside(packageDir, candidate)
            ? candidate
            : resolveSpecifier(path.join(packageDir, 'package.json'), spec, packageDir);
        if (resolved !== null)
            roots.push(resolved);
    }
    if (roots.length === 0) {
        for (const entry of DEFAULT_ENTRIES) {
            const candidate = path.join(packageDir, entry);
            if (isFileInside(packageDir, candidate))
                roots.push(candidate);
        }
    }
    if (roots.length === 0) {
        result.errors.push('没有可读取的入口文件（main/module/exports 与 index.* 均不存在）');
        return result;
    }
    const queue = [...new Set(roots)];
    const visited = new Set();
    const dependencies = new Set();
    while (queue.length > 0 && visited.size < maxFiles) {
        const file = queue.shift();
        if (file === undefined || visited.has(file))
            continue;
        visited.add(file);
        let source;
        try {
            source = fs.readFileSync(file, 'utf8');
        }
        catch (error) {
            result.errors.push(`无法读取 ${toPosix(path.relative(packageDir, file))}：${error.message}`);
            continue;
        }
        const relative = toPosix(path.relative(packageDir, file));
        result.files.push(relative);
        const extracted = extractListeners(source, relative);
        result.events.push(...extracted.listeners);
        result.dynamic.push(...extracted.dynamic);
        if (extracted.parseError !== null) {
            result.errors.push(`${relative}：${extracted.parseError}`);
        }
        for (const specifier of collectRelativeImports(source)) {
            const resolved = resolveSpecifier(file, specifier, packageDir);
            if (resolved !== null && !visited.has(resolved))
                dependencies.add(resolved);
        }
    }
    if (visited.size >= maxFiles) {
        result.errors.push(`已达到单包解析上限（${maxFiles} 个文件），更深层的监听可能未被检查`);
    }
    for (const dependency of dependencies) {
        if (visited.size >= maxFiles)
            break;
        const file = dependency;
        if (visited.has(file))
            continue;
        visited.add(file);
        let source;
        try {
            source = fs.readFileSync(file, 'utf8');
        }
        catch (error) {
            result.errors.push(`无法读取 ${toPosix(path.relative(packageDir, file))}：${error.message}`);
            continue;
        }
        const relative = toPosix(path.relative(packageDir, file));
        result.files.push(relative);
        const extracted = extractListeners(source, relative);
        result.events.push(...extracted.listeners);
        result.dynamic.push(...extracted.dynamic);
        if (extracted.parseError !== null) {
            result.errors.push(`${relative}：${extracted.parseError}`);
        }
    }
    result.files = [...new Set(result.files)];
    return result;
}
