export class ApiError extends Error {
	status: number

	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

export class AuthRequiredError extends Error {
	domain: string

	constructor(domain: string, reason: string) {
		super(`Нет авторизации для ${domain}: ${reason}. Вызови login("${domain}")`)
		this.domain = domain
	}
}

export class ValidationError extends Error {
	problems: string[]

	constructor(problems: string[]) {
		super(problems.join("\n"))
		this.problems = problems
	}
}
