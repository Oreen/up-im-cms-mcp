import { z } from "zod"
import { api } from "../core/http.ts"
import { type FilterValue, type iListResponse, listQuery, listResult } from "../core/lists.ts"
import { defineTool, zDomain, zFilters, zPage, zPerPage, zSorter } from "./define.ts"

type Row = Record<string, unknown>

const strip = (row: Row, keys: string[]): Row => {
	const out = { ...row }
	for (const key of keys) delete out[key]
	return out
}

const HISTORY_ALLOWED = ["id", "pub_date", "user", "user_title", "item_table", "item_id", "item_title", "field", "old_value", "new_value"]

export const historySearchTool = defineTool({
	name: "history_search",
	description: "История изменений в админке (кто, когда, что, старое/новое значение). Одна запись = одно поле; создание — field=id/new_value=«Добавлен», удаление — «Удален». Условия объединяются по И.",
	input: {
		domain: zDomain,
		table: z.string().optional().describe("таблица: content_<тип>, nodes, nodes_generated, user, seo"),
		item_id: z.number().int().optional().describe("id элемента/раздела (для параметров раздела — id раздела)"),
		item_title: z.string().optional().describe("поиск по названию элемента"),
		field: z.string().optional().describe("код поля"),
		user: z.union([z.number(), z.string()]).optional().describe("id пользователя или часть имени"),
		value: z.string().optional().describe("поиск по новому значению"),
		date_from: z.string().optional().describe("YYYY-MM-DD"),
		date_to: z.string().optional().describe("YYYY-MM-DD"),
		page: zPage,
		perPage: zPerPage,
	},
	readOnly: true,
	handler: async ({ domain, table, item_id, item_title, field, user, value, date_from, date_to, page, perPage }) => {
		const filters: Record<string, FilterValue> = {}
		if (table) filters.item_table = table
		if (item_id !== undefined) filters.item_id = item_id
		if (item_title) filters.item_title = item_title
		if (field) filters.field = field
		if (typeof user === "number") filters.user = user
		else if (user) filters.user_title = user
		if (value) filters.new_value = value
		if (date_from) filters[">pub_date"] = date_from
		if (date_to) {
			//фильтр YYYY-MM-DD сравнивается точно, поэтому верхняя граница — следующий день
			const next = new Date(`${date_to}T00:00:00Z`)
			next.setUTCDate(next.getUTCDate() + 1)
			filters["<pub_date"] = next.toISOString().slice(0, 10)
		}
		const query = listQuery({ page, perPage, filters }, HISTORY_ALLOWED)
		const data = await api<iListResponse<Row>>(domain, { path: "/admin/history", query })
		return listResult(data, page, data.items.map(r => strip(r, ["errors", "node_type"])))
	},
})

const USER_ALLOWED = ["id", "register_date", "role", "email", "phone", "firstname", "lastname", "middlename"]

export const usersTool = defineTool({
	name: "users",
	description: "Пользователи сайта (только чтение). role: 0 — пользователь, 1000 — админ, 10000 — суперадмин.",
	input: { domain: zDomain, page: zPage, perPage: zPerPage, filters: zFilters, sorter: zSorter },
	readOnly: true,
	handler: async ({ domain, page, perPage, filters, sorter }) => {
		const query = listQuery({ page, perPage, filters, sorter }, USER_ALLOWED)
		const data = await api<iListResponse<Row>>(domain, { path: "/admin/user", query })
		return listResult(data, page, data.items.map(r => strip(r, ["hash", "password", "errors", "node_type", "user_fields"])))
	},
})

const FEEDBACK_ALLOWED = ["id", "pub_date", "user", "title", "name", "phone", "email", "text", "source", "crm_id", "city", "page", "ip"]

export const feedbackTool = defineTool({
	name: "feedback",
	description: "Заявки с форм сайта (только чтение). Статусов нет; crm_id=0 — ещё не передана в CRM. Сортировка по умолчанию — новые первыми.",
	input: { domain: zDomain, page: zPage, perPage: zPerPage, filters: zFilters, sorter: zSorter },
	readOnly: true,
	handler: async ({ domain, page, perPage, filters, sorter }) => {
		const query = listQuery({ page, perPage, filters, sorter }, FEEDBACK_ALLOWED)
		const data = await api<iListResponse<Row>>(domain, { path: "/admin/feedback", query })
		return listResult(data, page, data.items.map(r => strip(r, ["errors", "node_type", "hash", "files"])))
	},
})

const ORDER_ALLOWED = ["id", "pub_date", "user", "user_firstname", "user_lastname", "user_email", "user_phone", "company", "delivery_type", "payment_type", "total_amount", "total_quantity", "crm_id", "city"]

export const ordersTool = defineTool({
	name: "orders",
	description: "Заказы интернет-магазина (только чтение). Статусов нет; crm_id=0 — не передан в CRM. Состав — order_products.",
	input: { domain: zDomain, page: zPage, perPage: zPerPage, filters: zFilters, sorter: zSorter },
	readOnly: true,
	handler: async ({ domain, page, perPage, filters, sorter }) => {
		const query = listQuery({ page, perPage, filters, sorter }, ORDER_ALLOWED)
		const data = await api<iListResponse<Row>>(domain, { path: "/admin/order", query })
		return listResult(data, page, data.items.map(r => strip(r, ["errors", "node_type", "hash"])))
	},
})

export const orderProductsTool = defineTool({
	name: "order_products",
	description: "Состав заказа: товары, количество, цена.",
	input: { domain: zDomain, order: z.number().int().positive().describe("id заказа") },
	readOnly: true,
	handler: async ({ domain, order }) => {
		const data = await api<iListResponse<Row>>(domain, { path: `/admin/order/${order}/products` })
		return data.items
	},
})

export const readonlyTools = [historySearchTool, usersTool, feedbackTool, ordersTool, orderProductsTool]
