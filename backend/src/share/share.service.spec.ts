import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { ShareService } from "./share.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "../config/config.service";
import { FileService } from "../file/file.service";
import { EmailService } from "../email/email.service";
import { ReverseShareService } from "../reverseShare/reverseShare.service";
import { ClamScanService } from "../clamscan/clamscan.service";

// Helper to build a minimal mock share
function mockShare(overrides: Record<string, any> = {}) {
  return {
    id: "test-share-id",
    createdAt: new Date("2025-01-01"),
    name: "Test Share",
    uploadLocked: true,
    isZipReady: false,
    views: 0,
    expiration: new Date("2099-01-01"),
    description: null,
    removedReason: null,
    creatorId: "user-1",
    reverseShareId: null,
    storageProvider: "LOCAL",
    security: null,
    files: [],
    creator: null,
    recipients: [],
    ...overrides,
  };
}

describe("ShareService", () => {
  let service: ShareService;
  let prisma: any;
  let jwtService: any;
  let configService: any;

  beforeEach(async () => {
    prisma = {
      share: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
      },
      file: {
        findMany: jest.fn(),
      },
      reverseShare: {
        update: jest.fn(),
      },
    };

    jwtService = {
      sign: jest.fn().mockReturnValue("mock-jwt-token"),
      verify: jest.fn().mockReturnValue({}),
    };

    configService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          "internal.jwtSecret": "test-secret",
          "s3.enabled": false,
          "share.maxExpiration": { value: 0, unit: "days" },
          "share.zipCompressionLevel": 9,
          "smtp.enabled": false,
        };
        return config[key];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShareService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: configService },
        {
          provide: FileService,
          useValue: { deleteAllFiles: jest.fn() },
        },
        {
          provide: EmailService,
          useValue: {
            sendMailToShareRecipients: jest.fn(),
            sendMailToReverseShareCreator: jest.fn(),
          },
        },
        {
          provide: ReverseShareService,
          useValue: { getByToken: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: ClamScanService,
          useValue: { checkAndRemove: jest.fn() },
        },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile();

    service = module.get<ShareService>(ShareService);
  });

  describe("get()", () => {
    it("should throw NotFoundException when share does not exist", async () => {
      prisma.share.findUnique.mockResolvedValue(null);

      await expect(service.get("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw NotFoundException with 'share_removed' when share has removedReason", async () => {
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ removedReason: "Malware detected" }),
      );

      try {
        await service.get("test-share-id");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as any).getResponse().error).toBe("share_removed");
        expect((e as any).getResponse().message).toBe("Malware detected");
      }
    });

    it("should throw NotFoundException when share is not uploadLocked (incomplete upload)", async () => {
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ uploadLocked: false }),
      );

      await expect(service.get("test-share-id")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should return share with hasPassword flag when valid", async () => {
      const share = mockShare({
        security: { password: "hashed", maxViews: null },
      });
      prisma.share.findUnique.mockResolvedValue(share);

      const result = await service.get("test-share-id");

      expect(result.id).toBe("test-share-id");
      expect(result.hasPassword).toBe(true);
    });

    it("should return hasPassword=false when no security", async () => {
      prisma.share.findUnique.mockResolvedValue(mockShare());

      const result = await service.get("test-share-id");

      expect(result.hasPassword).toBe(false);
    });
  });

  describe("getMetaData()", () => {
    it("should throw NotFoundException when share does not exist", async () => {
      prisma.share.findUnique.mockResolvedValue(null);

      await expect(service.getMetaData("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw NotFoundException with 'share_removed' when share is removed", async () => {
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ removedReason: "Removed by admin" }),
      );

      try {
        await service.getMetaData("test-share-id");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as any).getResponse().error).toBe("share_removed");
      }
    });

    it("should throw NotFoundException when share is not uploadLocked", async () => {
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ uploadLocked: false }),
      );

      await expect(service.getMetaData("test-share-id")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should return share metadata when valid", async () => {
      const share = mockShare({ isZipReady: true });
      prisma.share.findUnique.mockResolvedValue(share);

      const result = await service.getMetaData("test-share-id");

      expect(result.isZipReady).toBe(true);
    });
  });

  describe("getShareToken()", () => {
    it("should throw NotFoundException when share does not exist", async () => {
      prisma.share.findFirst.mockResolvedValue(null);

      await expect(
        service.getShareToken("nonexistent", ""),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw NotFoundException with 'share_removed' when share is removed", async () => {
      prisma.share.findFirst.mockResolvedValue(
        mockShare({ removedReason: "Reported abuse" }),
      );

      try {
        await service.getShareToken("test-share-id", "");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as any).getResponse().error).toBe("share_removed");
      }
    });

    it("should throw NotFoundException when share upload is not locked", async () => {
      prisma.share.findFirst.mockResolvedValue(
        mockShare({ uploadLocked: false }),
      );

      await expect(
        service.getShareToken("test-share-id", ""),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw ForbiddenException with 'share_password_required' when password is needed but not provided", async () => {
      prisma.share.findFirst.mockResolvedValue(
        mockShare({
          security: { password: "hashed-pw", maxViews: null },
        }),
      );

      try {
        await service.getShareToken("test-share-id", "");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as any).getResponse().error).toBe("share_password_required");
      }
    });

    it("should throw ForbiddenException with 'wrong_password' when password is incorrect", async () => {
      prisma.share.findFirst.mockResolvedValue(
        mockShare({
          security: {
            // argon2 hash of "correct-password"
            password:
              "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            maxViews: null,
          },
        }),
      );

      // argon.verify will return false for wrong password
      jest
        .spyOn(require("argon2"), "verify")
        .mockResolvedValueOnce(false);

      try {
        await service.getShareToken("test-share-id", "wrong-password");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as any).getResponse().error).toBe("wrong_password");
      }
    });

    it("should throw ForbiddenException with 'share_max_views_exceeded' when views limit reached", async () => {
      prisma.share.findFirst.mockResolvedValue(
        mockShare({
          views: 5,
          security: { password: null, maxViews: 5 },
        }),
      );

      try {
        await service.getShareToken("test-share-id", "");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as any).getResponse().error).toBe(
          "share_max_views_exceeded",
        );
      }
    });

    it("should throw ForbiddenException at exact boundary: views == maxViews", async () => {
      prisma.share.findFirst.mockResolvedValue(
        mockShare({
          views: 10,
          security: { password: null, maxViews: 10 },
        }),
      );

      try {
        await service.getShareToken("test-share-id", "");
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as any).getResponse().error).toBe(
          "share_max_views_exceeded",
        );
      }
    });

    it("should allow access when views < maxViews (one below boundary)", async () => {
      const share = mockShare({
        views: 9,
        security: { password: null, maxViews: 10 },
      });
      prisma.share.findFirst.mockResolvedValue(share);
      // generateShareToken internally calls findUnique
      prisma.share.findUnique.mockResolvedValue(share);
      prisma.share.update.mockResolvedValue(mockShare({ views: 10 }));

      const token = await service.getShareToken("test-share-id", "");

      expect(token).toBe("mock-jwt-token");
      expect(prisma.share.update).toHaveBeenCalled();
    });

    it("should return token and increment view count for valid request without password", async () => {
      const share = mockShare({ views: 3 });
      prisma.share.findFirst.mockResolvedValue(share);
      // generateShareToken internally calls findUnique
      prisma.share.findUnique.mockResolvedValue(share);
      prisma.share.update.mockResolvedValue(mockShare({ views: 4 }));

      const token = await service.getShareToken("test-share-id", "");

      expect(token).toBe("mock-jwt-token");
      expect(prisma.share.update).toHaveBeenCalledWith({
        where: { id: "test-share-id" },
        data: { views: 4 },
      });
    });

    it("should not increment view count when maxViews check fails", async () => {
      prisma.share.findFirst.mockResolvedValue(
        mockShare({
          views: 5,
          security: { password: null, maxViews: 5 },
        }),
      );

      await expect(
        service.getShareToken("test-share-id", ""),
      ).rejects.toThrow(ForbiddenException);

      expect(prisma.share.update).not.toHaveBeenCalled();
    });
  });

  describe("generateShareToken()", () => {
    it("should throw NotFoundException when share does not exist", async () => {
      prisma.share.findUnique.mockResolvedValue(null);

      await expect(service.generateShareToken("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should generate a JWT token for a valid share", async () => {
      prisma.share.findUnique.mockResolvedValue(mockShare());

      const token = await service.generateShareToken("test-share-id");

      expect(token).toBe("mock-jwt-token");
      expect(jwtService.sign).toHaveBeenCalled();
    });

    it("should not set expiresIn when expiration is epoch 0 (never expires)", async () => {
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ expiration: new Date(0) }),
      );

      await service.generateShareToken("test-share-id");

      const signCall = jwtService.sign.mock.calls[0];
      expect(signCall[1].expiresIn).toBeUndefined();
    });
  });

  describe("verifyShareToken()", () => {
    it("should return false when share does not exist", async () => {
      prisma.share.findUnique.mockResolvedValue(null);

      const result = await service.verifyShareToken("nonexistent", "token");

      expect(result).toBe(false);
    });

    it("should return false when share has removedReason", async () => {
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ removedReason: "Malware detected" }),
      );

      const result = await service.verifyShareToken(
        "test-share-id",
        "token",
      );

      expect(result).toBe(false);
    });

    it("should return false when token verification fails", async () => {
      prisma.share.findUnique.mockResolvedValue(mockShare());
      jwtService.verify.mockImplementation(() => {
        throw new Error("invalid token");
      });

      const result = await service.verifyShareToken(
        "test-share-id",
        "bad-token",
      );

      expect(result).toBe(false);
    });

    it("should return true when token is valid and matches share", async () => {
      const createdAt = new Date("2025-01-01");
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ createdAt }),
      );

      const moment = require("moment");
      jwtService.verify.mockReturnValue({
        shareId: "test-share-id",
        shareCreatedAt: moment(createdAt).unix(),
      });

      const result = await service.verifyShareToken(
        "test-share-id",
        "valid-token",
      );

      expect(result).toBe(true);
    });

    it("should return false when token shareId does not match", async () => {
      const createdAt = new Date("2025-01-01");
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ createdAt }),
      );

      const moment = require("moment");
      jwtService.verify.mockReturnValue({
        shareId: "different-share-id",
        shareCreatedAt: moment(createdAt).unix(),
      });

      const result = await service.verifyShareToken(
        "test-share-id",
        "valid-token",
      );

      expect(result).toBe(false);
    });

    it("should return false when token shareCreatedAt does not match", async () => {
      const createdAt = new Date("2025-01-01");
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ createdAt }),
      );

      jwtService.verify.mockReturnValue({
        shareId: "test-share-id",
        shareCreatedAt: 9999999999, // wrong timestamp
      });

      const result = await service.verifyShareToken(
        "test-share-id",
        "valid-token",
      );

      expect(result).toBe(false);
    });
  });

  describe("isShareCompleted()", () => {
    it("should return false when share does not exist", async () => {
      prisma.share.findUnique.mockResolvedValue(null);

      const result = await service.isShareCompleted("nonexistent");

      expect(result).toBe(false);
    });

    it("should return false when share is not uploadLocked", async () => {
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ uploadLocked: false }),
      );

      const result = await service.isShareCompleted("test-share-id");

      expect(result).toBe(false);
    });

    it("should return true when share is uploadLocked", async () => {
      prisma.share.findUnique.mockResolvedValue(
        mockShare({ uploadLocked: true }),
      );

      const result = await service.isShareCompleted("test-share-id");

      expect(result).toBe(true);
    });
  });
});
