import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum CodeMethod {
  SMS = 'SMS',
  VOICE = 'VOICE',
}

export class RequestOtpDto {
  @IsEnum(CodeMethod)
  codeMethod: CodeMethod = CodeMethod.SMS;

  @IsString()
  @IsOptional()
  language?: string = 'en';
}
