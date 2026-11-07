import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { WabaStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ownNumberOnboardingEnabled, TenantService } from '../tenant/tenant.service.js';
import { OnboardWabaDto } from './dto/onboard-waba.dto.js';
import { RequestOtpDto } from './dto/request-otp.dto.js';
import { VerifyOtpDto } from './dto/verify-otp.dto.js';
import { WabaService } from './waba.service.js';

/**
 * Own-number onboarding: a vendor registers their own WhatsApp number with Meta via OTP.
 * Off unless ALLOW_OWN_NUMBER_ONBOARDING=true; by default shops get a pool number when a
 * super admin approves them.
 */
@Controller('api/v1/waba')
@UseGuards(JwtAuthGuard)
export class WabaController {
  constructor(
    private readonly wabaService: WabaService,
    private readonly tenantService: TenantService,
  ) { }

  /**
   * Step 1: Add tenant's phone number to Meta WABA.
   */
  @Post('onboard')
  async onboardPhoneNumber(
    @Request() req: any,
    @Body() dto: OnboardWabaDto,
  ) {
    this.assertOwnNumberOnboarding();
    const tenant = await this.tenantService.findByUser(req.user.id);
    if (!tenant.whatsappNumber) {
      throw new BadRequestException('Set your WhatsApp number on the shop (PUT /tenants) before onboarding it.');
    }
    const verifiedName = dto.verifiedName || tenant.name;
    const countryCode = dto.countryCode || tenant.countryCode;

    // Clean phone number: remove leading + or country code if user provided full number
    let localNumber = tenant.whatsappNumber.replace(/^\+/, '');
    if (localNumber.startsWith(countryCode)) {
      localNumber = localNumber.slice(countryCode.length);
    }
    localNumber = localNumber.replace(/^0+/, '');

    const metaRes = await this.wabaService.addPhoneNumberToWaba({
      countryCode,
      phoneNumber: localNumber,
      verifiedName,
    });

    const updatedTenant = await this.tenantService.updateWabaStatus(
      tenant.id,
      {
        whatsappPhoneNumberId: metaRes.phoneNumberId,
        wabaStatus: WabaStatus.PENDING_REGISTRATION,
      },
    );

    return {
      message: 'Phone number submitted to Meta WABA successfully.',
      tenant: updatedTenant,
    };
  }

  /**
   * Step 2: Request SMS or VOICE OTP verification code from Meta.
   */
  @Post('request-otp')
  async requestOtp(@Request() req: any, @Body() dto: RequestOtpDto) {
    const { tenant, phoneNumberId } = await this.onboardedTenant(req.user.id);

    await this.wabaService.requestVerificationCode({
      phoneNumberId,
      codeMethod: dto.codeMethod,
      language: dto.language,
    });

    const updatedTenant = await this.tenantService.updateWabaStatus(
      tenant.id,
      {
        wabaStatus: WabaStatus.OTP_SENT,
      },
    );

    return {
      message: `Verification code sent via ${dto.codeMethod}.`,
      tenant: updatedTenant,
    };
  }

  /**
   * Step 3: Submit 6-digit OTP code to verify and register number on Meta Cloud API.
   */
  @Post('verify-otp')
  async verifyOtp(@Request() req: any, @Body() dto: VerifyOtpDto) {
    const { tenant, phoneNumberId } = await this.onboardedTenant(req.user.id);

    await this.wabaService.verifyCodeAndRegister({
      phoneNumberId,
      code: dto.code,
      pin: dto.pin,
    });

    const updatedTenant = await this.tenantService.updateWabaStatus(
      tenant.id,
      {
        wabaStatus: WabaStatus.VERIFIED,
        wabaRegisteredAt: new Date(),
      },
    );

    // The number is registered either way; a missing Flow key is reported, not fatal.
    let flowKeyWarning: string | undefined;
    await this.wabaService.ensureFlowEncryptionKey(phoneNumberId).catch((err: Error) => {
      flowKeyWarning = `The ordering Flow will not open on this number until its encryption key is set up: ${err.message}`;
    });

    return {
      message: 'WhatsApp number successfully verified and registered with Meta WABA!',
      tenant: updatedTenant,
      ...(flowKeyWarning ? { flowKeyWarning } : {}),
    };
  }

  /** The caller's shop, once /waba/onboard has given it a Meta phone number id. */
  private async onboardedTenant(userId: string) {
    this.assertOwnNumberOnboarding();
    const tenant = await this.tenantService.findByUser(userId);
    if (!tenant.whatsappPhoneNumberId) {
      throw new BadRequestException('Tenant phone number is not onboarded to WABA yet. Please call /waba/onboard first.');
    }
    return { tenant, phoneNumberId: tenant.whatsappPhoneNumberId };
  }

  /** 404 rather than 403, so the routes look absent when the feature is off. */
  private assertOwnNumberOnboarding() {
    if (!ownNumberOnboardingEnabled()) {
      throw new NotFoundException('Own-number onboarding is not enabled. Your number is assigned when your shop is approved.');
    }
  }
}
