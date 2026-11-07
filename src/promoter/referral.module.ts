import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ReferralService } from './referral.service.js';

/** Referrals only need the database, so orders, chat and promoters can all use them without import cycles. */
@Module({
  imports: [PrismaModule],
  providers: [ReferralService],
  exports: [ReferralService],
})
export class ReferralModule {}
