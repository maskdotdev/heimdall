import { Elysia } from "elysia";

const app = new Elysia()
  .get("/healthz", () => ({ ok: true, service: "api" }))
  .listen({ port: Number(process.env.PORT ?? 3000) });

console.log(`api listening on ${app.server?.hostname}:${app.server?.port}`);
