/**
 * Regression tests for the share access chain.
 *
 * These reproduce the failure modes that previously turned business errors
 * (invalid / deleted / removed / not-yet-completed shares, stale tokens,
 * the view-limit and password boundaries) into 500s or inconsistent error
 * codes. They run without a database by mocking just the Prisma + JWT
 * dependencies the read/token chain touches.
 *
 * Run with:
 *   node -r ts-node/register -r tsconfig-paths/register test/share.service.spec.ts
 * (exposed as `npm run test:unit`).
 */
import { test } from "node:test";
import * as assert from "node:assert";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ShareService } from "../src/share/share.service";

type AnyShare = Record<string, any> | null;

/**
 * Build a ShareService with only the dependencies the read/token chain uses.
 * `share` is what both `findUnique` and `findFirst` resolve to.
 */
function makeService(
  share: AnyShare,
  overrides: {
    findUnique?: () => Promise<AnyShare>;
    findFirst?: () => Promise<AnyShare>;
  } = {},
) {
  const prisma: any = {
    share: {
      findUnique: overrides.findUnique ?? (async () => share),
      findFirst: overrides.findFirst ?? (async () => share),
      update: async () => ({}),
    },
  };
  const config: any = {
    get: (key: string) =>
      key === "internal.jwtSecret" ? "test-secret" : undefined,
  };
  const jwt: any = { sign: () => "signed.jwt.token", verify: () => ({}) };
  const noop: any = {};

  // constructor order: prisma, configService, fileService, emailService,
  // config, jwtService, reverseShareService, clamScanService
  return new ShareService(prisma, config, noop, noop, config, jwt, noop, noop);
}

function completedShare(extra: Record<string, any> = {}) {
  return {
    id: "abc",
    uploadLocked: true,
    removedReason: null,
    views: 0,
    expiration: new Date(0),
    createdAt: new Date(0),
    security: null,
    files: [],
    ...extra,
  };
}

async function rejectsWith(
  fn: () => Promise<unknown>,
  ExpectedClass: any,
  errorCode?: string,
) {
  await assert.rejects(fn, (err: any) => {
    assert.ok(
      err instanceof ExpectedClass,
      `expected ${ExpectedClass.name}, got ${err?.constructor?.name}: ${err?.message}`,
    );
    if (errorCode !== undefined) {
      const res =
        typeof err.getResponse === "function" ? err.getResponse() : undefined;
      const actual =
        res && typeof res === "object" ? (res as any).error : undefined;
      assert.strictEqual(actual, errorCode);
    }
    return true;
  });
}

// ---- get() -----------------------------------------------------------------

test("get(): invalid / deleted shareId returns 404, never a 500", async () => {
  const service = makeService(null);
  await rejectsWith(() => service.get("missing"), NotFoundException);
});

test("get(): removed share reports the share_removed code", async () => {
  const service = makeService(
    completedShare({ removedReason: "Contains malware" }),
  );
  await rejectsWith(
    () => service.get("abc"),
    NotFoundException,
    "share_removed",
  );
});

test("get(): not-yet-completed share (upload not locked) returns 404", async () => {
  const service = makeService(completedShare({ uploadLocked: false }));
  await rejectsWith(() => service.get("abc"), NotFoundException);
});

test("get(): valid share resolves with the hasPassword flag", async () => {
  const service = makeService(
    completedShare({ security: { password: "hash" } }),
  );
  const result: any = await service.get("abc");
  assert.strictEqual(result.hasPassword, true);
});

// ---- getMetaData() ---------------------------------------------------------

test("getMetaData(): deleted share returns 404", async () => {
  const service = makeService(null);
  await rejectsWith(() => service.getMetaData("missing"), NotFoundException);
});

test("getMetaData(): removed share reports share_removed (consistent with get())", async () => {
  const service = makeService(
    completedShare({ removedReason: "Contains malware" }),
  );
  await rejectsWith(
    () => service.getMetaData("abc"),
    NotFoundException,
    "share_removed",
  );
});

// ---- getShareToken() -------------------------------------------------------

test("getShareToken(): deleted share returns 404 instead of throwing", async () => {
  const service = makeService(null);
  await rejectsWith(
    () => service.getShareToken("missing", ""),
    NotFoundException,
  );
});

test("getShareToken(): removed share reports share_removed", async () => {
  const service = makeService(
    completedShare({ removedReason: "Contains malware" }),
  );
  await rejectsWith(
    () => service.getShareToken("abc", ""),
    NotFoundException,
    "share_removed",
  );
});

test("getShareToken(): not-yet-completed share returns 404", async () => {
  const service = makeService(completedShare({ uploadLocked: false }));
  await rejectsWith(() => service.getShareToken("abc", ""), NotFoundException);
});

test("getShareToken(): password-protected share without a password is rejected", async () => {
  const service = makeService(
    completedShare({ security: { password: "hash" } }),
  );
  await rejectsWith(
    () => service.getShareToken("abc", ""),
    ForbiddenException,
    "share_password_required",
  );
});

test("getShareToken(): max-views boundary (views == maxViews) is enforced", async () => {
  const service = makeService(
    completedShare({ security: { maxViews: 3 }, views: 3 }),
  );
  await rejectsWith(
    () => service.getShareToken("abc", ""),
    ForbiddenException,
    "share_max_views_exceeded",
  );
});

test("getShareToken(): one view under the limit still issues a token", async () => {
  const service = makeService(
    completedShare({ security: { maxViews: 3 }, views: 2 }),
  );
  const token = await service.getShareToken("abc", "");
  assert.strictEqual(token, "signed.jwt.token");
});

// ---- generateShareToken() / verifyShareToken() -----------------------------

test("generateShareToken(): missing share throws 404 instead of destructuring null", async () => {
  const service = makeService(null);
  await rejectsWith(
    () => service.generateShareToken("missing"),
    NotFoundException,
  );
});

test("verifyShareToken(): stale token for a deleted share returns false, not a 500", async () => {
  const service = makeService(null);
  const ok = await service.verifyShareToken("missing", "some.old.token");
  assert.strictEqual(ok, false);
});
