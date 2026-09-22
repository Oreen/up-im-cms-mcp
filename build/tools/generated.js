import fs from "node:fs/promises";
import { z } from "zod";
import { getProject } from "../core/auth.js";
import { ValidationError } from "../core/errors.js";
import { api, apiRaw, readImportSse, wireSet } from "../core/http.js";
import { listQuery, listResult } from "../core/lists.js";
import { getFields, getNode, getNodeParams } from "../core/schema.js";
import { defineTool, zDomain, zFilters, zNode, zPage, zPath, zPerPage, zSorter } from "./define.js";
const ALLOWED = ["id", "pub_date", "title", "menutitle", "code", "public", "blocked", "seo_block", "meta_title", "meta_description"];
//типы полей элементов, по которым бэк строит подборки (nodeGeneratorAdminController.importFile)
const FILTER_FIELD_TYPES = ["text", "textarea", "select", "multiselect", "multisel2area", "multiselectExtTable", "reference"];
const TEXT_KEYS = ["title", "menutitle", "code", "meta_title", "meta_description"];
const BOOL_KEYS = ["public", "blocked", "seo_block"];
//filters из БД → плоский вид {code: value}; reference-форма {code:[{title,value:[v]}]} → {"code__title": v}
function flatFilters(filters) {
    const out = {};
    for (const [code, value] of Object.entries(filters ?? {})) {
        if (Array.isArray(value)) {
            for (const entry of value) {
                if (entry && typeof entry === "object" && "title" in entry) {
                    const e = entry;
                    const v = Array.isArray(e.value) ? e.value[0] : e.value;
                    if (v !== undefined)
                        out[`${code}__${e.title}`] = v;
                }
            }
        }
        else if (typeof value === "string" || typeof value === "number") {
            out[code] = value;
        }
    }
    return out;
}
function view(g, nodeCode, baseUrl) {
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
    };
}
async function fetchOne(domain, node, id) {
    return api(domain, { path: `/admin/node/${node}/generator/${id}` });
}
export const generatedListTool = defineTool({
    name: "generated_list",
    description: "Подборки (виртуальные подразделы) раздела: SEO-страницы с фильтром по полям элементов. url = /<код раздела>/<код подборки>/.",
    input: { domain: zDomain, node: zNode, page: zPage, perPage: zPerPage, filters: zFilters, sorter: zSorter },
    readOnly: true,
    handler: async ({ domain, node, page, perPage, filters, sorter }) => {
        const n = await getNode(domain, node);
        const query = listQuery({ page, perPage, filters, sorter }, ALLOWED);
        query.all_fields = "";
        const data = await api(domain, { path: `/admin/node/${node}/generator`, query });
        return listResult(data, page, data.items.map(g => view(g, n.code, getProject(domain).baseUrl)));
    },
});
export const generatedGetTool = defineTool({
    name: "generated_get",
    description: "Одна подборка раздела: поля, filters (условия по полям элементов), params (переопределения параметров раздела).",
    input: { domain: zDomain, node: zNode, id: z.number().int().positive() },
    readOnly: true,
    handler: async ({ domain, node, id }) => view(await fetchOne(domain, node, id), (await getNode(domain, node)).code, getProject(domain).baseUrl),
});
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
        const n = await getNode(domain, node);
        const current = id ? await fetchOne(domain, node, id) : null;
        if (!current && !fields?.title)
            throw new ValidationError(["при создании обязателен fields.title"]);
        if (fields?.code !== undefined && fields.code !== "" && !/^[a-z0-9_-]{1,255}$/.test(fields.code))
            throw new ValidationError(["code: только a-z, 0-9, _ и -"]);
        const filterable = (await getFields(domain, n.type)).filter(f => FILTER_FIELD_TYPES.includes(f.field_type));
        const elementCodes = filterable.map(f => f.code);
        const paramCodes = ((await getNodeParams(domain, node)).node_param_fields ?? []).map(f => f.code);
        const mergedFilters = { ...flatFilters(current?.filters ?? {}) };
        for (const [key, value] of Object.entries(filters ?? {})) {
            const base = key.split("__")[0];
            if (!elementCodes.includes(base))
                throw new ValidationError([`filters: поле "${base}" не найдено или не подходит для подборки; доступны: ${elementCodes.join(", ")}`]);
            if (value === null)
                delete mergedFilters[key];
            else
                mergedFilters[key] = value;
        }
        if (Object.keys(mergedFilters).length > 6)
            throw new ValidationError(["подборка поддерживает не более 6 условий"]);
        const mergedParams = { ...(current?.paramsDisplay ?? {}) };
        for (const [key, value] of Object.entries(params ?? {})) {
            if (!paramCodes.includes(key))
                throw new ValidationError([`params: параметр "${key}" не найден; доступны: ${paramCodes.join(", ")}`]);
            if (value === null)
                delete mergedParams[key];
            else
                mergedParams[key] = value;
        }
        const wire = new Map();
        if (id)
            wireSet(wire, "id", String(id));
        for (const key of TEXT_KEYS)
            wireSet(wire, key, String(fields?.[key] ?? current?.[key] ?? ""));
        for (const key of BOOL_KEYS)
            wireSet(wire, key, (fields?.[key] ?? current?.[key] ?? (key === "public")) ? "true" : "false");
        Object.entries(mergedFilters).forEach(([key, value], i) => {
            wireSet(wire, `field_${i + 1}_name`, key);
            wireSet(wire, `field_${i + 1}_value`, String(value));
        });
        for (const [key, value] of Object.entries(mergedParams))
            wireSet(wire, `nodeParams[${key}]`, String(value ?? ""));
        const saved = await api(domain, { method: "POST", path: `/admin/node/${node}/generator/edit`, body: wire });
        return view(await fetchOne(domain, node, saved.id), n.code, getProject(domain).baseUrl);
    },
});
export const generatedCopyTool = defineTool({
    name: "generated_copy",
    description: "Скопировать подборку (копия не опубликована, code с постфиксом -copyN).",
    input: { domain: zDomain, node: zNode, id: z.number().int().positive() },
    handler: async ({ domain, node, id }) => {
        const saved = await api(domain, { method: "POST", path: `/admin/node/${node}/generator/copy`, body: new Map([["id", [String(id)]]]) });
        return view(await fetchOne(domain, node, saved.id), (await getNode(domain, node)).code, getProject(domain).baseUrl);
    },
});
export const generatedDeleteTool = defineTool({
    name: "generated_delete",
    description: "Удалить подборки (необратимо).",
    input: { domain: zDomain, node: zNode, ids: z.array(z.number().int().positive()).min(1) },
    destructive: true,
    handler: async ({ domain, node, ids }) => {
        await api(domain, { method: "POST", path: `/admin/node/${node}/generator/delete`, body: new Map([["ids[]", ids.map(String)]]) });
        return { deleted: ids };
    },
});
export const generatedImportCsvTool = defineTool({
    name: "generated_import_csv",
    description: "Загрузить CSV подборок: первый столбец id (пусто — создать); заголовки: Заголовок, Заголовок в SEO блоке, Мета заголовок, Мета описание, Отключен от генератора, Выводить в seo блок, Опубликован (Да/Нет), Код элемента, «Поле элементов N» + «Значение поля N» (N=1..6; поле — по названию из schema, только text/textarea/select/multiselect/reference; select — название значения), названия текстовых параметров раздела. Отсутствующие столбцы не затираются.",
    input: { domain: zDomain, node: zNode, path: zPath.describe("путь к .csv") },
    handler: async ({ domain, node, path }) => {
        const buffer = await fs.readFile(path);
        const wire = new Map([["file", [{ blob: new Blob([buffer], { type: "text/csv" }), name: "generated.csv" }]]]);
        const response = await apiRaw(domain, { method: "POST", path: `/admin/node/${node}/generator/import`, body: wire });
        return readImportSse(response);
    },
});
export const generatedTools = [generatedListTool, generatedGetTool, generatedSaveTool, generatedCopyTool, generatedDeleteTool, generatedImportCsvTool];
