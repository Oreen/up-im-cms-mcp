import { ACCESS_REFRESH_AHEAD_MS } from "./config.js";
import { ApiError, AuthRequiredError } from "./errors.js";
import { readProject, readTokens, withRefreshLock, writeProject, writeTokens } from "./store.js";
export function resolveBaseUrl(domain, baseUrl) {
    if (baseUrl)
        return baseUrl.replace(/\/+$/, "");
    const isLocal = /\.local$|^localhost(:\d+)?$|^127\.\d+\.\d+\.\d+(:\d+)?$/.test(domain);
    return `${isLocal ? "http" : "https"}://${domain}`;
}
export function isLoopback(baseUrl) {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host.startsWith("127.");
}
function jwtExp(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        return (payload.exp ?? 0) * 1000;
    }
    catch {
        return 0;
    }
}
function jwtUser(token) {
    try {
        return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    }
    catch {
        return { id: 0 };
    }
}
function parseSetCookies(response) {
    const result = {};
    for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0)
            result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return result;
}
export function baseHeaders(baseUrl) {
    const headers = { timestamp: String(Date.now()) };
    //без nginx (loopback-стенд) limitMiddleware требует x-real-ip; в проде nginx перезапишет
    if (isLoopback(baseUrl))
        headers["x-real-ip"] = "127.0.0.1";
    return headers;
}
async function tokensFromResponse(response) {
    const body = await response.json();
    if (!response.ok || !body.accessToken || !body.refreshToken) {
        throw new ApiError(response.status, body.message ?? "Сервер не вернул токены");
    }
    const cookies = parseSetCookies(response);
    if (!cookies.accessToken || !cookies.refreshToken) {
        throw new ApiError(response.status, "Сервер не вернул cookie-половины токенов");
    }
    return {
        accessToken: body.accessToken,
        accessTokenCookie: cookies.accessToken,
        refreshToken: body.refreshToken,
        refreshTokenCookie: cookies.refreshToken,
        accessExp: jwtExp(body.accessToken),
        refreshExp: jwtExp(body.refreshToken),
    };
}
export async function loginWithPassword(domain, baseUrl, email, password) {
    const form = new FormData();
    form.append("email", email);
    form.append("password", password);
    const response = await fetch(`${baseUrl}/api/user/login`, { method: "POST", body: form, headers: baseHeaders(baseUrl) });
    const tokens = await tokensFromResponse(response);
    const user = jwtUser(tokens.accessToken);
    const project = {
        domain,
        baseUrl,
        email,
        userId: user.id,
        userName: [user.firstname, user.lastname].filter(Boolean).join(" "),
        addedAt: readProject(domain)?.addedAt ?? new Date().toISOString(),
    };
    writeProject(project);
    writeTokens(domain, tokens);
    return project;
}
export function getProject(domain) {
    const project = readProject(domain);
    if (!project)
        throw new AuthRequiredError(domain, "проект не добавлен");
    return project;
}
function toAuthHeaders(tokens) {
    return {
        Authorization: `Bearer ${tokens.accessToken}`,
        Cookie: `accessToken=${tokens.accessTokenCookie}`,
    };
}
export async function refreshTokens(domain) {
    const project = getProject(domain);
    return withRefreshLock(async () => {
        //другой процесс мог обновить пару, пока мы ждали lock
        const current = readTokens(domain);
        if (!current)
            throw new AuthRequiredError(domain, "токены отсутствуют");
        if (current.accessExp - Date.now() > ACCESS_REFRESH_AHEAD_MS)
            return current;
        if (current.refreshExp <= Date.now()) {
            writeTokens(domain, null);
            throw new AuthRequiredError(domain, "refresh-токен истёк");
        }
        const form = new FormData();
        form.append("refreshToken", current.refreshToken);
        const response = await fetch(`${project.baseUrl}/api/user/refresh`, {
            method: "POST",
            body: form,
            headers: { ...baseHeaders(project.baseUrl), Cookie: `refreshToken=${current.refreshTokenCookie}` },
        });
        try {
            const fresh = await tokensFromResponse(response);
            writeTokens(domain, fresh);
            return fresh;
        }
        catch (error) {
            if (error instanceof ApiError && (error.status === 400 || error.status === 401)) {
                writeTokens(domain, null);
                throw new AuthRequiredError(domain, `refresh отклонён (${error.message})`);
            }
            throw error;
        }
    });
}
export async function getAuthHeaders(domain, forceRefresh = false) {
    const tokens = readTokens(domain);
    if (!tokens)
        throw new AuthRequiredError(domain, "нет сохранённых токенов");
    if (forceRefresh || tokens.accessExp - Date.now() < ACCESS_REFRESH_AHEAD_MS) {
        return toAuthHeaders(await refreshTokens(domain));
    }
    return toAuthHeaders(tokens);
}
export function authStatus(domain) {
    const tokens = readTokens(domain);
    if (!tokens)
        return "none";
    return tokens.refreshExp > Date.now() ? "ok" : "expired";
}
