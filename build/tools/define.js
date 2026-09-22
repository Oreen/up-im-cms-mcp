import { z } from "zod";
import { ApiError, AuthRequiredError, ValidationError } from "../core/errors.js";
export function defineTool(tool) {
    return tool;
}
export function formatError(error) {
    if (error instanceof ValidationError)
        return `Ошибка валидации:\n- ${error.problems.join("\n- ")}`;
    if (error instanceof AuthRequiredError)
        return error.message;
    if (error instanceof ApiError)
        return `Сервер ответил ${error.status}: ${error.message}`;
    if (error instanceof z.ZodError)
        return `Неверные аргументы: ${error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    return error.message ?? String(error);
}
export async function runTool(tool, rawArgs) {
    const args = z.object(tool.input).parse(rawArgs ?? {});
    return tool.handler(args);
}
//общие фрагменты схем
export const zDomain = z.string().describe("Домен проекта, напр. polis.online (см. projects)");
export const zNode = z.number().int().positive().describe("id раздела");
export const zPage = z.number().int().positive().optional().describe("Страница, с 1");
export const zPerPage = z.number().int().positive().max(1000).optional().describe("Элементов на страницу");
export const zFilterValue = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]);
export const zFilters = z.record(zFilterValue).optional().describe("Фильтры {поле: значение | [значения]}; разные ключи — И, массив значений — ИЛИ. Число — точное равенство; текст — вхождение подстроки, пробел разделяет слова (\"кресло офис\" = содержит оба); дата YYYY-MM-DD — точное совпадение. Префиксы ключа: \"!поле\" не равно, \">поле\" >=, \"<поле\" <=; диапазон — два ключа: {\">price\": 100, \"<price\": 500, \">pub_date\": \"2026-01-01\"}");
export const zSorter = z.string().optional().describe("Сортировка \"поле asc|desc\"");
export const zPath = z.string().describe("Путь к файлу на локальном диске");
