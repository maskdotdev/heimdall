import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { oauthStates, orgMemberships, userProviderAccounts, userSessions, users } from "../schema";

/** Input used to create one product OAuth state row. */
export type CreateProductOAuthStateInput = {
  /** Durable OAuth state row ID. */
  readonly oauthStateId: string;
  /** Hashed opaque state token. */
  readonly stateHash: string;
  /** Safe post-login redirect path when present. */
  readonly redirectTo?: string | null | undefined;
  /** State expiration timestamp. */
  readonly expiresAt: Date | string;
  /** Product-safe state metadata. */
  readonly metadata: Readonly<Record<string, unknown>>;
};

/** Input used to consume one product OAuth state row. */
export type ConsumeProductOAuthStateInput = {
  /** Hashed opaque state token. */
  readonly stateHash: string;
  /** Timestamp recorded as the consumption time. */
  readonly consumedAt: Date | string;
  /** Lower expiration bound for valid states. */
  readonly expiresAfter: Date | string;
};

/** Consumed OAuth state row. */
export type ConsumedProductOAuthStateRecord = {
  /** Safe post-login redirect path when present. */
  readonly redirectTo: string | null;
};

/** Input used to look up one linked product identity provider account. */
export type GetProductProviderAccountInput = {
  /** External identity provider name. */
  readonly provider: string;
  /** Stable provider user ID. */
  readonly providerUserId: string;
};

/** Product identity provider account lookup result. */
export type ProductProviderAccountRecord = {
  /** Product user linked to the provider identity. */
  readonly userId: string;
};

/** Input used to upsert a product user and linked provider account. */
export type UpsertProductOAuthUserInput = {
  /** User ID to use when the provider identity is new. */
  readonly fallbackUserId: string;
  /** Provider account row ID to use when the provider identity is new. */
  readonly userProviderAccountId: string;
  /** External identity provider name. */
  readonly provider: string;
  /** Stable provider user ID. */
  readonly providerUserId: string;
  /** Provider login or username when known. */
  readonly providerLogin: string;
  /** Primary email when known. */
  readonly primaryEmail?: string | null | undefined;
  /** Display name when known. */
  readonly displayName?: string | null | undefined;
  /** Avatar URL when known. */
  readonly avatarUrl?: string | null | undefined;
  /** Product-safe user metadata. */
  readonly userMetadata: Readonly<Record<string, unknown>>;
  /** Product-safe provider-account metadata. */
  readonly providerMetadata: Readonly<Record<string, unknown>>;
  /** Timestamp used for conflict-update bookkeeping. */
  readonly updatedAt?: Date | string | undefined;
};

/** Input used to create one DB-backed product session. */
export type CreateProductSessionInput = {
  /** Durable session row ID. */
  readonly sessionId: string;
  /** Product user that owns the session. */
  readonly userId: string;
  /** Hashed opaque session token. */
  readonly sessionHash: string;
  /** Selected organization for product navigation when present. */
  readonly selectedOrgId?: string | null | undefined;
  /** Session expiration timestamp. */
  readonly expiresAt: Date | string;
  /** Product-safe session metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | null | undefined;
};

/** Input used to read one active DB-backed product session. */
export type GetActiveProductSessionInput = {
  /** Hashed opaque session token. */
  readonly sessionHash: string;
  /** Timestamp used to exclude expired sessions. */
  readonly now: Date | string;
};

/** Active product session row joined with user display fields. */
export type ActiveProductSessionRecord = {
  /** User avatar URL when present. */
  readonly avatarUrl: string | null;
  /** User display name when present. */
  readonly displayName: string | null;
  /** Session expiration timestamp. */
  readonly expiresAt: Date;
  /** User primary email when present. */
  readonly primaryEmail: string | null;
  /** Selected organization for product navigation when present. */
  readonly selectedOrgId: string | null;
  /** Durable session row ID. */
  readonly sessionId: string;
  /** Product user that owns the session. */
  readonly userId: string;
};

/** Product organization membership row. */
export type ProductMembershipRecord = {
  /** Organization ID. */
  readonly orgId: string;
  /** Persisted product role value. */
  readonly role: string;
};

/** Input used to revoke one DB-backed product session. */
export type RevokeProductSessionInput = {
  /** Durable session row ID. */
  readonly sessionId: string;
  /** Timestamp recorded as the revocation time. */
  readonly revokedAt?: Date | string | undefined;
};

/** Query helper for product OAuth identities and DB-backed sessions. */
export class ProductAuthRepository {
  /** Creates a product auth query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Creates one product OAuth state row. */
  public async createProductOAuthState(input: CreateProductOAuthStateInput): Promise<void> {
    await this.db.insert(oauthStates).values({
      expiresAt: new Date(input.expiresAt),
      metadata: input.metadata,
      oauthStateId: input.oauthStateId,
      redirectTo: input.redirectTo ?? null,
      stateHash: input.stateHash,
    });
  }

  /** Consumes one valid product OAuth state row exactly once. */
  public async consumeProductOAuthState(
    input: ConsumeProductOAuthStateInput,
  ): Promise<ConsumedProductOAuthStateRecord | undefined> {
    const [row] = await this.db
      .update(oauthStates)
      .set({ consumedAt: new Date(input.consumedAt) })
      .where(
        and(
          eq(oauthStates.stateHash, input.stateHash),
          isNull(oauthStates.consumedAt),
          gt(oauthStates.expiresAt, new Date(input.expiresAfter)),
        ),
      )
      .returning({
        redirectTo: oauthStates.redirectTo,
      });

    return row;
  }

  /** Gets the product user linked to one provider identity. */
  public async getProductProviderAccount(
    input: GetProductProviderAccountInput,
  ): Promise<ProductProviderAccountRecord | undefined> {
    const [row] = await this.db
      .select({
        userId: userProviderAccounts.userId,
      })
      .from(userProviderAccounts)
      .where(
        and(
          eq(userProviderAccounts.provider, input.provider),
          eq(userProviderAccounts.providerUserId, input.providerUserId),
        ),
      )
      .limit(1);

    return row;
  }

  /** Upserts a product user and provider account, preserving existing identity links. */
  public async upsertProductOAuthUser(input: UpsertProductOAuthUserInput): Promise<string> {
    const existingAccount = await this.getProductProviderAccount({
      provider: input.provider,
      providerUserId: input.providerUserId,
    });
    const userId = existingAccount?.userId ?? input.fallbackUserId;
    const updatedAt = new Date(input.updatedAt ?? Date.now());

    await this.db
      .insert(users)
      .values({
        avatarUrl: input.avatarUrl ?? null,
        displayName: input.displayName ?? null,
        metadata: input.userMetadata,
        primaryEmail: input.primaryEmail ?? null,
        userId,
      })
      .onConflictDoUpdate({
        target: users.userId,
        set: {
          avatarUrl: input.avatarUrl ?? null,
          displayName: input.displayName ?? null,
          metadata: input.userMetadata,
          primaryEmail: input.primaryEmail ?? null,
          updatedAt,
        },
      });

    await this.db
      .insert(userProviderAccounts)
      .values({
        email: input.primaryEmail ?? null,
        metadata: input.providerMetadata,
        provider: input.provider,
        providerLogin: input.providerLogin,
        providerUserId: input.providerUserId,
        userId,
        userProviderAccountId: input.userProviderAccountId,
      })
      .onConflictDoUpdate({
        target: [userProviderAccounts.provider, userProviderAccounts.providerUserId],
        set: {
          email: input.primaryEmail ?? null,
          metadata: input.providerMetadata,
          providerLogin: input.providerLogin,
          updatedAt,
          userId,
        },
      });

    return userId;
  }

  /** Creates one DB-backed product session. */
  public async createProductSession(input: CreateProductSessionInput): Promise<void> {
    await this.db.insert(userSessions).values({
      expiresAt: new Date(input.expiresAt),
      metadata: input.metadata ?? null,
      selectedOrgId: input.selectedOrgId ?? null,
      sessionHash: input.sessionHash,
      sessionId: input.sessionId,
      userId: input.userId,
    });
  }

  /** Gets one active DB-backed product session by token hash. */
  public async getActiveProductSessionByHash(
    input: GetActiveProductSessionInput,
  ): Promise<ActiveProductSessionRecord | undefined> {
    const [row] = await this.db
      .select({
        avatarUrl: users.avatarUrl,
        displayName: users.displayName,
        expiresAt: userSessions.expiresAt,
        primaryEmail: users.primaryEmail,
        selectedOrgId: userSessions.selectedOrgId,
        sessionId: userSessions.sessionId,
        userId: users.userId,
      })
      .from(userSessions)
      .innerJoin(users, eq(users.userId, userSessions.userId))
      .where(
        and(
          eq(userSessions.sessionHash, input.sessionHash),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, new Date(input.now)),
        ),
      )
      .limit(1);

    return row;
  }

  /** Lists organization memberships for one product user. */
  public async listProductMemberships(userId: string): Promise<readonly ProductMembershipRecord[]> {
    return this.db
      .select({
        orgId: orgMemberships.orgId,
        role: orgMemberships.role,
      })
      .from(orgMemberships)
      .where(eq(orgMemberships.userId, userId))
      .orderBy(asc(orgMemberships.orgId));
  }

  /** Revokes one DB-backed product session. */
  public async revokeProductSession(input: RevokeProductSessionInput): Promise<void> {
    const revokedAt = new Date(input.revokedAt ?? Date.now());
    await this.db
      .update(userSessions)
      .set({
        revokedAt,
        updatedAt: revokedAt,
      })
      .where(eq(userSessions.sessionId, input.sessionId));
  }

  /** Returns a product user ID only when it exists locally. */
  public async getExistingProductUserId(userId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ userId: users.userId })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);
    return row?.userId;
  }
}
