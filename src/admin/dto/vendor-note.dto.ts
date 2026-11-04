import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export const MAX_NOTE_LENGTH = 2000;

/** POST and PATCH /admin/tenants/:id/notes. */
export class VendorNoteDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Write something in the note.' })
  @MaxLength(MAX_NOTE_LENGTH, { message: `Notes can be at most ${MAX_NOTE_LENGTH} characters.` })
  body: string;
}
