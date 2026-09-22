import fs from "node:fs/promises"
import { z } from "zod"
import { getProject } from "../core/auth.ts"
import { type AgentPatch, type DisplayItem, agentToWire, displayToAgent, displayToWire, hasInlineMedia, wireKeysFor } from "../core/convert.ts"
import { ValidationError } from "../core/errors.ts"
import { writeBinaryFile } from "../core/files.ts"
import { type Wire, api, apiRaw, readImportSse, wireSet } from "../core/http.ts"
import { type FieldType, getNode, getNodeParams, type iAdminNode, type iField } from "../core/schema.ts"
import { defineTool, zDomain, zNode, zPath } from "./define.ts"
import { mergeWire } from "./items.ts"

//фиксированные поля раздела в терминах iField — чтобы переиспользовать конвертер контента
function nodeField(code: string, title: string, field_type: FieldType, required = false): iField {
	return { id: 0, node_type: "nodes", field_type, code, title, sorter: 0, editor: false, show_in_list: false, required, table_data: "", table_filter_field: "", table_filter_value: "", tooltip: "" }
}

const NODE_FIELDS: iField[] = [
	nodeField("type", "Тип раздела", "text", true),
	nodeField("code", "URL-код", "text"),
	nodeField("title", "Название", "text", true),
	nodeField("menutitle", "Название в меню", "text"),
	nodeField("public", "Опубликован", "checkbox"),
	nodeField("no_menu", "Скрыть в меню", "checkbox"),
	nodeField("no_search", "Скрыть в поиске", "checkbox"),
	nodeField("redirect", "Редирект", "text"),
	nodeField("meta_title", "Meta title", "text"),
	nodeField("meta_keywords", "Meta keywords", "text"),
	nodeField("meta_description", "Meta description", "text"),
	nodeField("meta_title_element_tpl", "Шаблон meta title элементов", "text"),
	nodeField("meta_keywords_element_tpl", "Шаблон meta keywords элементов", "text"),
	nodeField("meta_description_element_tpl", "Шаблон meta description элементов", "text"),
	nodeField("image", "Картинка", "image"),
	nodeField("icon", "Иконка (svg)", "image"),
]

const zNodeFields = z.object({
	type: z.string().optional().describe("код типа раздела (types); обязателен при создании"),
	code: z.string().optional().describe("URL-код, может содержать / для вложенности (a-z0-9_-); пусто — из title"),
	title: z.string().optional(),
	menutitle: z.string().optional(),
	public: z.boolean().optional(),
	no_menu: z.boolean().optional(),
	no_search: z.boolean().optional(),
	redirect: z.string().optional(),
	meta_title: z.string().optional(),
	meta_keywords: z.string().optional(),
	meta_description: z.string().optional(),
	meta_title_element_tpl: z.string().optional().describe("шаблон для элементов, подстановка %код_поля%"),
	meta_keywords_element_tpl: z.string().optional(),
	meta_description_element_tpl: z.string().optional(),
	image: z.string().nullable().optional().describe("путь/URL для загрузки, текущее имя — оставить, null — удалить"),
	icon: z.string().nullable().optional().describe("svg: путь/URL, текущее имя — оставить, null — удалить"),
})

interface iTreeNode {
	id: number
	type: string
	parent: number
	code: string
	title: string
	menutitle: string
	sorter: number
	redirect: string
	no_menu: boolean
	children?: iTreeNode[]
}

function findInTree(nodes: iTreeNode[], id: number): iTreeNode | undefined {
	for (const n of nodes) {
		if (n.id === id) return n
		const hit = n.children && findInTree(n.children, id)
		if (hit) return hit
	}
	return undefined
}

function compactTree(nodes: iTreeNode[], baseUrl: string, depth: number): unknown[] {
	return nodes.map(n => ({
		id: n.id,
		code: n.code,
		type: n.type,
		title: n.title,
		url: `${baseUrl}/${n.code}/`,
		...(n.children?.length ? (depth > 1 ? { children: compactTree(n.children, baseUrl, depth - 1) } : { children_count: n.children.length }) : {}),
	}))
}

export const nodeTreeTool = defineTool({
	name: "node_tree",
	description: "Дерево разделов сайта (id, code, type, title, url). Без parent — от корня; depth ограничивает вложенность.",
	input: {
		domain: zDomain,
		parent: z.number().int().nonnegative().optional().describe("id раздела, чьих потомков вернуть"),
		depth: z.number().int().positive().max(10).optional().describe("глубина, по умолчанию 2"),
		type: z.string().optional().describe("только разделы этого типа (и их родители того же типа)"),
	},
	readOnly: true,
	handler: async ({ domain, parent, depth, type }) => {
		const baseUrl = getProject(domain).baseUrl
		const tree = await api<iTreeNode[]>(domain, { path: type ? `/admin/node/type/${encodeURIComponent(type)}` : "/admin/node" })
		let roots = tree
		if (parent) {
			const hit = findInTree(tree, parent)
			if (!hit) throw new ValidationError([`раздел ${parent} не найден`])
			roots = hit.children ?? []
		}
		return compactTree(roots, baseUrl, depth ?? 2)
	},
})

async function nodeView(domain: string, id: number): Promise<Record<string, unknown>> {
	const baseUrl = getProject(domain).baseUrl
	const node = await getNode(domain, id)
	const params = await getNodeParams(domain, id)
	const view = displayToAgent(node as unknown as DisplayItem, NODE_FIELDS, baseUrl)
	view.url = node.code ? `${baseUrl}/${node.code}/` : null
	view.parent = node.parent
	view.sorter = node.sorter
	view.blocked = node.blocked
	view.params = displayToAgent({ id: 0, ...(params.node_param_values ?? {}) }, params.node_param_fields ?? [], baseUrl)
	delete (view.params as Record<string, unknown>).id
	if (!node.public) view.note = "Раздел не опубликован — страница на сайте отдаст 404"
	return view
}

export const nodeGetTool = defineTool({
	name: "node_get",
	description: "Раздел: основные поля, SEO, url и параметры раздела (params).",
	input: { domain: zDomain, id: zNode },
	readOnly: true,
	handler: async ({ domain, id }) => nodeView(domain, id),
})

export const nodeSaveTool = defineTool({
	name: "node_save",
	description: "Создать (без id) или изменить раздел и/или его параметры. Передавай только изменяемое — остальное сохраняется. parent — куда вложить (при создании или переносе). Формат params — schema(node).",
	input: {
		domain: zDomain,
		id: zNode.optional(),
		fields: zNodeFields.optional(),
		params: z.record(z.unknown()).optional().describe("{код_параметра: значение}, см. schema(node).node_params"),
		parent: z.number().int().positive().optional().describe("id родительского раздела"),
	},
	handler: async ({ domain, id, fields, params, parent }) => {
		if (!id && !fields?.type) throw new ValidationError(["при создании раздела обязателен fields.type"])
		if (!id && !fields?.title) throw new ValidationError(["при создании раздела обязателен fields.title"])
		if (fields?.code !== undefined && fields.code !== "" && !/^[a-z0-9_-][a-z0-9_\/-]*[a-z0-9_-]$/.test(fields.code)) {
			throw new ValidationError(["code: только a-z, 0-9, _, -, / (не в начале и не в конце), минимум 2 символа"])
		}
		let nodeId = id
		if (fields && Object.keys(fields).length) {
			const current = id ? (await getNode(domain, id)) as unknown as DisplayItem : undefined
			const patch = await agentToWire(fields as AgentPatch, NODE_FIELDS, { domain, optionsKind: "fields", current })
			const wire = current ? mergeWire(displayToWire(current, NODE_FIELDS), patch, NODE_FIELDS.filter(f => f.code in fields)) : patch
			if (id) wireSet(wire, "id", String(id))
			const saved = await api<{ id: number }>(domain, { method: "POST", path: "/admin/node/edit", body: wire })
			nodeId = saved.id
		}
		if (!nodeId) throw new ValidationError(["нечего сохранять: укажи fields и/или params"])
		if (parent) {
			const currentParent = id ? (await getNode(domain, nodeId)).parent : 0
			if (currentParent !== parent) {
				const wire: Wire = new Map([["nodeId", [String(nodeId)]], ["upNodeId", [String(parent)]], ["isParent", ["true"]]])
				await api(domain, { method: "POST", path: "/admin/node/sort", body: wire })
			}
		}
		if (params && Object.keys(params).length) {
			const data = await getNodeParams(domain, nodeId)
			const paramFields = data.node_param_fields ?? []
			if (!paramFields.length) throw new ValidationError(["у этого типа раздела нет параметров"])
			const current = data.node_param_values ?? {}
			const patch = await agentToWire(params, paramFields, { domain, optionsKind: "params", current })
			const wire = mergeWire(displayToWire(current, paramFields), patch, paramFields.filter(f => f.code in params))
			await api(domain, { method: "POST", path: `/admin/node/${nodeId}/params/edit`, body: wire })
			//второй проход: у параметра без прежнего значения бэк не выгружает base64-медиа
			const after = await getNodeParams(domain, nodeId)
			const stuck = paramFields.filter(f => f.field_type === "textarea" && hasInlineMedia(after.node_param_values?.[f.code]))
			if (stuck.length) {
				await api(domain, { method: "POST", path: `/admin/node/${nodeId}/params/edit`, body: displayToWire(after.node_param_values ?? {}, paramFields) })
			}
		}
		return nodeView(domain, nodeId)
	},
})

export const nodeDeleteTool = defineTool({
	name: "node_delete",
	description: "Удалить раздел со всеми подразделами, элементами и файлами (необратимо).",
	input: { domain: zDomain, id: zNode },
	destructive: true,
	handler: async ({ domain, id }) => {
		const node: iAdminNode = await getNode(domain, id)
		await api(domain, { method: "POST", path: "/admin/node/delete", body: new Map([["id", [String(id)]]]) })
		return { deleted: id, code: node.code }
	},
})

export const nodesExportCsvTool = defineTool({
	name: "nodes_export_csv",
	description: "Выгрузить структуру разделов в CSV (формат совместим с nodes_import_csv): тип, родитель, URL, названия, SEO, флаги и параметры «[Парам] …».",
	input: { domain: zDomain, path: zPath.describe("куда сохранить .csv"), parent: z.number().int().positive().optional().describe("только ветка этого раздела (публичные потомки)") },
	readOnly: true,
	handler: async ({ domain, path, parent }) => {
		const response = await apiRaw(domain, { path: "/admin/node/export", query: { parent } })
		const buffer = Buffer.from(await response.arrayBuffer())
		const saved = await writeBinaryFile(path, buffer)
		const header = buffer.toString("utf8").replace(/^﻿/, "").split(/\r?\n/)[0]
		return {
			path: saved,
			delimiter: ";",
			columns: header.split(";"),
			import_rules: "Первый столбец id (пусто — создать), обязателен столбец «Тип» (тип существующего раздела менять нельзя). «Родитель» — id, флаги «Да/Нет», параметры-справочники — названиями.",
		}
	},
})

export const nodesImportCsvTool = defineTool({
	name: "nodes_import_csv",
	description: "Загрузить CSV структуры разделов: строки с id обновляются, без id — создаются. ВСЕГДА сначала сделай nodes_export_csv и повтори его формат.",
	input: { domain: zDomain, path: zPath.describe("путь к .csv") },
	handler: async ({ domain, path }) => {
		const buffer = await fs.readFile(path)
		const wire: Wire = new Map([["file", [{ blob: new Blob([buffer], { type: "text/csv" }), name: "nodes.csv" }]]])
		const response = await apiRaw(domain, { method: "POST", path: "/admin/node/import", body: wire })
		return readImportSse(response)
	},
})

export const nodeTools = [nodeTreeTool, nodeGetTool, nodeSaveTool, nodeDeleteTool, nodesExportCsvTool, nodesImportCsvTool]
export { wireKeysFor }
