import { describe, expect, it } from "vitest";
import {
  actorCanAccessRepo,
  createAdminSessionManager,
  signAdminIdentityAssertion,
  verifyAdminIdentityAssertion,
  verifyCsrfToken,
} from "../src";

describe("admin security", () => {
  const assertionSecret = "assertion-secret-with-at-least-32-chars";
  const sessionSecret = "session-secret-with-at-least-32-chars";

  it("verifies signed identity assertions and derives provider-backed actors", () => {
    const signed = signAdminIdentityAssertion(
      {
        provider: "github_org",
        providerSubject: "12345",
        githubOrg: "octo-org",
        permissions: ["admin.inspect", "admin.settings.manage"],
        orgIds: ["org_1"],
      },
      assertionSecret,
      Date.now().toString(),
    );

    const actor = verifyAdminIdentityAssertion({
      assertionSecret,
      encodedAssertion: signed.encodedAssertion,
      expectedProvider: "github_org",
      requiredGithubOrg: "octo-org",
      signature: signed.signature,
      timestamp: signed.timestamp,
    });

    expect(actor).toMatchObject({
      actorType: "idp_user",
      actorUserId: "github_org:12345",
      role: "admin",
    });
    expect(actorCanAccessRepo(actor, "repo_1", "org_1")).toBe(true);
  });

  it("creates, reads, rotates, and clears secure sessions", () => {
    const manager = createAdminSessionManager({
      cookieName: "admin_session",
      maxAgeSeconds: 3600,
      secure: true,
      sessionSecret,
    });
    const created = manager.create({
      actorType: "idp_user",
      actorUserId: "oidc:usr_1",
      provider: "oidc",
      providerSubject: "usr_1",
      role: "support",
      permissions: ["admin.inspect"],
      orgIds: ["*"],
      repoIds: [],
    });
    const cookie = created.cookie.split(";")[0] ?? "";
    const read = manager.read(cookie);
    expect(read?.actor.actorUserId).toBe("oidc:usr_1");
    expect(read ? verifyCsrfToken(read, read.csrfToken) : false).toBe(true);

    const rotated = manager.rotate(created.session);
    expect(rotated.session.sessionId).toBe(created.session.sessionId);
    expect(rotated.session.csrfToken).not.toBe(created.session.csrfToken);
    expect(manager.clear()).toContain("Max-Age=0");
  });
});
