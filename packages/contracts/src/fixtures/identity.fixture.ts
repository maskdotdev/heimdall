import type { ProviderInstallation } from "#contracts/identity/installation";
import type { Org } from "#contracts/identity/org";
import type { User } from "#contracts/identity/user";
import { ids, now } from "./common";

export const validOrgFixture = {
  orgId: ids.orgId,
  name: "Acme Engineering",
  slug: "acme-engineering",
  createdAt: now,
  updatedAt: now
} satisfies Org;

export const validUserFixture = {
  userId: ids.userId,
  primaryEmail: "reviewer@example.com",
  displayName: "Reviewer",
  avatarUrl: "https://example.com/avatar.png",
  createdAt: now,
  updatedAt: now
} satisfies User;

export const validProviderInstallationFixture = {
  installationId: ids.installationId,
  orgId: ids.orgId,
  provider: "github",
  providerInstallationId: "123456",
  accountLogin: "acme",
  accountType: "organization",
  permissions: {
    contents: "read",
    pullRequests: "write"
  },
  installedAt: now
} satisfies ProviderInstallation;
