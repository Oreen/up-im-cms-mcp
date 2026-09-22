import { ValidationError } from "./errors.ts"
import { loadFile, isUrl } from "./files.ts"
import { type Wire, type WirePart, wireSet } from "./http.ts"
import { FILE_TYPES, MULTI_FILE_TYPES, MULTI_ID_TYPES, type OptionsKind, SELECT_TYPES, getOptions, type iField } from "./schema.ts"

export type DisplayItem = Record<string, unknown>
export type AgentPatch = Record<string, unknown>

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

function idOf(v: unknown): number | null {
	if (typeof v === "number") return v
	if (typeof v === "string" && /^\d+$/.test(v)) return Number(v)
	if (isObj(v) && typeof v.id === "number") return v.id
	return null
}

function toIsoDate(display: DisplayItem, code: string): string {
	const original = display[`${code}_original`]
	if (typeof original === "string" && original.length) return new Date(original).toISOString()
	const raw = display[code]
	if (raw instanceof Date) return raw.toISOString()
	if (typeof raw === "string" && raw.length) {
		const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?$/.exec(raw)
		if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] ?? 0), +(m[5] ?? 0))).toISOString()
		const d = new Date(raw)
		if (!isNaN(d.getTime())) return d.toISOString()
	}
	return ""
}

function fileList(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0)
	if (typeof v === "string" && v.length) return v.split(",").filter(Boolean)
	return []
}

function refPairs(v: unknown): { title: string, value: string }[] {
	if (!Array.isArray(v)) return []
	return v.filter(isObj).map(it => ({ title: String(it.title ?? ""), value: String(it.value ?? "") }))
}

export function wireKeysFor(field: iField): string[] {
	return [field.code, `${field.code}[]`, `${field.code}_files`]
}

//текущее состояние элемента (ответ GET) → multipart-представление. База для read-merge-write.
export function displayToWire(item: DisplayItem, fields: iField[]): Wire {
	const wire: Wire = new Map()
	for (const field of fields) {
		const code = field.code
		const v = item[code]
		switch (field.field_type) {
			case "text": case "alias": case "textarea":
				wireSet(wire, code, v == null ? "" : String(v))
				break
			case "yapoint":
				wireSet(wire, code, Array.isArray(v) ? v.join(",") : v == null ? "" : String(v))
				break
			case "integer":
				wireSet(wire, code, v == null ? "0" : String(v))
				break
			case "checkbox":
				wireSet(wire, code, v ? "true" : "false")
				break
			case "date":
				wireSet(wire, code, toIsoDate(item, code))
				break
			case "select": {
				const id = idOf(v)
				if (id) wireSet(wire, code, String(id))
				break
			}
			case "multiselect": case "multiselectExtTable": case "multisel2area": {
				const ids = Array.isArray(v) ? v.map(idOf).filter((x): x is number => x !== null) : []
				if (ids.length) wireSet(wire, `${code}[]`, ...ids.map(String))
				break
			}
			case "multitext": {
				const list = Array.isArray(v) ? v.map(String) : typeof v === "string" && v.length ? v.split("|||") : []
				if (list.length) wireSet(wire, `${code}[]`, ...list)
				break
			}
			case "reference": {
				const flat = refPairs(v).flatMap(p => [p.title, p.value])
				if (flat.length) wireSet(wire, `${code}[]`, ...flat)
				break
			}
			case "questions": case "surveys":
				if (Array.isArray(v) && v.length) wireSet(wire, code, JSON.stringify(v))
				break
			case "image": case "file": {
				wireSet(wire, `${code}[]`, "")
				if (typeof v === "string" && v.length) wireSet(wire, `${code}_files`, v)
				break
			}
			case "multiimage": case "multifile": {
				wireSet(wire, `${code}[]`, "")
				const list = fileList(v)
				if (list.length) wireSet(wire, `${code}_files`, list.join(","))
				break
			}
		}
	}
	return wire
}

export interface iConvertContext {
	domain: string
	optionsKind: OptionsKind
	current?: DisplayItem
}

//значения от агента → multipart. Проверяет типы, коды полей, id справочников; грузит файлы.
export async function agentToWire(patch: AgentPatch, fields: iField[], ctx: iConvertContext): Promise<Wire> {
	const wire: Wire = new Map()
	const problems: string[] = []
	const idChecks: { field: iField, ids: number[] }[] = []
	const fail = (field: iField, msg: string) => problems.push(`${field.code} (${field.title}): ${msg}`)

	for (const [code, value] of Object.entries(patch)) {
		const field = fields.find(f => f.code === code)
		if (!field) {
			problems.push(`Неизвестное поле "${code}". Доступны: ${fields.map(f => f.code).join(", ")}`)
			continue
		}
		switch (field.field_type) {
			case "text": case "textarea":
				if (value != null && typeof value !== "string") fail(field, `ожидается string, получено ${typeof value}`)
				else wireSet(wire, code, value ?? "")
				break
			case "alias":
				if (value != null && typeof value !== "string") fail(field, "ожидается string")
				else if (value && !/^[a-z0-9_-]+$/.test(value as string)) fail(field, "допустимы только a-z, 0-9, _ и -")
				else wireSet(wire, code, (value as string | null) ?? "")
				break
			case "yapoint":
				if (Array.isArray(value) && value.length === 2) wireSet(wire, code, value.join(","))
				else if (value == null || value === "") wireSet(wire, code, "")
				else if (typeof value === "string" && /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(value)) wireSet(wire, code, value.replace(/\s/g, ""))
				else fail(field, "ожидается \"lat,lng\"")
				break
			case "integer":
				if (value == null || value === "") wireSet(wire, code, "0")
				else if (typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value))) wireSet(wire, code, String(value))
				else fail(field, "ожидается number")
				break
			case "checkbox":
				if (typeof value !== "boolean") fail(field, "ожидается boolean")
				else wireSet(wire, code, value ? "true" : "false")
				break
			case "date": {
				if (value == null || value === "") { wireSet(wire, code, ""); break }
				const d = new Date(value as string)
				if (isNaN(d.getTime())) fail(field, "ожидается дата ISO 8601 или null")
				else wireSet(wire, code, d.toISOString())
				break
			}
			case "select": {
				if (value == null || value === "") { wireSet(wire, code, ""); break }
				const id = idOf(value)
				if (!id) { fail(field, "ожидается number id или null"); break }
				wireSet(wire, code, String(id))
				if (field.table_data) idChecks.push({ field, ids: [id] })
				break
			}
			case "multiselect": case "multiselectExtTable": case "multisel2area": {
				if (value == null) { wire.set(`${code}[]`, []); break }
				if (!Array.isArray(value)) { fail(field, "ожидается number[]"); break }
				const ids = value.map(idOf)
				if (ids.some(x => x === null)) { fail(field, "ожидается number[]"); break }
				const clean = [...new Set(ids as number[])]
				wireSet(wire, `${code}[]`, ...clean.map(String))
				if (clean.length && field.table_data) idChecks.push({ field, ids: clean })
				break
			}
			case "multitext":
				if (value == null) { wire.set(`${code}[]`, []); break }
				if (!Array.isArray(value) || value.some(x => typeof x !== "string")) { fail(field, "ожидается string[]"); break }
				wireSet(wire, `${code}[]`, ...(value as string[]))
				break
			case "reference": {
				if (value == null) { wire.set(`${code}[]`, []); break }
				if (!Array.isArray(value) || !value.every(x => isObj(x) && typeof x.title === "string")) { fail(field, "ожидается [{title, value}]"); break }
				wireSet(wire, `${code}[]`, ...refPairs(value).flatMap(p => [p.title, p.value]))
				break
			}
			case "questions": case "surveys":
				if (value == null) { wireSet(wire, code, ""); break }
				if (!Array.isArray(value)) { fail(field, "ожидается массив"); break }
				wireSet(wire, code, JSON.stringify(value))
				break
			case "image": case "file": {
				if (value == null || value === "") { wireSet(wire, `${code}[]`, ""); break }
				if (typeof value !== "string") { fail(field, "ожидается путь/URL, имя текущего файла или null"); break }
				const currentName = typeof ctx.current?.[code] === "string" ? ctx.current[code] as string : ""
				if (value === currentName) {
					wireSet(wire, `${code}[]`, "")
					wireSet(wire, `${code}_files`, currentName)
					break
				}
				try {
					const file = await loadFile(value)
					wireSet(wire, `${code}[]`, { blob: file.blob, name: file.name })
					if (currentName) wireSet(wire, `${code}_files`, currentName)
				} catch (error) {
					fail(field, (error as Error).message)
				}
				break
			}
			case "multiimage": case "multifile": {
				if (value == null) { wireSet(wire, `${code}[]`, ""); break }
				if (!Array.isArray(value) || value.some(x => typeof x !== "string")) { fail(field, "ожидается string[]"); break }
				const currentList = fileList(ctx.current?.[code])
				const keep: string[] = []
				const uploads: WirePart[] = []
				for (const entry of value as string[]) {
					if (currentList.includes(entry)) { keep.push(entry); continue }
					if (!isUrl(entry) && !/[\\/.]/.test(entry)) { fail(field, `"${entry}" не является ни текущим файлом, ни путём/URL`); continue }
					try {
						const file = await loadFile(entry)
						uploads.push({ blob: file.blob, name: file.name })
						keep.push(file.name)//сервер подставит новое имя по file.name при сортировке
					} catch (error) {
						fail(field, (error as Error).message)
					}
				}
				wireSet(wire, `${code}[]`, ...(uploads.length ? uploads : [""]))
				if (keep.length) wireSet(wire, `${code}_files`, keep.join(","))
				break
			}
		}
	}

	for (const check of idChecks) {
		const found = await getOptions(ctx.domain, ctx.optionsKind, check.field.id, undefined, check.ids)
		const missing = check.ids.filter(id => !found.some(o => o.id === id))
		if (missing.length) fail(check.field, `в справочнике ${check.field.table_data} нет id ${missing.join(", ")} (см. options)`)
	}
	if (problems.length) throw new ValidationError(problems)
	return wire
}

export function checkRequired(fields: iField[], merged: Wire): void {
	const missing = fields.filter(f => f.required).filter(f => {
		const single = merged.get(f.code)
		const multi = merged.get(`${f.code}[]`)
		const files = merged.get(`${f.code}_files`)
		const has = (single?.some(p => typeof p !== "string" || p.length > 0)) || (multi?.some(p => typeof p !== "string" || p.length > 0)) || files?.length
		return !has
	})
	if (missing.length) throw new ValidationError(missing.map(f => `Обязательное поле ${f.code} (${f.title}) не заполнено`))
}

//ответ GET → компактный вид для агента: select → {id,title}, даты → ISO, без служебных ключей
export function displayToAgent(item: DisplayItem, fields: iField[], baseUrl: string): Record<string, unknown> {
	const out: Record<string, unknown> = { id: item.id }
	if (typeof item.url === "string") out.url = `${baseUrl}${item.url}`
	if (item.node !== undefined) out.node = item.node
	if (item.pub_date !== undefined) out.pub_date = toIsoDate(item, "pub_date") || null
	const pick = (v: unknown) => isObj(v) ? { id: v.id, title: v.title } : v
	for (const field of fields) {
		const code = field.code
		const v = item[code]
		switch (field.field_type) {
			case "date": out[code] = toIsoDate(item, code) || null; break
			case "select": out[code] = v == null || v === "" ? null : pick(v); break
			case "multiselect": case "multiselectExtTable": case "multisel2area": out[code] = Array.isArray(v) ? v.map(pick) : []; break
			case "reference": out[code] = refPairs(v); break
			case "multiimage": case "multifile": out[code] = fileList(v); break
			case "multitext": out[code] = Array.isArray(v) ? v : typeof v === "string" && v.length ? v.split("|||") : []; break
			case "checkbox": out[code] = !!v; break
			case "integer": out[code] = v == null ? 0 : Number(v); break
			default: out[code] = v ?? (FILE_TYPES.includes(field.field_type) ? "" : null)
		}
	}
	return out
}

export const isMultiIdType = (t: iField["field_type"]) => MULTI_ID_TYPES.includes(t)
export const isFileType = (t: iField["field_type"]) => FILE_TYPES.includes(t)
export const isMultiFileType = (t: iField["field_type"]) => MULTI_FILE_TYPES.includes(t)
export const isSelectType = (t: iField["field_type"]) => SELECT_TYPES.includes(t)
