import { SCHEMA_CACHE_MS } from "./config.ts"
import { api } from "./http.ts"

export type FieldType =
	| "text" | "multitext" | "date" | "integer" | "textarea"
	| "select" | "multiselect" | "multiselectExtTable" | "multisel2area"
	| "image" | "multiimage" | "file" | "multifile"
	| "checkbox" | "alias" | "yapoint" | "reference" | "questions" | "surveys"

export interface iField {
	id: number
	node_type: string
	field_type: FieldType
	code: string
	title: string
	sorter: number
	editor: boolean
	show_in_list: boolean
	required: boolean
	table_data: string
	table_filter_field: string
	table_filter_value: string
	tooltip: string
}

export interface iAdminNode {
	id: number
	type: string
	parent: number
	code: string
	title: string
	menutitle: string
	sorter: number
	image: string
	icon: string
	redirect: string
	meta_title: string
	meta_keywords: string
	meta_description: string
	meta_title_element_tpl: string
	meta_keywords_element_tpl: string
	meta_description_element_tpl: string
	no_search: boolean
	no_menu: boolean
	public: boolean
	blocked: boolean
	pub_date: string | null
}

export interface iNodeParams {
	node_type: string
	node_id: number
	node_param_fields?: iField[]
	node_param_values?: Record<string, unknown>
}

export interface iNodeType {
	id: number
	type: string
	title: string
	sorter: number
	search: boolean
	sort_by: string
	generator: boolean
}

export interface iOption {
	id: number
	title: string
}

export type OptionsKind = "fields" | "params"

export const SELECT_TYPES: FieldType[] = ["select", "multiselect", "multiselectExtTable", "multisel2area"]
export const MULTI_ID_TYPES: FieldType[] = ["multiselect", "multiselectExtTable", "multisel2area"]
export const FILE_TYPES: FieldType[] = ["image", "file", "multiimage", "multifile"]
export const MULTI_FILE_TYPES: FieldType[] = ["multiimage", "multifile"]

//что агент передаёт в fields[code] — единый формат для item_save / node_save.params / item_set_field
export const INPUT_HINT: Record<FieldType, string> = {
	text: "string",
	alias: "string, только [a-z0-9_-]; пусто → сгенерируется из title",
	textarea: "string HTML; в <img src>/<source src>/<a href> можно указать путь к локальному файлу или URL картинки — MCP загрузит их на сайт",
	integer: "number",
	checkbox: "boolean",
	date: "string ISO 8601 или null",
	select: "number id из options() или null",
	multiselect: "number[] id из options()",
	multiselectExtTable: "number[] id из options()",
	multisel2area: "number[] id из options()",
	multitext: "string[]",
	reference: "[{title: string, value: string}]",
	questions: "[{title, answers: [{title, correct?: boolean}]}] — минимум 2 ответа, один correct",
	surveys: "[{title, type?: \"single\"|\"multiple\"|\"text\", answers: [{title}]}]",
	yapoint: "string \"lat,lng\"",
	image: "string: путь к локальному файлу или URL для загрузки; текущее имя файла — оставить; null — удалить",
	file: "string: путь к локальному файлу или URL для загрузки; текущее имя файла — оставить; null — удалить",
	multiimage: "string[] в итоговом порядке: текущие имена файлов — оставить, пути/URL — добавить; [] — удалить все",
	multifile: "string[] в итоговом порядке: текущие имена файлов — оставить, пути/URL — добавить; [] — удалить все",
}

//что умеет WYSIWYG-редактор (TinyMCE + плагин upcmssnippet в админке): агент может писать этот HTML напрямую
export const EDITOR_HINT = [
	"Медиа внутри HTML: <img src=\"/путь/или/https://…/photo.jpg\">, <video><source src=\"/путь/clip.mp4\"></video>, <a href=\"/путь/doc.pdf\">файл</a> — MCP загрузит файлы на сайт и подставит ссылки /upload/…; уже загруженные /upload/… и внешние ссылки <a href=\"https://…\"> остаются как есть.",
	"Сниппеты (блоки, которые рендерит фронт сайта): <div class=\"slider\"><img src=\"/upload/…\">…</div> — слайдер из картинок; <div class=\"banner\"></div>; <div class=\"feedback\"></div> — форма заявки; <div class=\"feedback_button\">Текст кнопки</div>; <div class=\"subscribe\"></div> — форма подписки; <div class=\"telegram\"></div>.",
	"Аккордеон: <details class=\"mce-accordion\"><summary class=\"mce-accordion-summary\">Заголовок</summary><div class=\"mce-accordion-body\"><p>…</p></div></details>.",
	"Разрешён <noindex>. Набор сниппетов и их вид зависят от конкретного сайта — при сомнении посмотри HTML существующего элемента через item.",
].join(" ")

const cache = new Map<string, { at: number, fields: iField[] }>()

export async function getFields(domain: string, type: string): Promise<iField[]> {
	const key = `${domain}|${type}`
	const hit = cache.get(key)
	if (hit && Date.now() - hit.at < SCHEMA_CACHE_MS) return hit.fields
	const fields = await api<iField[]>(domain, { path: `/admin/module/${encodeURIComponent(type)}/fields` })
	cache.set(key, { at: Date.now(), fields })
	return fields
}

export async function getNode(domain: string, nodeId: number): Promise<iAdminNode> {
	return api<iAdminNode>(domain, { path: `/admin/node/${nodeId}` })
}

export async function getNodeParams(domain: string, nodeId: number): Promise<iNodeParams> {
	return api<iNodeParams>(domain, { path: `/admin/node/${nodeId}/params` })
}

export async function getNodeTypes(domain: string): Promise<iNodeType[]> {
	return api<iNodeType[]>(domain, { path: "/admin/module" })
}

export async function getOptions(domain: string, kind: OptionsKind, fieldId: number, search?: string, ids?: number[]): Promise<iOption[]> {
	const data = await api<{ items: iOption[] }>(domain, {
		path: `/admin/module/${fieldId}/${kind}/options`,
		query: { title: search && search.length >= 2 ? search : undefined, ids },
	})
	return data.items
}

export interface iFieldDescription {
	code: string
	title: string
	type: FieldType
	input: string
	required?: true
	html_editor?: true
	editor_hint?: string
	options_from?: string
	tooltip?: string
}

export function describeField(field: iField): iFieldDescription {
	const out: iFieldDescription = { code: field.code, title: field.title, type: field.field_type, input: INPUT_HINT[field.field_type] }
	if (field.required) out.required = true
	if (field.editor && field.field_type === "textarea") {
		out.html_editor = true
		out.editor_hint = EDITOR_HINT
	}
	if (field.table_data && SELECT_TYPES.includes(field.field_type)) out.options_from = field.table_data
	if (field.tooltip) out.tooltip = field.tooltip
	return out
}

export function findField(fields: iField[], code: string): iField | undefined {
	return fields.find(f => f.code === code)
}

export function isSelectTypeField(field: iField): boolean {
	return SELECT_TYPES.includes(field.field_type) && field.table_data.length > 0
}
