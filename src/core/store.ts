import fs from "node:fs"
import path from "node:path"
import { HOME_DIR, LOCK_FILE, LOCK_STALE_MS, LOCK_WAIT_MS, PROJECTS_FILE, TOKENS_FILE } from "./config.js"

export interface iTokenRecord {
	accessToken: string
	accessTokenCookie: string
	refreshToken: string
	refreshTokenCookie: string
	accessExp: number
	refreshExp: number
}

export interface iProjectRecord {
	domain: string
	baseUrl: string
	email?: string
	userId?: number
	userName?: string
	addedAt: string
}

type TokensFile = Record<string, iTokenRecord>
type ProjectsFile = Record<string, iProjectRecord>

function ensureHome(): void {
	fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 })
}

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T
	} catch {
		return fallback
	}
}

function writeJsonAtomic(file: string, data: unknown): void {
	ensureHome()
	const tmp = path.join(HOME_DIR, `.${path.basename(file)}.${process.pid}.tmp`)
	fs.writeFileSync(tmp, JSON.stringify(data, null, "\t"), { mode: 0o600 })
	fs.renameSync(tmp, file)
}

export function readTokens(domain: string): iTokenRecord | null {
	return readJson<TokensFile>(TOKENS_FILE, {})[domain] ?? null
}

export function writeTokens(domain: string, record: iTokenRecord | null): void {
	const all = readJson<TokensFile>(TOKENS_FILE, {})
	if (record) {
		all[domain] = record
	} else {
		delete all[domain]
	}
	writeJsonAtomic(TOKENS_FILE, all)
}

export function readProjects(): iProjectRecord[] {
	return Object.values(readJson<ProjectsFile>(PROJECTS_FILE, {}))
}

export function readProject(domain: string): iProjectRecord | null {
	return readJson<ProjectsFile>(PROJECTS_FILE, {})[domain] ?? null
}

export function writeProject(record: iProjectRecord): void {
	const all = readJson<ProjectsFile>(PROJECTS_FILE, {})
	all[record.domain] = record
	writeJsonAtomic(PROJECTS_FILE, all)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

//межпроцессный lock на обновление токенов: несколько сессий Claude Code = несколько процессов MCP над одним файлом
export async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
	ensureHome()
	const started = Date.now()
	for (;;) {
		try {
			const fd = fs.openSync(LOCK_FILE, "wx")
			fs.writeSync(fd, String(process.pid))
			fs.closeSync(fd)
			break
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			try {
				const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs
				if (age > LOCK_STALE_MS) {
					fs.unlinkSync(LOCK_FILE)
					continue
				}
			} catch { /* lock уже снят другим процессом */ }
			if (Date.now() - started > LOCK_WAIT_MS) throw new Error("Не удалось получить lock на обновление токенов")
			await sleep(100)
		}
	}
	try {
		return await fn()
	} finally {
		try { fs.unlinkSync(LOCK_FILE) } catch { /* уже снят */ }
	}
}
