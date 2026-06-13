import { ForbiddenException } from "@nestjs/common";
import * as argon from "argon2";

// The collaborators are only needed for dependency injection metadata and are
// replaced with hand-built mocks in each test, so stub the modules to avoid
// pulling their (heavy) real dependency graphs into the test run.
jest.mock("src/config/config.service", () => ({
  ConfigService: class ConfigService {},
}));
jest.mock("src/prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));
jest.mock("src/email/email.service", () => ({
  EmailService: class EmailService {},
}));
jest.mock("../oauth/oauth.service", () => ({
  OAuthService: class OAuthService {},
}));
jest.mock("../oauth/provider/genericOidc.provider", () => ({
  GenericOidcProvider: class GenericOidcProvider {},
}));
jest.mock("../user/user.service", () => ({
  UserSevice: class UserSevice {},
}));
jest.mock("./ldap.service", () => ({
  LdapService: class LdapService {},
}));

import { AuthService } from "./auth.service";

const buildPrismaMock = () => ({
  loginToken: {
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest.fn().mockResolvedValue({ token: "new-login-token" }),
  },
  refreshToken: {
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest
      .fn()
      .mockResolvedValue({ id: "refresh-id", token: "refresh-token" }),
  },
  user: {
    update: jest.fn().mockResolvedValue({}),
    findFirst: jest.fn(),
  },
  resetPasswordToken: {
    delete: jest.fn().mockResolvedValue({}),
  },
});

const buildService = (overrides?: {
  prisma?: any;
  config?: any;
  ldap?: any;
  jwt?: any;
}) => {
  const prisma = overrides?.prisma ?? buildPrismaMock();
  const config = overrides?.config ?? {
    get: jest.fn((key: string) =>
      key === "general.sessionDuration"
        ? { value: 3, unit: "months" }
        : undefined,
    ),
  };
  const ldap = overrides?.ldap ?? { authenticateUser: jest.fn() };
  const jwt = overrides?.jwt ?? { sign: jest.fn().mockReturnValue("access") };
  const email = {} as any;
  const userService = {} as any;
  const oauth = {} as any;

  const service = new AuthService(
    prisma,
    jwt,
    config,
    email,
    ldap,
    userService,
    oauth,
  );

  return { service, prisma, config, ldap, jwt };
};

describe("AuthService.verifyPassword", () => {
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await argon.hash("correct horse");
  });

  it("returns true for a matching local password", async () => {
    const { service } = buildService();
    const user = { password: passwordHash } as any;

    await expect(service.verifyPassword(user, "correct horse")).resolves.toBe(
      true,
    );
  });

  it("returns false for a wrong local password", async () => {
    const { service } = buildService();
    const user = { password: passwordHash } as any;

    await expect(service.verifyPassword(user, "wrong")).resolves.toBe(false);
  });

  it("awaits the LDAP check and returns true only when LDAP authenticates", async () => {
    const ldap = {
      authenticateUser: jest.fn().mockResolvedValue({ dn: "cn=jdoe" }),
    };
    const config = { get: jest.fn().mockReturnValue(true) }; // ldap.enabled
    const { service } = buildService({ ldap, config });
    const user = { password: null, username: "jdoe" } as any;

    await expect(service.verifyPassword(user, "secret")).resolves.toBe(true);
    expect(ldap.authenticateUser).toHaveBeenCalledWith("jdoe", "secret");
  });

  it("returns false when the LDAP check rejects the credentials (Promise must be awaited)", async () => {
    // Regression guard: the old `!!this.ldapService.authenticateUser(...)`
    // returned the truthy Promise, so any password was accepted.
    const ldap = {
      authenticateUser: jest.fn().mockResolvedValue(null),
    };
    const config = { get: jest.fn().mockReturnValue(true) }; // ldap.enabled
    const { service } = buildService({ ldap, config });
    const user = { password: null, username: "jdoe" } as any;

    await expect(service.verifyPassword(user, "whatever")).resolves.toBe(false);
  });

  it("returns false for a password-less account when LDAP is disabled", async () => {
    const config = { get: jest.fn().mockReturnValue(false) }; // ldap.enabled
    const ldap = { authenticateUser: jest.fn() };
    const { service } = buildService({ ldap, config });
    const user = { password: null, username: "oauth-only" } as any;

    await expect(service.verifyPassword(user, "anything")).resolves.toBe(false);
    expect(ldap.authenticateUser).not.toHaveBeenCalled();
  });
});

describe("AuthService login-token invalidation", () => {
  it("deletes existing login tokens before creating a new one", async () => {
    const { service, prisma } = buildService();

    const token = await service.createLoginToken("user-1");

    expect(prisma.loginToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.loginToken.create).toHaveBeenCalled();
    expect(token).toBe("new-login-token");
    // Old tokens must be removed *before* the new one is created.
    expect(
      prisma.loginToken.deleteMany.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.loginToken.create.mock.invocationCallOrder[0]);
  });

  it("revokes refresh and login tokens when the password is updated", async () => {
    const { service, prisma } = buildService();
    const user = { id: "user-1", password: await argon.hash("old") } as any;

    await service.updatePassword(user, "newpass", "old");

    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.loginToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });

  it("rejects updatePassword when the old password is wrong", async () => {
    const { service, prisma } = buildService();
    const user = { id: "user-1", password: await argon.hash("old") } as any;

    await expect(
      service.updatePassword(user, "newpass", "wrong"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("revokes sessions and login tokens on password reset", async () => {
    const prisma = buildPrismaMock();
    prisma.user.findFirst.mockResolvedValue({ id: "user-1" });
    const config = { get: jest.fn().mockReturnValue(false) }; // disablePassword
    const { service } = buildService({ prisma, config });

    await service.resetPassword("reset-token", "newpass");

    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.loginToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });
});

describe("AuthService.generateToken", () => {
  it("issues a login token (not a session) when TOTP is verified", async () => {
    const { service, prisma } = buildService();
    const user = { id: "user-1", totpVerified: true } as any;

    const result = await service.generateToken(user);

    expect(result).toEqual({ loginToken: "new-login-token" });
    // The login-token path must invalidate older tokens too.
    expect(prisma.loginToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it("issues access and refresh tokens when TOTP is not verified", async () => {
    const { service } = buildService();
    const user = { id: "user-1", totpVerified: false } as any;

    const result = await service.generateToken(user);

    expect(result).toEqual({
      accessToken: "access",
      refreshToken: "refresh-token",
    });
  });
});
