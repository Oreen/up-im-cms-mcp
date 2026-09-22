#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { formatError } from "./tools/define.js"
import { tools } from "./tools/index.js"

const server = new McpServer(
	{ name: "up-im-cms", version: "0.1.0" },
	{ instructions: "Администрирование сайтов на up-im CMS. Домен проекта обязателен в каждом вызове — список в projects. Перед правкой незнакомого раздела вызови schema. После сохранения проверяй результат по url из ответа." },
)

for (const tool of tools) {
	server.registerTool(
		tool.name,
		{
			description: tool.description,
			inputSchema: tool.input,
			annotations: { readOnlyHint: !!tool.readOnly, destructiveHint: !!tool.destructive },
		},
		async (args: Record<string, unknown>) => {
			try {
				const result = await tool.handler(args)
				return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
			} catch (error) {
				return { content: [{ type: "text" as const, text: formatError(error) }], isError: true }
			}
		},
	)
}

await server.connect(new StdioServerTransport())
