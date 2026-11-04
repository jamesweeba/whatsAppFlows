import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { IsPhone } from '../../common/validators.js';

/** A number already registered and verified under the WABA on Meta. */
export class AddNumberDto {
  /** Meta's phone number id (from WhatsApp Manager or the Graph API), not the phone number. */
  @Matches(/^\d{6,20}$/, { message: 'phoneNumberId is Meta\'s numeric id for the number, e.g. 1404916169377344' })
  phoneNumberId: string;

  /** As buyers dial it, e.g. 0205960861 or +233205960861. */
  @IsPhone()
  displayNumber: string;

  /** Defaults to META_WABA_ID. */
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  wabaId?: string;

  @IsString()
  @MaxLength(100)
  @IsOptional()
  displayName?: string;
}
