import { createGitHubAdminGateway, readGitHubAdminGatewayConfig } from "./github-admin-gateway";

export {
  createGitHubAdminGateway,
  type GitHubAdminGateway,
  type GitHubAdminGatewayConfig,
  readGitHubAdminGatewayConfig,
} from "./github-admin-gateway";

if (import.meta.main) {
  const config = readGitHubAdminGatewayConfig();
  const gateway = createGitHubAdminGateway(config);
  const server = Bun.serve({
    fetch: gateway.handle,
    hostname: config.host,
    port: config.port,
  });

  console.log(
    `admin gateway listening on http://${server.hostname}:${server.port} for GitHub org ${config.githubOrg}`,
  );
}
