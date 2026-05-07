import { defineConfig } from "vite";

/** Default local admin gateway target for OAuth and assertion routes. */
const DEFAULT_ADMIN_GATEWAY_TARGET = "http://127.0.0.1:4318";

/** Returns the local admin gateway target used by Vite development proxy routes. */
const getAdminGatewayProxyTarget = (): string => {
  return process.env.VITE_HEIMDALL_ADMIN_GATEWAY_PROXY_TARGET ?? DEFAULT_ADMIN_GATEWAY_TARGET;
};

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
      "/auth": {
        target: getAdminGatewayProxyTarget(),
        changeOrigin: true,
      },
      "/heimdall": {
        target: getAdminGatewayProxyTarget(),
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: getPreviewAllowedHosts(),
  },
});
