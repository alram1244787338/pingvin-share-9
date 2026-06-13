import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { authenticator } from "otplib";

// Collaborators are replaced by hand-built mocks; stub the modules so loading
// the service doesn't pull in their real dependency graphs.
jest.mock("src/config/config.service", () => ({
  ConfigService: class ConfigService {},
}));
jest.mock("src/prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));
jest.mock("./auth.service", () => ({
  AuthService: class AuthService {},
}));

import { AuthTotpService } from "./authTotp.service";

/** Extracts the stable error code passed as the 2nd HttpException argument. */
const errorCode = (e: any) => (e?.getResponse?.() as any)?.error;

const buildPrismaMock = () => ({
  loginToken: {
    findFirst: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  user: {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
});

const buildService = (overrides?: { prisma?: any; authService?: any }) => {
  const prisma = overrides?.prisma ?? buildPrismaMock();
  const authService = overrides?.authService ?? {
    verifyPassword: jest.fn(),
    createRefreshToken: jest
      .fn()
      .mockResolvedValue({ refreshToken: "rt", refreshTokenId: "rid" }),
    createAccessToken: jest.fn().mockResolvedValue("at"),
  };
  const configService = { get: jest.fn().mockReturnValue("AppName") };

  const service = new AuthTotpService(
    prisma as any,
    configService as any,
    authService as any,
  );

  return { service, prisma, authService, configService };
};

const user = { id: "user-1", username: "jdoe", email: "j@d.oe" } as any;

describe("AuthTotpService password gate", () => {
  // The original code called the async verifyPassword without awaiting, so a
  // wrong password never blocked these endpoints. These guard against that.
  it("enableTotp rejects a wrong password", async () => {
    const authService = { verifyPassword: jest.fn().mockResolvedValue(false) };
    const { service, prisma } = buildService({ authService });

    const caught = await service.enableTotp(user, "wrong").catch((e) => e);

    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(errorCode(caught)).toBe("invalid_password");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("verifyTotp rejects a wrong password", async () => {
    const authService = { verifyPassword: jest.fn().mockResolvedValue(false) };
    const { service, prisma } = buildService({ authService });

    const caught = await service
      .verifyTotp(user, "wrong", "000000")
      .catch((e) => e);

    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(errorCode(caught)).toBe("invalid_password");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("disableTotp rejects a wrong password", async () => {
    const authService = { verifyPassword: jest.fn().mockResolvedValue(false) };
    const { service, prisma } = buildService({ authService });

    const caught = await service
      .disableTotp(user, "wrong", "000000")
      .catch((e) => e);

    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(errorCode(caught)).toBe("invalid_password");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("AuthTotpService enable / verify / disable happy paths", () => {
  it("enableTotp returns a secret and QR code for a correct password", async () => {
    const prisma = buildPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ totpVerified: false });
    const authService = { verifyPassword: jest.fn().mockResolvedValue(true) };
    const { service } = buildService({ prisma, authService });

    const result = await service.enableTotp(user, "correct");

    expect(result.totpSecret).toEqual(expect.any(String));
    expect(result.qrCode).toContain("data:image/svg+xml;base64,");
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totpEnabled: true }),
      }),
    );
  });

  it("enableTotp rejects when TOTP is already enabled", async () => {
    const prisma = buildPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ totpVerified: true });
    const authService = { verifyPassword: jest.fn().mockResolvedValue(true) };
    const { service } = buildService({ prisma, authService });

    const caught = await service.enableTotp(user, "correct").catch((e) => e);

    expect(caught).toBeInstanceOf(BadRequestException);
    expect(errorCode(caught)).toBe("totp_already_enabled");
  });

  it("verifyTotp accepts the correct code and marks TOTP verified", async () => {
    const secret = authenticator.generateSecret();
    const prisma = buildPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ totpSecret: secret });
    const authService = { verifyPassword: jest.fn().mockResolvedValue(true) };
    const { service } = buildService({ prisma, authService });

    await expect(
      service.verifyTotp(user, "correct", authenticator.generate(secret)),
    ).resolves.toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totpVerified: true }),
      }),
    );
  });

  it("verifyTotp rejects an incorrect code", async () => {
    const secret = authenticator.generateSecret();
    const prisma = buildPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ totpSecret: secret });
    const authService = { verifyPassword: jest.fn().mockResolvedValue(true) };
    const { service } = buildService({ prisma, authService });

    const caught = await service
      .verifyTotp(user, "correct", "000000")
      .catch((e) => e);

    expect(caught).toBeInstanceOf(BadRequestException);
    expect(errorCode(caught)).toBe("invalid_code");
  });

  it("disableTotp clears the secret with a correct code", async () => {
    const secret = authenticator.generateSecret();
    const prisma = buildPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ totpSecret: secret });
    const authService = { verifyPassword: jest.fn().mockResolvedValue(true) };
    const { service } = buildService({ prisma, authService });

    await expect(
      service.disableTotp(user, "correct", authenticator.generate(secret)),
    ).resolves.toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { totpVerified: false, totpEnabled: false, totpSecret: null },
      }),
    );
  });
});

describe("AuthTotpService.signInTotp", () => {
  const secret = authenticator.generateSecret();

  const validTokenRow = (overrides?: any) => ({
    token: "login-token",
    used: false,
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: "user-1",
      totpSecret: secret,
      totpVerified: true,
    },
    ...overrides,
  });

  const dto = (totp: string) => ({ loginToken: "login-token", totp });

  it("rejects an unknown login token", async () => {
    const prisma = buildPrismaMock();
    prisma.loginToken.findFirst.mockResolvedValue(null);
    const { service } = buildService({ prisma });

    const caught = await service.signInTotp(dto("123456")).catch((e) => e);

    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect(errorCode(caught)).toBe("invalid_token");
  });

  it("rejects an already-used login token", async () => {
    const prisma = buildPrismaMock();
    prisma.loginToken.findFirst.mockResolvedValue(
      validTokenRow({ used: true }),
    );
    const { service } = buildService({ prisma });

    const caught = await service.signInTotp(dto("123456")).catch((e) => e);

    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect(errorCode(caught)).toBe("invalid_token");
  });

  it("rejects an expired login token", async () => {
    const prisma = buildPrismaMock();
    prisma.loginToken.findFirst.mockResolvedValue(
      validTokenRow({ expiresAt: new Date(Date.now() - 1_000) }),
    );
    const { service } = buildService({ prisma });

    const caught = await service.signInTotp(dto("123456")).catch((e) => e);

    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect(errorCode(caught)).toBe("token_expired");
  });

  it("rejects when the user no longer has TOTP enabled", async () => {
    const prisma = buildPrismaMock();
    prisma.loginToken.findFirst.mockResolvedValue(
      validTokenRow({
        user: { id: "user-1", totpSecret: null, totpVerified: false },
      }),
    );
    const { service } = buildService({ prisma });

    const caught = await service.signInTotp(dto("123456")).catch((e) => e);

    expect(caught).toBeInstanceOf(BadRequestException);
    expect(errorCode(caught)).toBe("totp_not_enabled");
  });

  it("rejects a wrong code without consuming the token", async () => {
    const prisma = buildPrismaMock();
    prisma.loginToken.findFirst.mockResolvedValue(validTokenRow());
    const { service } = buildService({ prisma });

    const caught = await service.signInTotp(dto("000000")).catch((e) => e);

    expect(caught).toBeInstanceOf(BadRequestException);
    expect(errorCode(caught)).toBe("invalid_code");
    // A wrong code must not burn the login token.
    expect(prisma.loginToken.updateMany).not.toHaveBeenCalled();
  });

  it("issues tokens and atomically consumes the login token on success", async () => {
    const prisma = buildPrismaMock();
    prisma.loginToken.findFirst.mockResolvedValue(validTokenRow());
    const { service, authService } = buildService({ prisma });

    const result = await service.signInTotp(
      dto(authenticator.generate(secret)),
    );

    expect(result).toEqual({ accessToken: "at", refreshToken: "rt" });
    expect(prisma.loginToken.updateMany).toHaveBeenCalledWith({
      where: { token: "login-token", used: false },
      data: { used: true },
    });
    expect(authService.createRefreshToken).toHaveBeenCalledWith("user-1");
  });

  it("rejects when the token was consumed concurrently (compare-and-set lost)", async () => {
    const prisma = buildPrismaMock();
    prisma.loginToken.findFirst.mockResolvedValue(validTokenRow());
    prisma.loginToken.updateMany.mockResolvedValue({ count: 0 });
    const { service, authService } = buildService({ prisma });

    const caught = await service
      .signInTotp(dto(authenticator.generate(secret)))
      .catch((e) => e);

    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect(errorCode(caught)).toBe("invalid_token");
    expect(authService.createRefreshToken).not.toHaveBeenCalled();
  });
});
