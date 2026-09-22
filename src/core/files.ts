import fs from "node:fs/promises"
import path from "node:path"

const MIME: Record<string, string> = {
	jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
	pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	csv: "text/csv", txt: "text/plain", zip: "application/zip", mp4: "video/mp4", json: "application/json",
}

export interface iLoadedFile {
	blob: Blob
	name: string
}

export function isUrl(source: string): boolean {
	return /^https?:\/\//i.test(source)
}

function mimeByName(name: string): string {
	return MIME[path.extname(name).slice(1).toLowerCase()] ?? "application/octet-stream"
}

//источник файла для загрузки: локальный путь или http(s)-URL
export async function loadFile(source: string, forceMime?: string): Promise<iLoadedFile> {
	if (isUrl(source)) {
		const response = await fetch(source)
		if (!response.ok) throw new Error(`Не удалось скачать ${source}: HTTP ${response.status}`)
		const buffer = Buffer.from(await response.arrayBuffer())
		const disposition = response.headers.get("content-disposition") ?? ""
		const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(disposition)?.[1]
		const name = decodeURIComponent(fromHeader ?? path.basename(new URL(source).pathname)) || "file"
		const type = forceMime ?? response.headers.get("content-type")?.split(";")[0] ?? mimeByName(name)
		return { blob: new Blob([buffer], { type }), name }
	}
	const resolved = path.resolve(source)
	const buffer = await fs.readFile(resolved)
	const name = path.basename(resolved)
	return { blob: new Blob([buffer], { type: forceMime ?? mimeByName(name) }), name }
}

export async function writeTextFile(target: string, content: string): Promise<string> {
	const resolved = path.resolve(target)
	await fs.mkdir(path.dirname(resolved), { recursive: true })
	await fs.writeFile(resolved, content, "utf8")
	return resolved
}

export async function writeBinaryFile(target: string, content: Buffer): Promise<string> {
	const resolved = path.resolve(target)
	await fs.mkdir(path.dirname(resolved), { recursive: true })
	await fs.writeFile(resolved, content)
	return resolved
}
