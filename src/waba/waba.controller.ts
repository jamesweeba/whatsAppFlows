import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { WabaStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { TenantService } from '../tenant/tenant.service.js';
import { OnboardWabaDto } from './dto/onboard-waba.dto.js';
import { RequestOtpDto } from './dto/request-otp.dto.js';
import { VerifyOtpDto } from './dto/verify-otp.dto.js';
import { WabaService } from './waba.service.js';

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
    const tenant = await this.tenantService.findByUser(req.user.id);
    const verifiedName = dto.verifiedName || tenant.name;
    const countryCode = dto.countryCode || tenant.countryCode

    // Clean phone number: remove leading + or country code if user provided full number
    let localNumber = tenant.whatsappNumber.replace(/^\+/, '');
    if (localNumber.startsWith(countryCode)) {
      localNumber = localNumber.slice(countryCode.length);
    }
    localNumber = localNumber.replace(/^0+/, '');

    console.log(localNumber, 'localNumber........................', verifiedName);

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
    const tenant = await this.tenantService.findByUser(req.user.id);

    if (!tenant.whatsappPhoneNumberId) {
      throw new BadRequestException(
        'Tenant phone number is not onboarded to WABA yet. Please call /waba/onboard first.',
      );
    }

    await this.wabaService.requestVerificationCode({
      phoneNumberId: tenant.whatsappPhoneNumberId,
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
    const tenant = await this.tenantService.findByUser(req.user.id);

    if (!tenant.whatsappPhoneNumberId) {
      throw new BadRequestException(
        'Tenant phone number is not onboarded to WABA yet. Please call /waba/onboard first.',
      );
    }

    await this.wabaService.verifyCodeAndRegister({
      phoneNumberId: tenant.whatsappPhoneNumberId,
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

    return {
      message: 'WhatsApp number successfully verified and registered with Meta WABA!',
      tenant: updatedTenant,
    };
  }
}
