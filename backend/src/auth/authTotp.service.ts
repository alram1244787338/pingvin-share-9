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
    // Look up the login token
    const token = await this.prisma.loginToken.findFirst({
      where: {
        token: dto.loginToken,
      },
      include: {
        user: true,
      },
    });

    // Token not found or already consumed — use the same generic message
    // so attackers can't enumerate valid tokens
    if (!token || token.used)
      throw new UnauthorizedException(
        "Invalid or expired login token",
        "token_invalid",
      );

    // Token expired
    if (token.expiresAt < new Date())
      throw new UnauthorizedException(
        "Login session expired, please sign in again",
        "token_expired",
      );

    // Re-fetch user from DB to get the latest TOTP state, in case
    // TOTP was disabled or the secret was reset after the login token
    // was originally created.
    const currentUser = await this.prisma.user.findUnique({
      where: { id: token.user.id },
    });

    if (!currentUser) {
      throw new UnauthorizedException(
        "Invalid or expired login token",
        "token_invalid",
      );
    }

    // If TOTP has been disabled since the login token was issued,
    // the login token is no longer valid for TOTP sign-in.
    if (!currentUser.totpEnabled || !currentUser.totpVerified) {
      // Mark this stale token as used so it can't be retried
      await this.prisma.loginToken.update({
        where: { token: token.token },
        data: { used: true },
      });
      throw new UnauthorizedException(
        "Two-factor authentication has been disabled on this account",
        "totp_disabled",
      );
    }

    // Check the TOTP secret exists (defensive — the totpVerified check
    // above should have caught this, but guard against inconsistent data)
    if (!currentUser.totpSecret) {
      await this.prisma.loginToken.update({
        where: { token: token.token },
        data: { used: true },
      });
      throw new UnauthorizedException(
        "Two-factor authentication has been disabled on this account",
        "totp_disabled",
      );
    }

    // Verify the TOTP code using authenticator.check which allows
    // a small timing window (±1 step) for clock skew
    if (!authenticator.check(dto.totp, currentUser.totpSecret)) {
      throw new UnauthorizedException(
        "Invalid verification code",
        "totp_invalid",
      );
    }

    // Mark the login token as consumed BEFORE issuing tokens,
    // so a concurrent replay attempt will see used=true above.
    await this.prisma.loginToken.update({
      where: { token: token.token },
      data: { used: true },
    });

    const { refreshToken, refreshTokenId } =
      await this.authService.createRefreshToken(currentUser.id);
    const accessToken = await this.authService.createAccessToken(
      currentUser,
      refreshTokenId,
    );

    return { accessToken, refreshToken };
  }

  async enableTotp(user: User, password: string) {
    const isPasswordValid = await this.authService.verifyPassword(
      user,
      password,
    );
    if (!isPasswordValid)
      throw new ForbiddenException("Invalid password", "password_invalid");

    // Check if we have a secret already
    const { totpVerified } = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { totpVerified: true },
    });

    if (totpVerified) {
      throw new BadRequestException(
        "Two-factor authentication is already enabled",
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
    const isPasswordValid = await this.authService.verifyPassword(
      user,
      password,
    );
    if (!isPasswordValid)
      throw new ForbiddenException("Invalid password", "password_invalid");

    const { totpSecret } = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { totpSecret: true },
    });

    if (!totpSecret) {
      throw new BadRequestException(
        "Two-factor authentication setup has not been started",
        "totp_not_in_progress",
      );
    }

    // Use authenticator.check for timing-window tolerance instead of
    // exact string comparison with a freshly generated code.
    if (!authenticator.check(code, totpSecret)) {
      throw new BadRequestException(
        "Invalid verification code",
        "totp_invalid",
      );
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
    const isPasswordValid = await this.authService.verifyPassword(
      user,
      password,
    );
    if (!isPasswordValid)
      throw new ForbiddenException("Invalid password", "password_invalid");

    const { totpSecret } = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { totpSecret: true },
    });

    if (!totpSecret) {
      throw new BadRequestException(
        "Two-factor authentication is not enabled",
        "totp_not_enabled",
      );
    }

    if (!authenticator.check(code, totpSecret)) {
      throw new BadRequestException(
        "Invalid verification code",
        "totp_invalid",
      );
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
