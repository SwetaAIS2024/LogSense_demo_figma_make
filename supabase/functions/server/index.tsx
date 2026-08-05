import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import * as kv from "./kv_store.tsx";
const app = new Hono();

// Enable logger
app.use('*', logger(console.log));

// Enable CORS for all routes and methods
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

// Health check endpoint
app.get("/make-server-637cd706/health", (c) => {
  return c.json({ status: "ok" });
});

// Custom agents — load
app.get("/make-server-637cd706/agents", async (c) => {
  const agents = await kv.get("custom_agents") ?? [];
  return c.json(agents);
});

// Custom agents — save
app.post("/make-server-637cd706/agents", async (c) => {
  const agents = await c.req.json();
  await kv.set("custom_agents", agents);
  return c.json({ ok: true });
});

Deno.serve(app.fetch);
