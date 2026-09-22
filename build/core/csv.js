import Papa from "papaparse";
//формат ячейки при импорте (contentAdminController.importFile → replaceValue)
export const CSV_FORMAT = {
    text: "текст",
    alias: "код [a-z0-9_-], пусто → из заголовка",
    textarea: "HTML",
    integer: "число",
    checkbox: "«Да» / «Нет»",
    date: "ДД.ММ.ГГГГ ЧЧ:мм:сс или ISO",
    select: "название значения из справочника (точное совпадение)",
    multiselect: "названия через запятую",
    multiselectExtTable: "названия через запятую",
    multisel2area: "названия через запятую",
    multitext: "строки через запятую",
    reference: "построчно «название: значение»",
    yapoint: "lat,lng",
    questions: "не импортируется (JSON только для чтения)",
    surveys: "не импортируется (JSON только для чтения)",
    image: "не импортируется (имя файла только для чтения)",
    file: "не импортируется (имя файла только для чтения)",
    multiimage: "не импортируется (имена файлов только для чтения)",
    multifile: "не импортируется (имена файлов только для чтения)",
};
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const titleOf = (v) => isObj(v) ? String(v.title ?? v.id ?? "") : String(v ?? "");
const pad = (n) => String(n).padStart(2, "0");
function formatDate(item, code) {
    const original = item[`${code}_original`];
    if (typeof original !== "string" || !original.length)
        return typeof item[code] === "string" ? item[code] : "";
    const d = new Date(original);
    if (isNaN(d.getTime()))
        return "";
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function cell(item, field) {
    const v = item[field.code];
    switch (field.field_type) {
        case "checkbox": return v ? "Да" : "Нет";
        case "date": return formatDate(item, field.code);
        case "select": return v == null ? "" : titleOf(v);
        case "multiselect":
        case "multiselectExtTable":
        case "multisel2area":
            return Array.isArray(v) ? v.map(titleOf).join(", ") : "";
        case "multitext": return Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v.split("|||").join(", ") : "";
        case "reference": return Array.isArray(v) ? v.filter(isObj).map(p => `${p.title}: ${p.value}`).join("\n") : "";
        case "multiimage":
        case "multifile": return Array.isArray(v) ? v.join(",") : String(v ?? "");
        case "yapoint": return Array.isArray(v) ? v.join(",") : String(v ?? "");
        case "questions":
        case "surveys": return v == null ? "" : JSON.stringify(v);
        default: return v == null ? "" : String(v);
    }
}
export function csvColumns(fields) {
    return fields.map(f => ({ header: f.title, code: f.code, type: f.field_type, format: CSV_FORMAT[f.field_type] }));
}
//шапка без кавычек: парсер бэка (utils/parseCsv.ts) определяет разделитель по 3-му символу файла — ожидает "id;"
function headerLine(cells, delimiter) {
    return cells.map(c => /[";\n\r,]/.test(c) ? `"${c.replace(/"/g, "\"\"")}"` : c).join(delimiter);
}
//CSV контента в формате импорта: разделитель ";", шапка = title полей, первый столбец id, без BOM
export function buildItemsCsv(items, fields) {
    const header = headerLine(["id", ...fields.map(f => f.title)], ";");
    const rows = items.map(item => [String(item.id ?? ""), ...fields.map(f => cell(item, f))]);
    const body = Papa.unparse(rows, { delimiter: ";", newline: "\r\n", quotes: true });
    return `${header}\r\n${body}${body.length ? "\r\n" : ""}`;
}
//подготовка файла к импорту: снять BOM и невидимые символы, шапку привести к виду id;… (без кавычек у id), проверить первый столбец
export function prepareCsvForImport(raw) {
    const text = raw.toString("utf8").replace(/^﻿/, "").replace(/^[​-‍﻿]+/, "");
    const firstLineEnd = text.search(/\r?\n/);
    let firstLine = (firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)).replace(/[​-‍﻿]/g, "");
    const quotedId = /^"id"/.test(firstLine);
    const delimiter = (quotedId ? firstLine[4] : firstLine[2]) === ";" ? ";" : ",";
    const headers = (Papa.parse(firstLine, { delimiter }).data[0] ?? []).map(h => h.trim());
    if (headers[0] !== "id")
        throw new Error(`Первый столбец должен называться "id", сейчас "${headers[0] ?? ""}"`);
    firstLine = headerLine(headers, delimiter);
    return { text: firstLine + (firstLineEnd === -1 ? "" : text.slice(firstLineEnd)), headers };
}
