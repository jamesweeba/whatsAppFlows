import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'OTP code must be exactly 6 digits.' })
  code: string;

  @IsString()
  @IsOptional()
  @Length(6, 6, { message: '2FA PIN must be exactly 6 digits.' })
  pin?: string;
}
