import fs from "node:fs";
import path from "node:path";
import { HOME_DIR, LOCK_FILE, LOCK_STALE_MS, LOCK_WAIT_MS, PROJECTS_FILE, TOKENS_FILE } from "./config.js";
function ensureHome() {
    fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
}
function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return fallback;
    }
}
function writeJsonAtomic(file, data) {
    ensureHome();
    const tmp = path.join(HOME_DIR, `.${path.basename(file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, "\t"), { mode: 0o600 });
    fs.renameSync(tmp, file);
}
export function readTokens(domain) {
    return readJson(TOKENS_FILE, {})[domain] ?? null;
}
export function writeTokens(domain, record) {
    const all = readJson(TOKENS_FILE, {});
    if (record) {
        all[domain] = record;
    }
    else {
        delete all[domain];
    }
    writeJsonAtomic(TOKENS_FILE, all);
}
export function readProjects() {
    return Object.values(readJson(PROJECTS_FILE, {}));
}
export function readProject(domain) {
    return readJson(PROJECTS_FILE, {})[domain] ?? null;
}
export function writeProject(record) {
    const all = readJson(PROJECTS_FILE, {});
    all[record.domain] = record;
    writeJsonAtomic(PROJECTS_FILE, all);
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
//межпроцессный lock на обновление токенов: несколько сессий Claude Code = несколько процессов MCP над одним файлом
export async function withRefreshLock(fn) {
    ensureHome();
    const started = Date.now();
    for (;;) {
        try {
            const fd = fs.openSync(LOCK_FILE, "wx");
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            break;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            try {
                const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
                if (age > LOCK_STALE_MS) {
                    fs.unlinkSync(LOCK_FILE);
                    continue;
                }
            }
            catch { /* lock уже снят другим процессом */ }
            if (Date.now() - started > LOCK_WAIT_MS)
                throw new Error("Не удалось получить lock на обновление токенов");
            await sleep(100);
        }
    }
    try {
        return await fn();
    }
    finally {
        try {
            fs.unlinkSync(LOCK_FILE);
        }
        catch { /* уже снят */ }
    }
}
