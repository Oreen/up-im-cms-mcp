//REST-обёртка над теми же тулами для отладки без перезапуска MCP-клиента:
//  GET  /tools            — список
//  POST /tools/:name      — JSON-аргументы → результат
import express from "express";
import { REST_PORT_DEFAULT } from "./core/config.js";
import { formatError, runTool } from "./tools/define.js";
import { tools } from "./tools/index.js";
const app = express();
app.use(express.json({ limit: "50mb" }));
app.get("/tools", (_req, res) => {
    res.json(tools.map(t => ({ name: t.name, description: t.description, readOnly: !!t.readOnly, destructive: !!t.destructive })));
});
app.post("/tools/:name", async (req, res) => {
    const tool = tools.find(t => t.name === req.params.name);
    if (!tool) {
        res.status(404).json({ error: `Нет тула ${req.params.name}` });
        return;
    }
    try {
        res.json({ ok: true, result: await runTool(tool, req.body) });
    }
    catch (error) {
        res.status(400).json({ ok: false, error: formatError(error) });
    }
});
const port = Number(process.env.UPIM_MCP_REST_PORT) || REST_PORT_DEFAULT;
app.listen(port, "127.0.0.1", () => console.log(`up-im MCP REST on http://127.0.0.1:${port}`));
