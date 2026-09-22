import { SCHEMA_CACHE_MS } from "./config.js";
import { api } from "./http.js";
export const SELECT_TYPES = ["select", "multiselect", "multiselectExtTable", "multisel2area"];
export const MULTI_ID_TYPES = ["multiselect", "multiselectExtTable", "multisel2area"];
export const FILE_TYPES = ["image", "file", "multiimage", "multifile"];
export const MULTI_FILE_TYPES = ["multiimage", "multifile"];
//что агент передаёт в fields[code] — единый формат для item_save / node_save.params / item_set_field
export const INPUT_HINT = {
    text: "string",
    alias: "string, только [a-z0-9_-]; пусто → сгенерируется из title",
    textarea: "string HTML; картинки можно вставить как <img src=\"data:image/...;base64,...\"> — сервер сохранит их в /upload/",
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
};
//что умеет WYSIWYG-редактор (TinyMCE + плагин upcmssnippet в админке): агент может писать этот HTML напрямую
export const EDITOR_HINT = [
    "Медиа внутри HTML: <img src=\"data:image/…;base64,…\">, <video><source src=\"data:video/mp4;base64,…\"></video>, <a href=\"file:<ext>;base64,…\" download=\"имя.ext\">файл</a> — сервер сохранит в /upload/ и подставит ссылки.",
    "Сниппеты (блоки, которые рендерит фронт сайта): <div class=\"slider\"><img src=\"/upload/…\">…</div> — слайдер из картинок; <div class=\"banner\"></div>; <div class=\"feedback\"></div> — форма заявки; <div class=\"feedback_button\">Текст кнопки</div>; <div class=\"subscribe\"></div> — форма подписки; <div class=\"telegram\"></div>.",
    "Аккордеон: <details class=\"mce-accordion\"><summary class=\"mce-accordion-summary\">Заголовок</summary><div class=\"mce-accordion-body\"><p>…</p></div></details>.",
    "Разрешён <noindex>. Набор сниппетов и их вид зависят от конкретного сайта — при сомнении посмотри HTML существующего элемента через item.",
].join(" ");
const cache = new Map();
export async function getFields(domain, type) {
    const key = `${domain}|${type}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < SCHEMA_CACHE_MS)
        return hit.fields;
    const fields = await api(domain, { path: `/admin/module/${encodeURIComponent(type)}/fields` });
    cache.set(key, { at: Date.now(), fields });
    return fields;
}
export async function getNode(domain, nodeId) {
    return api(domain, { path: `/admin/node/${nodeId}` });
}
export async function getNodeParams(domain, nodeId) {
    return api(domain, { path: `/admin/node/${nodeId}/params` });
}
export async function getNodeTypes(domain) {
    return api(domain, { path: "/admin/module" });
}
export async function getOptions(domain, kind, fieldId, search, ids) {
    const data = await api(domain, {
        path: `/admin/module/${fieldId}/${kind}/options`,
        query: { title: search && search.length >= 2 ? search : undefined, ids },
    });
    return data.items;
}
export function describeField(field) {
    const out = { code: field.code, title: field.title, type: field.field_type, input: INPUT_HINT[field.field_type] };
    if (field.required)
        out.required = true;
    if (field.editor && field.field_type === "textarea") {
        out.html_editor = true;
        out.editor_hint = EDITOR_HINT;
    }
    if (field.table_data && SELECT_TYPES.includes(field.field_type))
        out.options_from = field.table_data;
    if (field.tooltip)
        out.tooltip = field.tooltip;
    return out;
}
export function findField(fields, code) {
    return fields.find(f => f.code === code);
}
export function isSelectTypeField(field) {
    return SELECT_TYPES.includes(field.field_type) && field.table_data.length > 0;
}
