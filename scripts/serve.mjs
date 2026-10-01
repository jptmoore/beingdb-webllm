// Local static server for the demo/eval pages: npm run serve (PORT=8010 by default).
import { startServer } from "./lib/server.mjs";

const port = Number(process.env.PORT || 8010);
await startServer(port);
console.log(`http://localhost:${port}/`);
