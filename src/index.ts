import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { realSleep, systemClock } from "./clock.ts";
import { demoPosts, SimulatedProvider } from "./providers/simulated.ts";

const dbPath = process.env.DB_PATH ?? ":memory:";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const provider = new SimulatedProvider(demoPosts(), { pageSize: 3, validToken: "token-demo" });
const app = createApp({ db, clock: systemClock, sleep: realSleep, provider });

const port = Number(process.env.PORT ?? 3004);
serve({ fetch: app.fetch, port }, () => console.log(`conty-social-metrics-sync em http://localhost:${port}`));
