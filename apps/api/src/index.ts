import { createConsoleObservabilitySink } from "@repo/observability";
import { createApiApp } from "./app";

const app = createApiApp({
  adminObservabilitySink: createConsoleObservabilitySink(),
}).listen({
  hostname: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
});

console.log(`api listening on ${app.server?.hostname}:${app.server?.port}`);
