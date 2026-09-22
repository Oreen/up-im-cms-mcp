import fs from "node:fs/promises"
import { z } from "zod"
import { getProject } from "../core/auth.ts"
import { EXPORT_PAGE_SIZE } from "../core/config.ts"
import { type AgentPatch, type DisplayItem, agentToWire, checkRequired, displayToAgent, displayToWire, hasInlineMedia, isFileType, wireKeysFor } from "../core/convert.ts"
import { buildItemsCsv, csvColumns, prepareCsvForImport } from "../core/csv.ts"
import { ValidationError } from "../core/errors.ts"
import { writeTextFile } from "../core/files.ts"
import { type Wire, api, apiRaw, readImportSse, wireSet } from "../core/http.ts"
import { type iListResponse, listQuery, listResult } from "../core/lists.ts"
import { getFields, getNode, type iField } from "../core/schema.ts"
import { defineTool, zDomain, zFilters, zNode, zPage, zPath, zPerPage, zSorter } from "./define.ts"

interface iItemContext {
	nodeType: string
	nodeCode: string
	fields: iField[]
	baseUrl: string
}

async function itemContext(domain: string, node: number): Promise<iItemContext> {
	const n = await getNode(domain, node)
	return { nodeType: n.type, nodeCode: n.code, fields: await getFields(domain, n.type), baseUrl: getProject(domain).baseUrl }
}

async function fetchItem(domain: string, node: number, id: number): Promise<DisplayItem> {
	return api<DisplayItem>(domain, { path: `/admin/node/${node}/content/${id}` })
}

//read-merge-write: база из текущего состояния, поверх — только изменённые поля
export function mergeWire(base: Wire, patch: Wire, patchedFields: iField[]): Wire {
	const merged: Wire = new Map(base)
	for (const field of patchedFields) for (const key of wireKeysFor(field)) merged.delete(key)
	for (const [key, parts] of patch) merged.set(key, parts)
	return merged
}

function patchedFields(patch: AgentPatch, fields: iField[]): iField[] {
	return fields.filter(f => f.code in patch)
}

//второй проход для textarea с base64-медиа, оставшимися после создания (см. hasInlineMedia)
async function flushInlineMedia(domain: string, node: number, id: number, ctx: iItemContext): Promise<void> {
	const current = await fetchItem(domain, node, id)
	for (const field of ctx.fields) {
		if (field.field_type !== "textarea" || !hasInlineMedia(current[field.code])) continue
		const wire: Wire = new Map([[field.code, [current[field.code] as string]], ["id", [String(id)]]])
		await api(domain, { method: "POST", path: `/admin/node/${node}/content/edit_one_field`, body: wire })
	}
}

async function itemView(domain: string, node: number, id: number, ctx: iItemContext): Promise<Record<string, unknown>> {
	await flushInlineMedia(domain, node, id, ctx)
	const view = displayToAgent(await fetchItem(domain, node, id), ctx.fields, ctx.baseUrl)
	if (view.url && view.public === false) view.note = "Элемент не опубликован — страница на сайте отдаст 404"
	return view
}

const DEFAULT_LIST_FIELDS = ["title", "code", "public"]

export const itemsTool = defineTool({
	name: "items",
	description: "Список элементов раздела с фильтрами и пагинацией. По умолчанию отдаёт id, url, title, code, public — остальные поля запрашивай через fields (или [\"*\"]).",
	input: { domain: zDomain, node: zNode, page: zPage, perPage: zPerPage, filters: zFilters, sorter: zSorter, fields: z.array(z.string()).optional().describe("коды полей в выдаче; [\"*\"] — все") },
	readOnly: true,
	handler: async ({ domain, node, page, perPage, filters, sorter, fields }) => {
		const ctx = await itemContext(domain, node)
		const codes = ctx.fields.map(f => f.code)
		const query = listQuery({ page, perPage, filters, sorter }, ["id", "pub_date", ...codes])
		query.all_fields = ""
		const data = await api<iListResponse<DisplayItem>>(domain, { path: `/admin/node/${node}/content`, query })
		const wanted = fields?.includes("*") ? codes : (fields ?? DEFAULT_LIST_FIELDS)
		const unknown = wanted.filter(c => !codes.includes(c))
		if (unknown.length) throw new ValidationError([`нет полей: ${unknown.join(", ")}; доступны: ${codes.join(", ")}`])
		const items = data.items.map(item => {
			const full = displayToAgent(item, ctx.fields, ctx.baseUrl)
			const slim: Record<string, unknown> = { id: full.id }
			if (full.url) slim.url = full.url
			for (const code of wanted) slim[code] = full[code]
			return slim
		})
		return listResult(data, page, items)
	},
})

export const itemTool = defineTool({
	name: "item",
	description: "Один элемент раздела со всеми полями и url страницы на сайте.",
	input: { domain: zDomain, node: zNode, id: z.number().int().positive() },
	readOnly: true,
	handler: async ({ domain, node, id }) => itemView(domain, node, id, await itemContext(domain, node)),
})

export const itemSaveTool = defineTool({
	name: "item_save",
	description: "Создать (без id) или изменить элемент. Передавай только изменяемые поля — остальные сохраняются как есть (read-merge-write). Формат значений — schema(). Возвращает элемент с url для проверки на сайте.",
	input: { domain: zDomain, node: zNode, id: z.number().int().positive().optional(), fields: z.record(z.unknown()).describe("{код_поля: значение}") },
	handler: async ({ domain, node, id, fields }) => {
		const ctx = await itemContext(domain, node)
		const current = id ? await fetchItem(domain, node, id) : undefined
		const patch = await agentToWire(fields, ctx.fields, { domain, optionsKind: "fields", current })
		const wire = current ? mergeWire(displayToWire(current, ctx.fields), patch, patchedFields(fields, ctx.fields)) : patch
		checkRequired(ctx.fields, wire)
		if (id) wireSet(wire, "id", String(id))
		const saved = await api<{ id: number }>(domain, { method: "POST", path: `/admin/node/${node}/content/edit`, body: wire })
		return itemView(domain, node, saved.id, ctx)
	},
})

export const itemSetFieldTool = defineTool({
	name: "item_set_field",
	description: "Изменить одно поле элемента (отдельный запрос без перезаписи остальных). Формат значения — schema().",
	input: { domain: zDomain, node: zNode, id: z.number().int().positive(), field: z.string().describe("код поля"), value: z.unknown() },
	handler: async ({ domain, node, id, field, value }) => {
		const ctx = await itemContext(domain, node)
		const f = ctx.fields.find(x => x.code === field)
		if (!f) throw new ValidationError([`поле "${field}" не найдено; доступны: ${ctx.fields.map(x => x.code).join(", ")}`])
		const current = isFileType(f.field_type) ? await fetchItem(domain, node, id) : undefined
		const wire = await agentToWire({ [field]: value }, ctx.fields, { domain, optionsKind: "fields", current })
		if (f.required) checkRequired([f], wire)
		wireSet(wire, "id", String(id))
		await api(domain, { method: "POST", path: `/admin/node/${node}/content/edit_one_field`, body: wire })
		return itemView(domain, node, id, ctx)
	},
})

export const itemDeleteTool = defineTool({
	name: "item_delete",
	description: "Удалить элементы раздела (необратимо, вместе с файлами).",
	input: { domain: zDomain, node: zNode, ids: z.array(z.number().int().positive()).min(1) },
	destructive: true,
	handler: async ({ domain, node, ids }) => {
		const wire: Wire = new Map([["ids[]", ids.map(String)]])
		await api(domain, { method: "POST", path: `/admin/node/${node}/content/delete`, body: wire })
		return { deleted: ids }
	},
})

export const itemMoveTool = defineTool({
	name: "item_move",
	description: "Переместить элементы в другой раздел того же типа.",
	input: { domain: zDomain, node: zNode, ids: z.array(z.number().int().positive()).min(1), toNode: zNode.describe("id целевого раздела") },
	handler: async ({ domain, node, ids, toNode }) => {
		const wire: Wire = new Map([["ids[]", ids.map(String)], ["toNode", [String(toNode)]]])
		await api(domain, { method: "POST", path: `/admin/node/${node}/content/move`, body: wire })
		return { moved: ids, toNode }
	},
})

export const itemCopyTool = defineTool({
	name: "item_copy",
	description: "Скопировать элемент в раздел того же типа (можно в тот же). Копия получает title « (копия)» и новый code.",
	input: { domain: zDomain, node: zNode, id: z.number().int().positive(), toNode: zNode.describe("id целевого раздела") },
	handler: async ({ domain, node, id, toNode }) => {
		const wire: Wire = new Map([["id", [String(id)]], ["toNode", [String(toNode)]]])
		const saved = await api<{ id: number }>(domain, { method: "POST", path: `/admin/node/${node}/content/copy`, body: wire })
		return itemView(domain, toNode, saved.id, await itemContext(domain, toNode))
	},
})

export const itemsExportCsvTool = defineTool({
	name: "items_export_csv",
	description: "Выгрузить элементы раздела в CSV (формат совместим с items_import_csv). Возвращает описание столбцов и формат значений — используй как образец для импорта.",
	input: { domain: zDomain, node: zNode, path: zPath.describe("куда сохранить .csv"), filters: zFilters, sorter: zSorter },
	readOnly: true,
	handler: async ({ domain, node, path, filters, sorter }) => {
		const ctx = await itemContext(domain, node)
		const all: DisplayItem[] = []
		for (let page = 1; ; page++) {
			const query = listQuery({ page, perPage: EXPORT_PAGE_SIZE, filters, sorter }, ["id", "pub_date", ...ctx.fields.map(f => f.code)], "id asc")
			query.all_fields = ""
			const data = await api<iListResponse<DisplayItem>>(domain, { path: `/admin/node/${node}/content`, query })
			all.push(...data.items)
			if (all.length >= data.totalItems || !data.items.length) break
		}
		const saved = await writeTextFile(path, buildItemsCsv(all, ctx.fields))
		return {
			path: saved,
			rows: all.length,
			delimiter: ";",
			columns: [{ header: "id", format: "id элемента; пусто — создать новый" }, ...csvColumns(ctx.fields)],
			import_rules: "Шапка = названия столбцов как здесь. Поля, которых нет в шапке, не меняются. Пустая ячейка очищает поле. Файлы, вопросы и опросы импортом не меняются.",
		}
	},
})

export const itemsImportCsvTool = defineTool({
	name: "items_import_csv",
	description: "Загрузить CSV в раздел: строки с id обновляются, без id — создаются. ВСЕГДА сначала сделай items_export_csv и повтори его формат (названия столбцов, «Да/Нет», названия справочников).",
	input: { domain: zDomain, node: zNode, path: zPath.describe("путь к .csv") },
	handler: async ({ domain, node, path }) => {
		const ctx = await itemContext(domain, node)
		const { text, headers } = prepareCsvForImport(await fs.readFile(path))
		const titles = ctx.fields.map(f => f.title)
		const unknown = headers.slice(1).filter(h => h.length && !titles.includes(h))
		if (unknown.length) throw new ValidationError([`столбцы не соответствуют полям раздела: ${unknown.join(", ")}`, `допустимые заголовки: ${titles.join(", ")}`])
		const wire: Wire = new Map([["file", [{ blob: new Blob([text], { type: "text/csv" }), name: "import.csv" }]]])
		const response = await apiRaw(domain, { method: "POST", path: `/admin/node/${node}/content/import`, body: wire })
		return readImportSse(response)
	},
})

export const itemTools = [itemsTool, itemTool, itemSaveTool, itemSetFieldTool, itemDeleteTool, itemMoveTool, itemCopyTool, itemsExportCsvTool, itemsImportCsvTool]
