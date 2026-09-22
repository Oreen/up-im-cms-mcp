import { ITEMS_PAGE_SIZE_DEFAULT } from "./config.js";
import { ValidationError } from "./errors.js";
//query для admin-списков (prepareAdminFilters): pagination[current], pagination[pageSize], sorter, filters[x][]
export function listQuery(args, allowed, defaultSorter = "id desc") {
    const problems = [];
    const filters = {};
    for (const [rawKey, value] of Object.entries(args.filters ?? {})) {
        const key = rawKey.replace(/^[!<>]/, "");
        if (!allowed.includes(key))
            problems.push(`фильтр по "${key}" недоступен; доступны: ${allowed.join(", ")}`);
        filters[rawKey] = Array.isArray(value) ? value : [value];
    }
    const sorter = args.sorter ?? defaultSorter;
    const m = /^(\S+)\s+(asc|desc)$/i.exec(sorter.trim());
    if (!m)
        problems.push(`sorter должен быть вида "поле asc|desc", получено "${sorter}"`);
    else if (!allowed.includes(m[1]))
        problems.push(`сортировка по "${m[1]}" недоступна; доступны: ${allowed.join(", ")}`);
    if (problems.length)
        throw new ValidationError(problems);
    return {
        pagination: { current: args.page ?? 1, pageSize: args.perPage ?? ITEMS_PAGE_SIZE_DEFAULT },
        sorter: `${m[1]} ${m[2].toLowerCase()}`,
        filters: Object.keys(filters).length ? filters : undefined,
    };
}
export function listResult(data, page, items) {
    const perPage = data.perPage || items.length || 1;
    return { total: data.totalItems, page: page ?? 1, perPage, pages: Math.ceil(data.totalItems / perPage), items };
}
