import { z } from "zod"
import { ValidationError } from "../core/errors.ts"
import { describeField, getFields, getNode, getNodeParams, getNodeTypes, getOptions, type iField, isSelectTypeField } from "../core/schema.ts"
import { defineTool, zDomain, zNode } from "./define.ts"

export const typesTool = defineTool({
	name: "types",
	description: "Типы разделов (модули) сайта: код типа, название, есть ли подборки.",
	input: { domain: zDomain },
	readOnly: true,
	handler: async ({ domain }) => (await getNodeTypes(domain)).map(t => ({ type: t.type, title: t.title, sort_by: t.sort_by, generator: t.generator })),
})

export const schemaTool = defineTool({
	name: "schema",
	description: "Поля элементов раздела (по id раздела или коду типа) и поля параметров самого раздела: код, название, тип, формат значения для item_save/node_save. Вызывай перед созданием/правкой, если схема неизвестна.",
	input: {
		domain: zDomain,
		node: z.number().int().positive().optional().describe("id раздела"),
		type: z.string().optional().describe("код типа раздела (если раздел не известен)"),
	},
	readOnly: true,
	handler: async ({ domain, node, type }) => {
		if (!node && !type) throw new ValidationError(["укажи node или type"])
		const nodeType = type ?? (await getNode(domain, node!)).type
		const fields = await getFields(domain, nodeType)
		const out: Record<string, unknown> = { type: nodeType, item_fields: fields.map(describeField) }
		if (node) {
			const params = await getNodeParams(domain, node)
			out.node_params = (params.node_param_fields ?? []).map(describeField)
		}
		return out
	},
})

async function resolveField(domain: string, node: number, code: string, kind: "fields" | "params"): Promise<iField> {
	const fields = kind === "fields"
		? await getFields(domain, (await getNode(domain, node)).type)
		: (await getNodeParams(domain, node)).node_param_fields ?? []
	const field = fields.find(f => f.code === code)
	if (!field) throw new ValidationError([`поле "${code}" не найдено; доступны: ${fields.map(f => f.code).join(", ")}`])
	if (!isSelectTypeField(field)) throw new ValidationError([`поле "${code}" типа ${field.field_type} не имеет справочника`])
	return field
}

export const optionsTool = defineTool({
	name: "options",
	description: "Варианты значений {id, title} для select/multiselect-поля. Максимум 100 — уточняй search (от 2 символов).",
	input: {
		domain: zDomain,
		node: zNode,
		field: z.string().describe("код поля"),
		search: z.string().optional().describe("поиск по названию"),
		param: z.boolean().optional().describe("true — поле параметров раздела, иначе поле элементов"),
	},
	readOnly: true,
	handler: async ({ domain, node, field, search, param }) => {
		const kind = param ? "params" : "fields"
		const f = await resolveField(domain, node, field, kind)
		return { field: f.code, source: f.table_data, items: await getOptions(domain, kind, f.id, search) }
	},
})
