import fs from "node:fs/promises"
import { z } from "zod"
import { getProject } from "../core/auth.ts"
import { buildCsv } from "../core/csv.ts"
import { EXPORT_PAGE_SIZE } from "../core/config.ts"
import { ValidationError } from "../core/errors.ts"
import { writeTextFile } from "../core/files.ts"
import { type Wire, api, apiRaw, readImportSse, wireSet } from "../core/http.ts"
import { type iListResponse, listQuery, listResult } from "../core/lists.ts"
import { type FieldType, getFields, getNode, getNodeParams } from "../core/schema.ts"
import { defineTool, zDomain, zFilters, zNode, zPage, zPath, zPerPage, zSorter } from "./define.ts"

//колонки CSV подборок — ровно те, что читает nodeGeneratorAdminController.importFile
const CSV_COLUMNS: [string, keyof iGenerated][] = [
	["Заголовок", "title"], ["Заголовок в SEO блоке", "menutitle"], ["Мета заголовок", "meta_title"], ["Мета описание", "meta_description"],
	["Отключен от генератора", "blocked"], ["Выводить в seo блок", "seo_block"], ["Опубликован", "public"], ["Код элемента", "code"],
]
const CSV_FILTER_SLOTS = 6

interface iGenerated {
	id: number
	node: number
	pub_date: string | null
	title: string
	menutitle: string
	code: string
	blocked: boolean
	seo_block: boolean
	public: boolean
	meta_title: string
	meta_description: string
	filters: Record<string, unknown>
	paramsDisplay: Record<string, unknown>
}

const ALLOWED = ["id", "pub_date", "title", "menutitle", "code", "public", "blocked", "seo_block", "meta_title", "meta_description"]
//типы полей элементов, по которым бэк строит подборки (nodeGeneratorAdminController.importFile)
const FILTER_FIELD_TYPES: FieldType[] = ["text", "textarea", "select", "multiselect", "multisel2area", "multiselectExtTable", "reference"]
const TEXT_KEYS = ["title", "menutitle", "code", "meta_title", "meta_description"] as const
const BOOL_KEYS = ["public", "blocked", "seo_block"] as const

//filters из БД → плоский вид {code: value}; reference-форма {code:[{title,value:[v]}]} → {"code__title": v}
function flatFilters(filters: Record<string, unknown>): Record<string, string | number> {
	const out: Record<string, string | number> = {}
	for (const [code, value] of Object.entries(filters ?? {})) {
		if (Array.isArray(value)) {
			for (const entry of value) {
				if (entry && typeof entry === "object" && "title" in entry) {
					const e = entry as { title: string, value: unknown }
					const v = Array.isArray(e.value) ? e.value[0] : e.value
					if (v !== undefined) out[`${code}__${e.title}`] = v as string | number
				}
			}
		} else if (typeof value === "string" || typeof value === "number") {
			out[code] = value
		}
	}
	return out
}

function view(g: iGenerated, nodeCode: string, baseUrl: string): Record<string, unknown> {
	return {
		id: g.id,
		url: `${baseUrl}/${nodeCode}/${g.code}/`,
		code: g.code,
		title: g.title,
		menutitle: g.menutitle,
		public: g.public,
		blocked: g.blocked,
		seo_block: g.seo_block,
		meta_title: g.meta_title,
		meta_description: g.meta_description,
		filters: flatFilters(g.filters),
		params: g.paramsDisplay ?? {},
		...(g.public ? {} : { note: "Подборка не опубликована — страница отдаст 404" }),
	}
}

async function fetchOne(domain: string, node: number, id: number): Promise<iGenerated> {
	return api<iGenerated>(domain, { path: `/admin/node/${node}/generator/${id}` })
}

export const generatedListTool = defineTool({
	name: "generated_list",
	description: "Подборки (виртуальные подразделы) раздела: SEO-страницы с фильтром по полям элементов. url = /<код раздела>/<код подборки>/.",
	input: { domain: zDomain, node: zNode, page: zPage, perPage: zPerPage, filters: zFilters, sorter: zSorter },
	readOnly: true,
	handler: async ({ domain, node, page, perPage, filters, sorter }) => {
		const n = await getNode(domain, node)
		const query = listQuery({ page, perPage, filters, sorter }, ALLOWED)
		query.all_fields = ""
		const data = await api<iListResponse<iGenerated>>(domain, { path: `/admin/node/${node}/generator`, query })
		return listResult(data, page, data.items.map(g => view(g, n.code, getProject(domain).baseUrl)))
	},
})

export const generatedGetTool = defineTool({
	name: "generated_get",
	description: "Одна подборка раздела: поля, filters (условия по полям элементов), params (переопределения параметров раздела).",
	input: { domain: zDomain, node: zNode, id: z.number().int().positive() },
	readOnly: true,
	handler: async ({ domain, node, id }) => view(await fetchOne(domain, node, id), (await getNode(domain, node)).code, getProject(domain).baseUrl),
})

export const generatedSaveTool = defineTool({
	name: "generated_save",
	description: "Создать (без id) или изменить подборку. Передавай только изменяемое. filters — {код_поля_элементов: значение} (поля text/textarea/select/multiselect/reference; для select — id; для reference ключ \"код__Название\"); null удаляет условие. params — {код_параметра_раздела: строка}, null удаляет.",
	input: {
		domain: zDomain,
		node: zNode,
		id: z.number().int().positive().optional(),
		fields: z.object({
			title: z.string().optional(),
			menutitle: z.string().optional(),
			code: z.string().optional().describe("код в URL (a-z0-9_-), уникален в разделе"),
			public: z.boolean().optional(),
			blocked: z.boolean().optional().describe("защита от перегенерации"),
			seo_block: z.boolean().optional().describe("выводить в SEO-блоке раздела"),
			meta_title: z.string().optional(),
			meta_description: z.string().optional(),
		}).optional(),
		filters: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
		params: z.record(z.union([z.string(), z.null()])).optional(),
	},
	handler: async ({ domain, node, id, fields, filters, params }) => {
		const n = await getNode(domain, node)
		const current = id ? await fetchOne(domain, node, id) : null
		if (!current && !fields?.title) throw new ValidationError(["при создании обязателен fields.title"])
		if (fields?.code !== undefined && fields.code !== "" && !/^[a-z0-9_-]{1,255}$/.test(fields.code)) throw new ValidationError(["code: только a-z, 0-9, _ и -"])

		const filterable = (await getFields(domain, n.type)).filter(f => FILTER_FIELD_TYPES.includes(f.field_type))
		const elementCodes = filterable.map(f => f.code)
		const paramCodes = ((await getNodeParams(domain, node)).node_param_fields ?? []).map(f => f.code)
		const mergedFilters = { ...flatFilters(current?.filters ?? {}) }
		for (const [key, value] of Object.entries(filters ?? {})) {
			const base = key.split("__")[0]
			if (!elementCodes.includes(base)) throw new ValidationError([`filters: поле "${base}" не найдено или не подходит для подборки; доступны: ${elementCodes.join(", ")}`])
			if (value === null) delete mergedFilters[key]
			else mergedFilters[key] = value
		}
		if (Object.keys(mergedFilters).length > 6) throw new ValidationError(["подборка поддерживает не более 6 условий"])
		const mergedParams: Record<string, unknown> = { ...(current?.paramsDisplay ?? {}) }
		for (const [key, value] of Object.entries(params ?? {})) {
			if (!paramCodes.includes(key)) throw new ValidationError([`params: параметр "${key}" не найден; доступны: ${paramCodes.join(", ")}`])
			if (value === null) delete mergedParams[key]
			else mergedParams[key] = value
		}

		const wire: Wire = new Map()
		if (id) wireSet(wire, "id", String(id))
		for (const key of TEXT_KEYS) wireSet(wire, key, String(fields?.[key] ?? current?.[key] ?? ""))
		for (const key of BOOL_KEYS) wireSet(wire, key, (fields?.[key] ?? current?.[key] ?? (key === "public")) ? "true" : "false")
		Object.entries(mergedFilters).forEach(([key, value], i) => {
			wireSet(wire, `field_${i + 1}_name`, key)
			wireSet(wire, `field_${i + 1}_value`, String(value))
		})
		for (const [key, value] of Object.entries(mergedParams)) wireSet(wire, `nodeParams[${key}]`, String(value ?? ""))
		const saved = await api<{ id: number }>(domain, { method: "POST", path: `/admin/node/${node}/generator/edit`, body: wire })
		return view(await fetchOne(domain, node, saved.id), n.code, getProject(domain).baseUrl)
	},
})

export const generatedCopyTool = defineTool({
	name: "generated_copy",
	description: "Скопировать подборку (копия не опубликована, code с постфиксом -copyN).",
	input: { domain: zDomain, node: zNode, id: z.number().int().positive() },
	handler: async ({ domain, node, id }) => {
		const saved = await api<{ id: number }>(domain, { method: "POST", path: `/admin/node/${node}/generator/copy`, body: new Map([["id", [String(id)]]]) })
		return view(await fetchOne(domain, node, saved.id), (await getNode(domain, node)).code, getProject(domain).baseUrl)
	},
})

export const generatedDeleteTool = defineTool({
	name: "generated_delete",
	description: "Удалить подборки (необратимо).",
	input: { domain: zDomain, node: zNode, ids: z.array(z.number().int().positive()).min(1) },
	destructive: true,
	handler: async ({ domain, node, ids }) => {
		await api(domain, { method: "POST", path: `/admin/node/${node}/generator/delete`, body: new Map([["ids[]", ids.map(String)]]) })
		return { deleted: ids }
	},
})

export const generatedExportCsvTool = defineTool({
	name: "generated_export_csv",
	description: "Выгрузить подборки раздела в CSV (формат совместим с generated_import_csv; фильтры сужают выборку). Возвращает описание столбцов.",
	input: { domain: zDomain, node: zNode, path: zPath.describe("куда сохранить .csv"), filters: zFilters, sorter: zSorter },
	readOnly: true,
	handler: async ({ domain, node, path, filters, sorter }) => {
		const n = await getNode(domain, node)
		const titleByCode = new Map((await getFields(domain, n.type)).map(f => [f.code, f.title]))
		const paramFields = ((await getNodeParams(domain, node)).node_param_fields ?? []).filter(f => f.field_type === "text" || f.field_type === "textarea")
		const all: iGenerated[] = []
		for (let page = 1; ; page++) {
			const query = listQuery({ page, perPage: EXPORT_PAGE_SIZE, filters, sorter }, ALLOWED, "id asc")
			query.all_fields = ""
			const data = await api<iListResponse<iGenerated>>(domain, { path: `/admin/node/${node}/generator`, query })
			all.push(...data.items)
			if (all.length >= data.totalItems || !data.items.length) break
		}
		const header = ["id", ...CSV_COLUMNS.map(([h]) => h)]
		for (let i = 1; i <= CSV_FILTER_SLOTS; i++) header.push(`Поле элементов ${i}`, `Значение поля ${i}`)
		header.push(...paramFields.map(f => f.title))
		const rows = all.map(g => {
			const row = [String(g.id), ...CSV_COLUMNS.map(([, key]) => typeof g[key] === "boolean" ? (g[key] ? "Да" : "Нет") : String(g[key] ?? ""))]
			const pairs = Object.entries(flatFilters(g.filters)).slice(0, CSV_FILTER_SLOTS)
			for (let i = 0; i < CSV_FILTER_SLOTS; i++) {
				const [key, value] = pairs[i] ?? ["", ""]
				const [code, sub] = key.split("__")
				row.push(key ? `${titleByCode.get(code) ?? code}${sub ? `__${sub}` : ""}` : "", String(value))
			}
			row.push(...paramFields.map(f => String(g.paramsDisplay?.[f.code] ?? "")))
			return row
		})
		const saved = await writeTextFile(path, buildCsv(header, rows))
		return {
			path: saved,
			rows: rows.length,
			delimiter: ";",
			columns: [
				{ header: "id", format: "id подборки; пусто — создать" },
				...CSV_COLUMNS.map(([h, key]) => ({ header: h, format: ["blocked", "seo_block", "public"].includes(key) ? "«Да» / «Нет»" : "текст" })),
				{ header: "Поле элементов N / Значение поля N", format: "название поля элементов (из schema) и значение условия: для select — id, для reference — «Название__подзаголовок»; N = 1..6" },
				...paramFields.map(f => ({ header: f.title, format: "переопределение параметра раздела (текст)" })),
			],
			import_rules: "Столбцы, которых нет в шапке, не меняются. Пустое «Поле элементов N» пропускается.",
		}
	},
})

export const generatedImportCsvTool = defineTool({
	name: "generated_import_csv",
	description: "Загрузить CSV подборок: первый столбец id (пусто — создать); заголовки: Заголовок, Заголовок в SEO блоке, Мета заголовок, Мета описание, Отключен от генератора, Выводить в seo блок, Опубликован (Да/Нет), Код элемента, «Поле элементов N» + «Значение поля N» (N=1..6; поле — по названию из schema, только text/textarea/select/multiselect/reference; select — название значения), названия текстовых параметров раздела. Отсутствующие столбцы не затираются.",
	input: { domain: zDomain, node: zNode, path: zPath.describe("путь к .csv") },
	handler: async ({ domain, node, path }) => {
		const buffer = await fs.readFile(path)
		const wire: Wire = new Map([["file", [{ blob: new Blob([buffer], { type: "text/csv" }), name: "generated.csv" }]]])
		const response = await apiRaw(domain, { method: "POST", path: `/admin/node/${node}/generator/import`, body: wire })
		return readImportSse(response)
	},
})

export const generatedTools = [generatedListTool, generatedGetTool, generatedSaveTool, generatedCopyTool, generatedDeleteTool, generatedExportCsvTool, generatedImportCsvTool]
