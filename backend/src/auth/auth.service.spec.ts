import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test, TestingModule } from "@nestjs/testing";
import { AuthService } from "./auth.service";
import { ConfigService } from "src/config/config.service";
import { EmailService } from "src/email/email.service";
import { PrismaService } from "src/prisma/prisma.service";
import { OAuthService } from "../oauth/oauth.service";
import { UserSevice } from "../user/user.service";
import { LdapService } from "./ldap.service";

describe("AuthService", () => {
  let service: AuthService;
  let prisma: any;
  let jwtService: any;
  let config: any;
  let ldapService: any;

  beforeEach(async () => {
    const mockPrisma = {
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      loginToken: {
        create: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      refreshToken: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      resetPasswordToken: {
        create: jest.fn(),
        delete: jest.fn(),
      },
    };

    const mockJwtService = {
      sign: jest.fn().mockReturnValue("mock-jwt-token"),
      decode: jest.fn(),
      verifyAsync: jest.fn(),
    };

    const mockConfig = {
      get: jest.fn((key: string) => {
        const configMap: Record<string, any> = {
          "oauth.disablePassword": false,
          "ldap.enabled": false,
          "general.sessionDuration": { value: 30, unit: "days" },
          "internal.jwtSecret": "test-secret",
          "general.secureCookies": false,
          "share.allowRegistration": true,
          "oauth.ignoreTotp": false,
        };
        return configMap[key];
      }),
    };

    const mockLdapService = {
      authenticateUser: jest.fn(),
    };

    const mockEmailService = {
      sendResetPasswordEmail: jest.fn(),
    };

    const mockUserService = {
      findOrCreateFromLDAP: jest.fn(),
    };

    const mockOAuthService = {
      availableProviders: jest.fn().mockReturnValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EmailService, useValue: mockEmailService },
        { provide: LdapService, useValue: mockLdapService },
        { provide: UserSevice, useValue: mockUserService },
        { provide: OAuthService, useValue: mockOAuthService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get(PrismaService);
    jwtService = module.get(JwtService);
    config = module.get(ConfigService);
    ldapService = module.get(LdapService);
  });

  describe("verifyPassword", () => {
    it("should return true for correct local password", async () => {
      // argon2 hash of "correct-password"
      const argon2 = require("argon2");
      const hash = await argon2.hash("correct-password");
      const user = {
        id: "user-1",
        password: hash,
        username: "testuser",
        email: "test@example.com",
      } as any;

      const result = await service.verifyPassword(user, "correct-password");
      expect(result).toBe(true);
    });

    it("should return false for wrong local password", async () => {
      const argon2 = require("argon2");
      const hash = await argon2.hash("correct-password");
      const user = {
        id: "user-1",
        password: hash,
        username: "testuser",
        email: "test@example.com",
      } as any;

      const result = await service.verifyPassword(user, "wrong-password");
      expect(result).toBe(false);
    });

    it("should await LDAP authentication and return true on success", async () => {
      config.get.mockImplementation((key: string) => {
        if (key === "ldap.enabled") return true;
        return false;
      });

      ldapService.authenticateUser.mockResolvedValue({ dn: "cn=user" });

      const user = {
        id: "user-1",
        password: null, // LDAP users have no local password
        username: "ldapuser",
        email: "ldap@example.com",
      } as any;

      const result = await service.verifyPassword(user, "ldap-password");
      expect(ldapService.authenticateUser).toHaveBeenCalledWith(
        "ldapuser",
        "ldap-password",
      );
      expect(result).toBe(true);
    });

    it("should await LDAP authentication and return false on failure", async () => {
      config.get.mockImplementation((key: string) => {
        if (key === "ldap.enabled") return true;
        return false;
      });

      ldapService.authenticateUser.mockResolvedValue(null);

      const user = {
        id: "user-1",
        password: null,
        username: "ldapuser",
        email: "ldap@example.com",
      } as any;

      const result = await service.verifyPassword(user, "wrong-ldap-password");
      expect(ldapService.authenticateUser).toHaveBeenCalledWith(
        "ldapuser",
        "wrong-ldap-password",
      );
      expect(result).toBe(false);
    });

    it("should NOT return true when LDAP auth returns null (regression: Promise was treated as truthy)", async () => {
      // This test specifically guards against the bug where
      // !!Promise (without await) was always true
      config.get.mockImplementation((key: string) => {
        if (key === "ldap.enabled") return true;
        return false;
      });

      // Simulate LDAP auth returning null (authentication failure)
      ldapService.authenticateUser.mockResolvedValue(null);

      const user = {
        id: "user-1",
        password: null,
        username: "ldapuser",
        email: "ldap@example.com",
      } as any;

      const result = await service.verifyPassword(user, "any-password");
      // Before the fix, this would be true because !!Promise === true
      expect(result).toBe(false);
    });

    it("should return false for user with no password and LDAP disabled", async () => {
      config.get.mockImplementation((key: string) => {
        if (key === "ldap.enabled") return false;
        return false;
      });

      const user = {
        id: "user-1",
        password: null,
        username: "testuser",
        email: "test@example.com",
      } as any;

      const result = await service.verifyPassword(user, "any-password");
      expect(result).toBe(false);
    });
  });

  describe("generateToken", () => {
    it("should invalidate old login tokens before creating a new one", async () => {
      const user = {
        id: "user-1",
        totpVerified: true,
        email: "test@example.com",
      } as any;

      prisma.loginToken.updateMany.mockResolvedValue({ count: 2 });
      prisma.loginToken.create.mockResolvedValue({
        token: "new-login-token",
      });

      await service.generateToken(user);

      // Verify old tokens were invalidated BEFORE new token creation
      expect(prisma.loginToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", used: false },
        data: { used: true },
      });
      expect(prisma.loginToken.create).toHaveBeenCalled();
    });

    it("should return loginToken for TOTP-enabled users", async () => {
      const user = {
        id: "user-1",
        totpVerified: true,
        email: "test@example.com",
      } as any;

      prisma.loginToken.updateMany.mockResolvedValue({ count: 0 });
      prisma.loginToken.create.mockResolvedValue({
        token: "new-login-token",
      });

      const result = await service.generateToken(user);
      expect(result).toEqual({ loginToken: "new-login-token" });
      expect(result).not.toHaveProperty("accessToken");
      expect(result).not.toHaveProperty("refreshToken");
    });

    it("should return access/refresh tokens for non-TOTP users", async () => {
      const user = {
        id: "user-1",
        totpVerified: false,
        email: "test@example.com",
      } as any;

      prisma.loginToken.updateMany.mockResolvedValue({ count: 0 });
      prisma.refreshToken.create.mockResolvedValue({
        id: "refresh-id",
        token: "refresh-token",
      });

      const result = await service.generateToken(user);
      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
      expect(result).not.toHaveProperty("loginToken");
    });

    it("should skip TOTP when oauth.ignoreTotp is enabled", async () => {
      config.get.mockImplementation((key: string) => {
        if (key === "oauth.ignoreTotp") return true;
        if (key === "general.sessionDuration")
          return { value: 30, unit: "days" };
        if (key === "internal.jwtSecret") return "test-secret";
        return false;
      });

      const user = {
        id: "user-1",
        totpVerified: true,
        email: "test@example.com",
      } as any;

      prisma.loginToken.updateMany.mockResolvedValue({ count: 0 });
      prisma.refreshToken.create.mockResolvedValue({
        id: "refresh-id",
        token: "refresh-token",
      });

      const result = await service.generateToken(user, { idToken: "id-token" });
      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
    });
  });

  describe("updatePassword", () => {
    it("should reject LDAP users trying to change password", async () => {
      const user = {
        id: "user-1",
        password: null,
        ldapDN: "cn=user,dc=example,dc=com",
      } as any;

      await expect(
        service.updatePassword(user, "new-password", "old-password"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject when old password is wrong", async () => {
      const argon2 = require("argon2");
      const hash = await argon2.hash("correct-old-password");
      const user = {
        id: "user-1",
        password: hash,
        ldapDN: null,
      } as any;

      await expect(
        service.updatePassword(user, "new-password", "wrong-old-password"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should invalidate login tokens when password is changed", async () => {
      const argon2 = require("argon2");
      const hash = await argon2.hash("correct-old-password");
      const user = {
        id: "user-1",
        password: hash,
        ldapDN: null,
      } as any;

      prisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
      prisma.loginToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.update.mockResolvedValue({});
      prisma.refreshToken.create.mockResolvedValue({
        id: "new-refresh-id",
        token: "new-refresh-token",
      });

      await service.updatePassword(user, "new-password", "correct-old-password");

      expect(prisma.loginToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", used: false },
        data: { used: true },
      });
    });

    it("should reject when no old password is provided for local user", async () => {
      const user = {
        id: "user-1",
        password: "some-hash",
        ldapDN: null,
      } as any;

      await expect(
        service.updatePassword(user, "new-password"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("refreshAccessToken", () => {
    it("should throw UnauthorizedException for expired refresh token", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        expiresAt: new Date(Date.now() - 1000), // expired
        user: { id: "user-1" },
        id: "refresh-id",
      });

      await expect(
        service.refreshAccessToken("expired-token"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should throw UnauthorizedException for non-existent refresh token", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(
        service.refreshAccessToken("non-existent-token"),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
