import { createApp } from "./src/app.js";
import { defaultDbPath } from "./src/db.js";

const port = Number(process.env.PORT || 3040);
const server = createApp(process.env.DB_PATH || defaultDbPath);
server.listen(port, () => console.log("古法蓝晒底片整理室 listening on http://localhost:" + port));
