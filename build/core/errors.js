export class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
export class AuthRequiredError extends Error {
    domain;
    constructor(domain, reason) {
        super(`Нет авторизации для ${domain}: ${reason}. Вызови login("${domain}")`);
        this.domain = domain;
    }
}
export class ValidationError extends Error {
    problems;
    constructor(problems) {
        super(problems.join("\n"));
        this.problems = problems;
    }
}
