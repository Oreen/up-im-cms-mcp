import fs from "node:fs"
import os from "node:os"
import path from "node:path"

//версия пакета — единственный источник: package.json (npm version бампает её и ставит git-тег)
export const VERSION: string = (() => {
	try {
		return (JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version
	} catch {
		return "0.0.0"
	}
})()

export const LOGIN_PORT_DEFAULT = 4870
export const REST_PORT_DEFAULT = 4871
export const LOGIN_WAIT_MS = Number(process.env.UPIM_MCP_LOGIN_WAIT_MS) || 90_000
export const LOGIN_SERVER_IDLE_MS = 10 * 60_000
export const ACCESS_REFRESH_AHEAD_MS = 60_000
export const SCHEMA_CACHE_MS = 5 * 60_000
export const LOCK_STALE_MS = 30_000
export const LOCK_WAIT_MS = 15_000
export const ITEMS_PAGE_SIZE_DEFAULT = 50
export const EXPORT_PAGE_SIZE = 1000

function resolveHomeDir(): string {
	if (process.env.UPIM_MCP_HOME) return process.env.UPIM_MCP_HOME
	if (process.platform === "win32") {
		return path.join(process.env.APPDATA ?? os.homedir(), "up-im-mcp")
	}
	return path.join(os.homedir(), ".config", "up-im-mcp")
}

export const HOME_DIR = resolveHomeDir()
export const TOKENS_FILE = path.join(HOME_DIR, "tokens.json")
export const PROJECTS_FILE = path.join(HOME_DIR, "projects.json")
export const LOCK_FILE = path.join(HOME_DIR, "refresh.lock")
