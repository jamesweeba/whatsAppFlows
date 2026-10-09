import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class EncryptedFlowRequestDto {
  @IsString()
  @IsNotEmpty()
  encrypted_flow_data: string;

  @IsString()
  @IsNotEmpty()
  encrypted_aes_key: string;

  @IsString()
  @IsNotEmpty()
  initial_vector: string;
}

export class SendFlowMessageDto {
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @IsString()
  @IsNotEmpty()
  toPhone: string;

  @IsString()
  @IsOptional()
  flowId?: string;

  @IsString()
  @IsOptional()
  flowCta?: string;

  @IsString()
  @IsOptional()
  screen?: string;
}

