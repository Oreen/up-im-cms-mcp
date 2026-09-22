import { type iTool } from "./define.ts"
import { generatedTools } from "./generated.ts"
import { itemTools } from "./items.ts"
import { nodeTools } from "./nodes.ts"
import { loginTool, projectsTool } from "./projects.ts"
import { readonlyTools } from "./readonly.ts"
import { optionsTool, schemaTool, typesTool } from "./schema.ts"

export const tools: iTool[] = [
	projectsTool, loginTool,
	typesTool, schemaTool, optionsTool,
	...nodeTools,
	...itemTools,
	...generatedTools,
	...readonlyTools,
]
