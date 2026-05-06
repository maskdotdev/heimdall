import { defineConfig } from "vite";

/**
 * Returns the hostnames that Vite preview may serve in deployed environments.
 */
const getPreviewAllowedHosts = (): string[] => {
  return [
    "appweb-production-b532.up.railway.app",
    ...(process.env.RAILWAY_PUBLIC_DOMAIN ? [process.env.RAILWAY_PUBLIC_DOMAIN] : []),
  ];
};

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
  preview: {
    allowedHosts: getPreviewAllowedHosts(),
  },
});
