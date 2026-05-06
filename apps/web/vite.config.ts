import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 3001,
    proxy: {
      "/admin": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
