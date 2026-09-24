// Local static server for the demo/eval (any static server works, e.g.
// `python3 -m http.server`). The one extra: eval.html PUTs its report to
// /eval/results/<name>.json so runs can be re-scored in Node. Localhost only.
import http from "node:http";
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = path.join(root, "eval", "results");
const port = Number(process.env.PORT || 8010);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    if (rel.startsWith("..")) return res.writeHead(403).end();

    if (req.method === "PUT") {
      const name = rel.match(/^eval[/\\]results[/\\]([\w.-]+\.json)$/)?.[1];
      if (!name) return res.writeHead(403).end();
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > 50e6) req.destroy();
        else chunks.push(c);
      });
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        try {
          JSON.parse(body);
        } catch {
          return res.writeHead(400).end("not JSON");
        }
        mkdirSync(results, { recursive: true });
        writeFileSync(path.join(results, name), body);
        res.writeHead(201).end();
      });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();

    let file = path.join(root, rel || "index.html");
    try {
      if (statSync(file).isDirectory()) file = path.join(file, "index.html");
      statSync(file);
    } catch {
      return res.writeHead(404).end("not found");
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}/`));
