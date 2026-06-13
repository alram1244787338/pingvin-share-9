import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { AuthTotpService } from "./authTotp.service";
import { AuthService } from "./auth.service";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";

describe("AuthTotpService", () => {
  let service: AuthTotpService;
  let prisma: any;
  let authService: any;

  beforeEach(async () => {
    const mockPrisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      loginToken: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };

    const mockAuthService = {
      verifyPassword: jest.fn(),
      createRefreshToken: jest.fn(),
      createAccessToken: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === "general.appName") return "TestApp";
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthTotpService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<AuthTotpService>(AuthTotpService);
    prisma = module.get(PrismaService);
    authService = module.get(AuthService);
  });

  // Helper to check both exception type and error code
  async function expectException(
    promise: Promise<any>,
    ExceptionClass: any,
    errorCode: string,
  ) {
    try {
      await promise;
      throw new Error(`Expected ${ExceptionClass.name} but no exception thrown`);
    } catch (e: any) {
      expect(e).toBeInstanceOf(ExceptionClass);
      const response = e.getResponse();
      // NestJS 2-arg constructor: { message: string, error: string, statusCode: number }
      // The "error" field is the 2nd constructor arg (machine-readable code)
      if (typeof response === "object" && response.error) {
        expect(response.error).toBe(errorCode);
      }
    }
  }

  describe("signInTotp", () => {
    const validUser = {
      id: "user-1",
      email: "test@example.com",
      username: "testuser",
      password: "hash",
      isAdmin: false,
      totpEnabled: true,
      totpVerified: true,
      totpSecret: "JBSWY3DPEHPK3PXP", // valid base32 secret
      ldapDN: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("should throw token_invalid for non-existent login token", async () => {
      prisma.loginToken.findFirst.mockResolvedValue(null);

      await expectException(
        service.signInTotp({ totp: "123456", loginToken: "bad-token" }),
        UnauthorizedException,
        "token_invalid",
      );
    });

    it("should throw token_invalid for already-used login token", async () => {
      prisma.loginToken.findFirst.mockResolvedValue({
        token: "used-token",
        used: true,
        expiresAt: new Date(Date.now() + 60000),
        user: validUser,
      });

      await expectException(
        service.signInTotp({ totp: "123456", loginToken: "used-token" }),
        UnauthorizedException,
        "token_invalid",
      );
    });

    it("should throw token_expired for expired login token", async () => {
      prisma.loginToken.findFirst.mockResolvedValue({
        token: "expired-token",
        used: false,
        expiresAt: new Date(Date.now() - 60000), // expired
        user: validUser,
      });

      await expectException(
        service.signInTotp({ totp: "123456", loginToken: "expired-token" }),
        UnauthorizedException,
        "token_expired",
      );
    });

    it("should throw totp_disabled when TOTP was disabled after token creation", async () => {
      prisma.loginToken.findFirst.mockResolvedValue({
        token: "stale-token",
        used: false,
        expiresAt: new Date(Date.now() + 60000),
        user: validUser,
      });

      // User has since disabled TOTP
      const userWithTotpDisabled = {
        ...validUser,
        totpEnabled: false,
        totpVerified: false,
        totpSecret: null,
      };
      prisma.user.findUnique.mockResolvedValue(userWithTotpDisabled);
      prisma.loginToken.update.mockResolvedValue({});

      await expectException(
        service.signInTotp({ totp: "123456", loginToken: "stale-token" }),
        UnauthorizedException,
        "totp_disabled",
      );

      // Verify the stale token was consumed
      expect(prisma.loginToken.update).toHaveBeenCalledWith({
        where: { token: "stale-token" },
        data: { used: true },
      });
    });

    it("should throw totp_disabled when totpSecret is null despite totpVerified", async () => {
      prisma.loginToken.findFirst.mockResolvedValue({
        token: "weird-token",
        used: false,
        expiresAt: new Date(Date.now() + 60000),
        user: validUser,
      });

      // Inconsistent state: verified but secret is null
      const inconsistentUser = {
        ...validUser,
        totpEnabled: true,
        totpVerified: true,
        totpSecret: null,
      };
      prisma.user.findUnique.mockResolvedValue(inconsistentUser);
      prisma.loginToken.update.mockResolvedValue({});

      await expectException(
        service.signInTotp({ totp: "123456", loginToken: "weird-token" }),
        UnauthorizedException,
        "totp_disabled",
      );
    });

    it("should throw totp_invalid for wrong TOTP code", async () => {
      prisma.loginToken.findFirst.mockResolvedValue({
        token: "valid-token",
        used: false,
        expiresAt: new Date(Date.now() + 60000),
        user: validUser,
      });
      prisma.user.findUnique.mockResolvedValue(validUser);

      await expectException(
        service.signInTotp({ totp: "000000", loginToken: "valid-token" }),
        UnauthorizedException,
        "totp_invalid",
      );
    });

    it("should issue tokens for valid TOTP code and mark token as used", async () => {
      const { authenticator } = require("otplib");
      const validCode = authenticator.generate(validUser.totpSecret);

      prisma.loginToken.findFirst.mockResolvedValue({
        token: "valid-token",
        used: false,
        expiresAt: new Date(Date.now() + 60000),
        user: validUser,
      });
      prisma.user.findUnique.mockResolvedValue(validUser);
      prisma.loginToken.update.mockResolvedValue({});
      authService.createRefreshToken.mockResolvedValue({
        refreshTokenId: "refresh-id",
        refreshToken: "refresh-token",
      });
      authService.createAccessToken.mockResolvedValue("access-token");

      const result = await service.signInTotp({
        totp: validCode,
        loginToken: "valid-token",
      });

      expect(result).toEqual({
        accessToken: "access-token",
        refreshToken: "refresh-token",
      });

      // Token should be marked as used
      expect(prisma.loginToken.update).toHaveBeenCalledWith({
        where: { token: "valid-token" },
        data: { used: true },
      });
    });

    it("should re-fetch user from DB to check current TOTP state", async () => {
      prisma.loginToken.findFirst.mockResolvedValue({
        token: "valid-token",
        used: false,
        expiresAt: new Date(Date.now() + 60000),
        user: validUser,
      });
      prisma.user.findUnique.mockResolvedValue(validUser);

      const { authenticator } = require("otplib");
      const validCode = authenticator.generate(validUser.totpSecret);

      authService.createRefreshToken.mockResolvedValue({
        refreshTokenId: "refresh-id",
        refreshToken: "refresh-token",
      });
      authService.createAccessToken.mockResolvedValue("access-token");
      prisma.loginToken.update.mockResolvedValue({});

      await service.signInTotp({
        totp: validCode,
        loginToken: "valid-token",
      });

      // Ensure user was re-fetched from DB (not just using token.user)
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-1" },
      });
    });

    it("should throw token_invalid when user was deleted after token creation", async () => {
      prisma.loginToken.findFirst.mockResolvedValue({
        token: "orphan-token",
        used: false,
        expiresAt: new Date(Date.now() + 60000),
        user: validUser,
      });
      // User no longer exists
      prisma.user.findUnique.mockResolvedValue(null);

      await expectException(
        service.signInTotp({ totp: "123456", loginToken: "orphan-token" }),
        UnauthorizedException,
        "token_invalid",
      );
    });
  });

  describe("enableTotp", () => {
    const localUser = {
      id: "user-1",
      email: "test@example.com",
      username: "testuser",
      password: "hash",
      isAdmin: false,
      totpEnabled: false,
      totpVerified: false,
      totpSecret: null,
      ldapDN: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("should throw ForbiddenException for wrong password", async () => {
      authService.verifyPassword.mockResolvedValue(false);

      await expectException(
        service.enableTotp(localUser, "wrong-password"),
        ForbiddenException,
        "password_invalid",
      );
    });

    it("should throw BadRequestException if TOTP is already enabled", async () => {
      authService.verifyPassword.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValue({ totpVerified: true });

      await expectException(
        service.enableTotp(localUser, "correct-password"),
        BadRequestException,
        "totp_already_enabled",
      );
    });

    it("should generate TOTP secret and QR code on success", async () => {
      authService.verifyPassword.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValue({ totpVerified: false });
      prisma.user.update.mockResolvedValue({});

      const result = await service.enableTotp(localUser, "correct-password");

      expect(result).toHaveProperty("totpAuthUrl");
      expect(result).toHaveProperty("totpSecret");
      expect(result).toHaveProperty("qrCode");
      expect(result.qrCode).toContain("data:image/svg+xml;base64,");
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-1" },
          data: expect.objectContaining({
            totpEnabled: true,
            totpSecret: expect.any(String),
          }),
        }),
      );
    });

    it("should properly await password verification (regression test)", async () => {
      // This test guards against the bug where verifyPassword was not awaited.
      // If verifyPassword returns a Promise (which is truthy), the old code
      // would NOT throw ForbiddenException, allowing access with any password.
      authService.verifyPassword.mockResolvedValue(false);

      await expect(
        service.enableTotp(localUser, "any-password"),
      ).rejects.toThrow(ForbiddenException);

      // Ensure verifyPassword was actually called and awaited
      expect(authService.verifyPassword).toHaveBeenCalledWith(
        localUser,
        "any-password",
      );
    });

    it("should work for LDAP user with correct LDAP password", async () => {
      const ldapUser = {
        ...localUser,
        password: null,
        ldapDN: "cn=user,dc=example,dc=com",
      };

      // Simulates LDAP auth succeeding
      authService.verifyPassword.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValue({ totpVerified: false });
      prisma.user.update.mockResolvedValue({});

      const result = await service.enableTotp(ldapUser, "ldap-password");
      expect(result).toHaveProperty("totpSecret");
      expect(authService.verifyPassword).toHaveBeenCalledWith(
        ldapUser,
        "ldap-password",
      );
    });
  });

  describe("verifyTotp", () => {
    const userWithPendingTotp = {
      id: "user-1",
      email: "test@example.com",
      username: "testuser",
      password: "hash",
      isAdmin: false,
      totpEnabled: true,
      totpVerified: false,
      totpSecret: "JBSWY3DPEHPK3PXP",
      ldapDN: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("should throw ForbiddenException for wrong password", async () => {
      authService.verifyPassword.mockResolvedValue(false);

      await expectException(
        service.verifyTotp(userWithPendingTotp, "wrong-password", "123456"),
        ForbiddenException,
        "password_invalid",
      );
    });

    it("should throw BadRequestException if no TOTP secret exists", async () => {
      authService.verifyPassword.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValue({ totpSecret: null });

      await expectException(
        service.verifyTotp(userWithPendingTotp, "correct-password", "123456"),
        BadRequestException,
        "totp_not_in_progress",
      );
    });

    it("should throw BadRequestException for wrong TOTP code", async () => {
      authService.verifyPassword.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValue({
        totpSecret: userWithPendingTotp.totpSecret,
      });

      await expectException(
        service.verifyTotp(userWithPendingTotp, "correct-password", "000000"),
        BadRequestException,
        "totp_invalid",
      );
    });

    it("should mark TOTP as verified with correct code", async () => {
      const { authenticator } = require("otplib");
      const validCode = authenticator.generate(
        userWithPendingTotp.totpSecret,
      );

      authService.verifyPassword.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValue({
        totpSecret: userWithPendingTotp.totpSecret,
      });
      prisma.user.update.mockResolvedValue({});

      const result = await service.verifyTotp(
        userWithPendingTotp,
        "correct-password",
        validCode,
      );

      expect(result).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { totpVerified: true },
      });
    });
  });

  describe("disableTotp", () => {
    const userWithTotp = {
      id: "user-1",
      email: "test@example.com",
      username: "testuser",
      password: "hash",
      isAdmin: false,
      totpEnabled: true,
      totpVerified: true,
      totpSecret: "JBSWY3DPEHPK3PXP",
      ldapDN: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("should throw ForbiddenException for wrong password", async () => {
      authService.verifyPassword.mockResolvedValue(false);

      await expectException(
        service.disableTotp(userWithTotp, "wrong-password", "123456"),
        ForbiddenException,
        "password_invalid",
      );
    });

    it("should throw BadRequestException if TOTP is not enabled", async () => {
      authService.verifyPassword.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValue({ totpSecret: null });

      await expectException(
        service.disableTotp(userWithTotp, "correct-password", "123456"),
        BadRequestException,
        "totp_not_enabled",
      );
    });

    it("should throw BadRequestException for wrong TOTP code", async () => {
      authService.verifyPassword.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValue({
        totpSecret: userWithTotp.totpSecret,
      });

      await expectException(
        service.disableTotp(userWithTotp, "correct-password", "000000"),
        BadRequestException,
        "totp_invalid",
      );
    });

    it("should clear TOTP data on successful disable", async () => {
      const { authenticator } = require("otplib");
      const validCode = authenticator.generate(userWithTotp.totpSecret);

      authService.verifyPassword.mockResolvedValue(true);
      prisma.user.findUnique.mockResolvedValue({
        totpSecret: userWithTotp.totpSecret,
      });
      prisma.user.update.mockResolvedValue({});

      const result = await service.disableTotp(
        userWithTotp,
        "correct-password",
        validCode,
      );

      expect(result).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: {
          totpVerified: false,
          totpEnabled: false,
          totpSecret: null,
        },
      });
    });

    it("should properly await password verification for LDAP users (regression test)", async () => {
      const ldapUser = {
        ...userWithTotp,
        password: null,
        ldapDN: "cn=user,dc=example,dc=com",
      };

      // LDAP password check fails
      authService.verifyPassword.mockResolvedValue(false);

      await expect(
        service.disableTotp(ldapUser, "wrong-ldap-password", "123456"),
      ).rejects.toThrow(ForbiddenException);

      expect(authService.verifyPassword).toHaveBeenCalledWith(
        ldapUser,
        "wrong-ldap-password",
      );
    });
  });
});
