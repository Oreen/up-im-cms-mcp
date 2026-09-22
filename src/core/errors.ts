export class ApiError extends Error {
	constructor(public status: number, message: string) {
		super(message)
	}
}

export class AuthRequiredError extends Error {
	constructor(public domain: string, reason: string) {
		super(`Нет авторизации для ${domain}: ${reason}. Вызови login("${domain}")`)
	}
}

export class ValidationError extends Error {
	constructor(public problems: string[]) {
		super(problems.join("\n"))
	}
}
