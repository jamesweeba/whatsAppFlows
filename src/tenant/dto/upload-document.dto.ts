import { DocumentType } from '@prisma/client';
import { IsEnum } from 'class-validator';

/** Form field sent alongside the KYC file. */
export class UploadDocumentDto {
  @IsEnum(DocumentType, { message: `type must be one of: ${Object.values(DocumentType).join(', ')}` })
  type: DocumentType;
}
