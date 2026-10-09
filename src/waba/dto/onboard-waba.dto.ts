import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class OnboardWabaDto {
  @IsString()
  @IsOptional()
  countryCode?: string; // If omitted, defaults to tenant's stored countryCode

  @IsString()
  @IsOptional()
  verifiedName?: string; // If omitted, defaults to tenant's name
}
