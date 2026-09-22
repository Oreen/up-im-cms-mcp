import { z } from "zod"
import { authStatus } from "../core/auth.ts"
import { startLogin } from "../core/loginServer.ts"
import { readProjects } from "../core/store.ts"
import { defineTool, zDomain } from "./define.ts"

export const projectsTool = defineTool({
	name: "projects",
	description: "Список подключённых сайтов (доменов) и статус авторизации по каждому. Вызывай первым, если не знаешь домен.",
	input: {},
	readOnly: true,
	handler: async () => readProjects().map(p => ({
		domain: p.domain,
		baseUrl: p.baseUrl,
		user: p.userName || p.email,
		auth: authStatus(p.domain),
	})),
})

export const loginTool = defineTool({
	name: "login",
	description: "Авторизация на сайте: открывает в браузере локальную страницу входа в админку. Ждёт до 90 с; если вернулся status=waiting — попроси пользователя ввести логин/пароль по url и вызови login снова.",
	input: {
		domain: zDomain,
		baseUrl: z.string().optional().describe("URL API, если отличается от https://<domain> (напр. http://127.0.0.1:5000 для локального стенда)"),
		force: z.boolean().optional().describe("true — перелогиниться, даже если авторизация уже есть"),
	},
	handler: async ({ domain, baseUrl, force }) => {
		if (!force && authStatus(domain) === "ok") {
			const project = readProjects().find(p => p.domain === domain)
			return { status: "authorized", domain, user: project?.userName || project?.email, note: "уже авторизован; force=true для повторного входа" }
		}
		const result = await startLogin(domain, baseUrl)
		if (result.status === "authorized") {
			return { status: "authorized", domain, user: result.project?.userName || result.project?.email }
		}
		return { status: "waiting", url: result.url, hint: "Открой url в браузере, войди и вызови login ещё раз" }
	},
})
