import { iTool } from "./define.js"
import { generatedTools } from "./generated.js"
import { itemTools } from "./items.js"
import { nodeTools } from "./nodes.js"
import { loginTool, projectsTool } from "./projects.js"
import { readonlyTools } from "./readonly.js"
import { optionsTool, schemaTool, typesTool } from "./schema.js"

export const tools: iTool[] = [
	projectsTool, loginTool,
	typesTool, schemaTool, optionsTool,
	...nodeTools,
	...itemTools,
	...generatedTools,
	...readonlyTools,
]
