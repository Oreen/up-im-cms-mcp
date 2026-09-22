import http from "node:http"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { LOGIN_PORT_DEFAULT, LOGIN_SERVER_IDLE_MS, LOGIN_WAIT_MS } from "./config.js"
import { loginWithPassword, resolveBaseUrl } from "./auth.js"
import { iProjectRecord, readProject } from "./store.js"

interface iPending {
	domain: string
	baseUrl: string
	nonce: string
	resolvers: Array<(project: iProjectRecord) => void>
	result?: iProjectRecord
}

let server: http.Server | null = null
let serverPort = 0
let idleTimer: NodeJS.Timeout | null = null
const pending = new Map<string, iPending>()

function escapeHtml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function page(body: string): string {
	return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>up-im MCP — авторизация</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{background:#1e293b;border-radius:16px;padding:40px;width:100%;max-width:400px}h1{font-size:22px;margin-bottom:6px;text-align:center}.sub{color:#94a3b8;font-size:14px;text-align:center;margin-bottom:28px;word-break:break-all}
label{display:block;font-size:13px;color:#94a3b8;margin-bottom:6px}input{width:100%;padding:12px 16px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0;font-size:15px;outline:none}input:focus{border-color:#3b82f6}
.field{margin-bottom:20px}button{width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}button:hover{background:#2563eb}
.error{background:#7f1d1d;color:#fca5a5;padding:12px 16px;border-radius:8px;font-size:13px;margin-bottom:20px;text-align:center}.ok{color:#86efac;text-align:center;font-size:15px}</style></head><body><div class="card">${body}</div></body></html>`
}

function formHtml(item: iPending, error?: string): string {
	return page(`<h1>up-im MCP</h1><p class="sub">Вход в админку ${escapeHtml(item.baseUrl)}</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/login"><input type="hidden" name="nonce" value="${item.nonce}">
<div class="field"><label>Email</label><input type="email" name="email" required autocomplete="username" autofocus></div>
<div class="field"><label>Пароль</label><input type="password" name="password" required autocomplete="current-password"></div>
<button type="submit">Войти</button></form>`)
}

function readBody(req: http.IncomingMessage): Promise<URLSearchParams> {
	return new Promise((resolve, reject) => {
		let data = ""
		req.on("data", chunk => { data += chunk; if (data.length > 65536) req.destroy() })
		req.on("end", () => resolve(new URLSearchParams(data)))
		req.on("error", reject)
	})
}

function touchIdle(): void {
	if (idleTimer) clearTimeout(idleTimer)
	idleTimer = setTimeout(() => stopLoginServer(), LOGIN_SERVER_IDLE_MS)
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	touchIdle()
	const url = new URL(req.url ?? "/", "http://localhost")
	const send = (status: number, html: string) => {
		res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" })
		res.end(html)
	}
	if (req.method === "GET" && url.pathname === "/login") {
		const item = pending.get(url.searchParams.get("nonce") ?? "")
		if (!item) return send(404, page("<h1>Ссылка устарела</h1><p class=\"sub\">Вызови login ещё раз</p>"))
		return send(200, formHtml(item))
	}
	if (req.method === "POST" && url.pathname === "/login") {
		const body = await readBody(req)
		const item = pending.get(body.get("nonce") ?? "")
		if (!item) return send(400, page("<h1>Форма устарела</h1><p class=\"sub\">Вызови login ещё раз</p>"))
		try {
			const project = await loginWithPassword(item.domain, item.baseUrl, body.get("email") ?? "", body.get("password") ?? "")
			item.result = project
			pending.delete(item.nonce)
			for (const resolve of item.resolvers) resolve(project)
			return send(200, page(`<h1>Готово</h1><p class="ok">${escapeHtml(project.userName || project.email || "")} авторизован для ${escapeHtml(item.domain)}.<br>Вкладку можно закрыть.</p>`))
		} catch (error) {
			return send(400, formHtml(item, (error as Error).message))
		}
	}
	send(404, page("<h1>404</h1>"))
}

function listen(port: number, attempt = 0): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = http.createServer((req, res) => { handle(req, res).catch(() => res.end()) })
		srv.once("error", (error: NodeJS.ErrnoException) => {
			//порт занят (другой экземпляр MCP) — берём следующий, как next dev
			if (error.code === "EADDRINUSE" && attempt < 20) return resolve(listen(port + 1, attempt + 1))
			reject(error)
		})
		srv.listen(port, "127.0.0.1", () => { server = srv; resolve(port) })
	})
}

async function ensureServer(): Promise<number> {
	if (server) return serverPort
	serverPort = await listen(Number(process.env.UPIM_MCP_LOGIN_PORT) || LOGIN_PORT_DEFAULT)
	touchIdle()
	return serverPort
}

export function stopLoginServer(): void {
	server?.close()
	server = null
	if (idleTimer) clearTimeout(idleTimer)
	idleTimer = null
}

function openBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? ["open", url]
		: process.platform === "win32" ? ["cmd", "/c", "start", "", url]
		: ["xdg-open", url]
	try {
		spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).on("error", () => { /* нет GUI */ }).unref()
	} catch { /* нет GUI */ }
}

export interface iLoginStart {
	status: "authorized" | "waiting"
	url?: string
	project?: iProjectRecord
}

//запускает локальную страницу логина, открывает браузер и ждёт ввода до LOGIN_WAIT_MS
export async function startLogin(domain: string, baseUrlOverride?: string): Promise<iLoginStart> {
	const baseUrl = resolveBaseUrl(domain, baseUrlOverride ?? readProject(domain)?.baseUrl)
	let item = [...pending.values()].find(it => it.domain === domain)
	const port = await ensureServer()
	if (!item) {
		item = { domain, baseUrl, nonce: crypto.randomBytes(16).toString("hex"), resolvers: [] }
		pending.set(item.nonce, item)
	}
	const url = `http://127.0.0.1:${port}/login?nonce=${item.nonce}`
	openBrowser(url)
	const project = await new Promise<iProjectRecord | null>(resolve => {
		const timer = setTimeout(() => resolve(null), LOGIN_WAIT_MS)
		item!.resolvers.push(p => { clearTimeout(timer); resolve(p) })
	})
	if (project) return { status: "authorized", project }
	return { status: "waiting", url }
}
