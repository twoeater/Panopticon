// Local UI fixture only. Never included in the Worker entry point.
import { createServer } from "node:http";
createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (value && !["host", "connection", "content-length"].includes(name))
        headers.set(name, Array.isArray(value) ? value.join(",") : value);
    headers.set("oai-authenticated-user-id", "local-qa");
    headers.set("oai-authenticated-user-email", "observer@example.test");
    headers.set("origin", "http://127.0.0.1:8787");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(`http://127.0.0.1:8787${req.url}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method || "")
        ? undefined
        : Buffer.concat(chunks),
      redirect: "manual",
    });
    res.statusCode = upstream.status;
    upstream.headers.forEach((v, k) => {
      if (
        !["content-encoding", "content-length", "transfer-encoding"].includes(k)
      )
        res.setHeader(k, v);
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(502);
    res.end("Local Worker unavailable");
  }
}).listen(8899, "127.0.0.1", () =>
  console.log("Local UI fixture: http://127.0.0.1:8899"),
);
