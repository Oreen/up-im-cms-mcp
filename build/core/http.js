import { baseHeaders, getAuthHeaders, getProject } from "./auth.js";
import { ApiError, AuthRequiredError } from "./errors.js";
//qs-совместимая сериализация: {filters:{title:["a"]}} → filters[title][]=a
function appendQuery(params, key, value) {
    if (value === undefined || value === null)
        return;
    if (Array.isArray(value)) {
        for (const v of value)
            appendQuery(params, `${key}[]`, v);
        return;
    }
    if (typeof value === "object") {
        for (const [k, v] of Object.entries(value))
            appendQuery(params, `${key}[${k}]`, v);
        return;
    }
    params.append(key, String(value));
}
export function buildQuery(query) {
    if (!query)
        return "";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
        appendQuery(params, key, value);
    const str = params.toString();
    return str ? `?${str}` : "";
}
export function wireSet(wire, key, ...parts) {
    wire.set(key, parts);
}
export function wireToFormData(wire) {
    const form = new FormData();
    for (const [key, parts] of wire) {
        for (const part of parts) {
            if (typeof part === "string") {
                form.append(key, part);
            }
            else {
                form.append(key, part.blob, part.name);
            }
        }
    }
    return form;
}
async function doFetch(domain, options, forceRefresh) {
    const project = getProject(domain);
    const headers = baseHeaders(project.baseUrl);
    if (options.auth !== false)
        Object.assign(headers, await getAuthHeaders(domain, forceRefresh));
    return fetch(`${project.baseUrl}/api${options.path}${buildQuery(options.query)}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body ? wireToFormData(options.body) : undefined,
    });
}
//запрос к бэку с автоматическим refresh при 401
export async function apiRaw(domain, options) {
    let response = await doFetch(domain, options, false);
    if (response.status === 401 && options.auth !== false) {
        response = await doFetch(domain, options, true);
        if (response.status === 401)
            throw new AuthRequiredError(domain, "сервер отклонил токены");
    }
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const body = await response.json();
            if (body.message)
                message = body.message;
        }
        catch { /* не JSON */ }
        throw new ApiError(response.status, message);
    }
    return response;
}
export async function api(domain, options) {
    const response = await apiRaw(domain, options);
    return await response.json();
}
export async function readImportSse(response) {
    const text = await response.text();
    let result = null;
    for (const chunk of text.split("\n\n")) {
        const line = chunk.trim();
        if (!line.startsWith("data:"))
            continue;
        const event = JSON.parse(line.slice(5).trim());
        if (event.error)
            throw new ApiError(400, event.error);
        if (event.done)
            result = { countTotal: event.countTotal ?? 0, countUpdate: event.countUpdate ?? 0, errors: event.errors ?? [] };
    }
    if (!result)
        throw new ApiError(500, "Импорт не вернул результат");
    return result;
}
