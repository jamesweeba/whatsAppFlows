import { Transform, Type } from 'class-transformer';
import { IsDate, IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** POST /admin/tenants/:id/banner/approve */
export class ApproveBannerDto {
  /** `banner.pendingAt` of the upload the admin looked at; a newer upload makes this 409. */
  @Type(() => Date)
  @IsDate({ message: 'pendingAt must be the banner.pendingAt date.' })
  pendingAt: Date;
}

/** POST /admin/tenants/:id/banner/reject */
export class RejectBannerDto extends ApproveBannerDto {
  /** Shown to the vendor in their app. */
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Say why, so the vendor knows what to change.' })
  @MaxLength(500)
  reason: string;
}

/** POST /admin/tenants/:id/banner/remove */
export class RemoveBannerDto {
  /** Shown to the vendor in their app. */
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Say why, so the vendor knows what to change.' })
  @MaxLength(500)
  reason: string;
}
