import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { MessageSender, MessageSource } from '@prisma/client';

export class ProcessMessageDto {
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @IsString()
  @IsNotEmpty()
  buyerPhone: string;

  @IsString()
  @IsOptional()
  text?: string;

  @IsObject()
  @IsOptional()
  flowData?: Record<string, any>;

  @IsEnum(MessageSender)
  @IsOptional()
  sender?: MessageSender = MessageSender.BUYER;

  @IsEnum(MessageSource)
  @IsOptional()
  source?: MessageSource = MessageSource.TEXT;

  @IsString()
  @IsOptional()
  incomingMessageId?: string;
}
