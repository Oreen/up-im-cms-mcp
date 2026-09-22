import { baseHeaders, getAuthHeaders, getProject } from "./auth.js"
import { ApiError, AuthRequiredError } from "./errors.js"

export type QueryValue = string | number | boolean | undefined | null | QueryValue[] | { [key: string]: QueryValue }

//qs-совместимая сериализация: {filters:{title:["a"]}} → filters[title][]=a
function appendQuery(params: URLSearchParams, key: string, value: QueryValue): void {
	if (value === undefined || value === null) return
	if (Array.isArray(value)) {
		for (const v of value) appendQuery(params, `${key}[]`, v)
		return
	}
	if (typeof value === "object") {
		for (const [k, v] of Object.entries(value)) appendQuery(params, `${key}[${k}]`, v)
		return
	}
	params.append(key, String(value))
}

export function buildQuery(query?: Record<string, QueryValue>): string {
	if (!query) return ""
	const params = new URLSearchParams()
	for (const [key, value] of Object.entries(query)) appendQuery(params, key, value)
	const str = params.toString()
	return str ? `?${str}` : ""
}

export type WirePart = string | { blob: Blob, name: string }
//ключи — буквальные имена multipart-полей (code, code[], code_files); массив = повтор ключа
export type Wire = Map<string, WirePart[]>

export function wireSet(wire: Wire, key: string, ...parts: WirePart[]): void {
	wire.set(key, parts)
}

export function wireToFormData(wire: Wire): FormData {
	const form = new FormData()
	for (const [key, parts] of wire) {
		for (const part of parts) {
			if (typeof part === "string") {
				form.append(key, part)
			} else {
				form.append(key, part.blob, part.name)
			}
		}
	}
	return form
}

interface iRequestOptions {
	method?: "GET" | "POST"
	path: string
	query?: Record<string, QueryValue>
	body?: Wire
	auth?: boolean
}

async function doFetch(domain: string, options: iRequestOptions, forceRefresh: boolean): Promise<Response> {
	const project = getProject(domain)
	const headers: Record<string, string> = baseHeaders(project.baseUrl)
	if (options.auth !== false) Object.assign(headers, await getAuthHeaders(domain, forceRefresh))
	return fetch(`${project.baseUrl}/api${options.path}${buildQuery(options.query)}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body ? wireToFormData(options.body) : undefined,
	})
}

//запрос к бэку с автоматическим refresh при 401
export async function apiRaw(domain: string, options: iRequestOptions): Promise<Response> {
	let response = await doFetch(domain, options, false)
	if (response.status === 401 && options.auth !== false) {
		response = await doFetch(domain, options, true)
		if (response.status === 401) throw new AuthRequiredError(domain, "сервер отклонил токены")
	}
	if (!response.ok) {
		let message = `HTTP ${response.status}`
		try {
			const body = await response.json() as { message?: string }
			if (body.message) message = body.message
		} catch { /* не JSON */ }
		throw new ApiError(response.status, message)
	}
	return response
}

export async function api<T>(domain: string, options: iRequestOptions): Promise<T> {
	const response = await apiRaw(domain, options)
	return await response.json() as T
}

//Server-Sent Events импорта: {progress} … {done,errors,countTotal,countUpdate} | {error}
export interface iImportResult {
	countTotal: number
	countUpdate: number
	errors: string[]
}

export async function readImportSse(response: Response): Promise<iImportResult> {
	const text = await response.text()
	let result: iImportResult | null = null
	for (const chunk of text.split("\n\n")) {
		const line = chunk.trim()
		if (!line.startsWith("data:")) continue
		const event = JSON.parse(line.slice(5).trim()) as { error?: string, done?: boolean } & Partial<iImportResult>
		if (event.error) throw new ApiError(400, event.error)
		if (event.done) result = { countTotal: event.countTotal ?? 0, countUpdate: event.countUpdate ?? 0, errors: event.errors ?? [] }
	}
	if (!result) throw new ApiError(500, "Импорт не вернул результат")
	return result
}
