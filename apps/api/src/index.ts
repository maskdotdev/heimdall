import { createApiApp } from "./app";

const app = createApiApp().listen({ port: Number(process.env.PORT ?? 3000) });

console.log(`api listening on ${app.server?.hostname}:${app.server?.port}`);
