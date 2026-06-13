import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { User } from "@prisma/client";
import { authenticator, totp } from "otplib";
import * as qrcode from "qrcode-svg";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { AuthService } from "./auth.service";
import { AuthSignInTotpDTO } from "./dto/authSignInTotp.dto";

@Injectable()
export class AuthTotpService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private authService: AuthService,
  ) {}

  async signInTotp(dto: AuthSignInTotpDTO) {
    const token = await this.prisma.loginToken.findFirst({
      where: {
        token: dto.loginToken,
      },
      include: {
        user: true,
      },
    });

    if (!token || token.used)
      throw new UnauthorizedException("Invalid login token", "invalid_token");

    if (token.expiresAt < new Date())
      throw new UnauthorizedException("Login token expired", "token_expired");

    // The user must still have TOTP fully enabled. If it was disabled, or its
    // secret reset, after the token was issued, the token must not be
    // exchanged for a session.
    const { totpSecret, totpVerified } = token.user;

    if (!totpSecret || !totpVerified) {
      throw new BadRequestException("TOTP is not enabled", "totp_not_enabled");
    }

    if (!authenticator.check(dto.totp, totpSecret)) {
      throw new BadRequestException("Invalid code", "invalid_code");
    }

    // Atomically mark the login token as used. Filtering on used: false makes
    // this a compare-and-set: only the first of any concurrent requests gets
    // count === 1, so a single token can never be exchanged twice.
    const consumed = await this.prisma.loginToken.updateMany({
      where: { token: token.token, used: false },
      data: { used: true },
    });

    if (consumed.count === 0)
      throw new UnauthorizedException("Invalid login token", "invalid_token");

    const { refreshToken, refreshTokenId } =
      await this.authService.createRefreshToken(token.user.id);
    const accessToken = await this.authService.createAccessToken(
      token.user,
      refreshTokenId,
    );

    return { accessToken, refreshToken };
  }

  async enableTotp(user: User, password: string) {
    if (!(await this.authService.verifyPassword(user, password)))
      throw new ForbiddenException("Invalid password", "invalid_password");

    // Check if we have a secret already
    const { totpVerified } = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { totpVerified: true },
    });

    if (totpVerified) {
      throw new BadRequestException(
        "TOTP is already enabled",
        "totp_already_enabled",
      );
    }

    const issuer = this.configService.get("general.appName");
    const secret = authenticator.generateSecret();

    const otpURL = totp.keyuri(user.username || user.email, issuer, secret);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        totpEnabled: true,
        totpSecret: secret,
      },
    });

    // TODO: Maybe we should generate the QR code on the client rather than the server?
    const qrCode = new qrcode({
      content: otpURL,
      container: "svg-viewbox",
      join: true,
    }).svg();

    return {
      totpAuthUrl: otpURL,
      totpSecret: secret,
      qrCode:
        "data:image/svg+xml;base64," + Buffer.from(qrCode).toString("base64"),
    };
  }

  async verifyTotp(user: User, password: string, code: string) {
    if (!(await this.authService.verifyPassword(user, password)))
      throw new ForbiddenException("Invalid password", "invalid_password");

    const { totpSecret } = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { totpSecret: true },
    });

    if (!totpSecret) {
      throw new BadRequestException(
        "TOTP is not in progress",
        "totp_not_in_progress",
      );
    }

    const expected = authenticator.generate(totpSecret);

    if (code !== expected) {
      throw new BadRequestException("Invalid code", "invalid_code");
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        totpVerified: true,
      },
    });

    return true;
  }

  async disableTotp(user: User, password: string, code: string) {
    if (!(await this.authService.verifyPassword(user, password)))
      throw new ForbiddenException("Invalid password", "invalid_password");

    const { totpSecret } = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { totpSecret: true },
    });

    if (!totpSecret) {
      throw new BadRequestException("TOTP is not enabled", "totp_not_enabled");
    }

    const expected = authenticator.generate(totpSecret);

    if (code !== expected) {
      throw new BadRequestException("Invalid code", "invalid_code");
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        totpVerified: false,
        totpEnabled: false,
        totpSecret: null,
      },
    });

    return true;
  }
}
