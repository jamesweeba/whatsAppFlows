import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { WebhookSecretGuard } from '../auth/guards/webhook-secret.guard.js';
import { ChatService } from './chat.service.js';
import { ProcessMessageDto } from './dto/process-message.dto.js';

@Controller('api/v1/chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) { }

  /**
   * Process a text message or WhatsApp Flow response from a buyer.
   * Runs AI intent classification, converts flow payloads to text,
   * and saves the message to chat history.
   *
   * Protected by WebhookSecretGuard — caller must supply the shared secret
   * in the `x-webhook-secret` request header (env: WEBHOOK_SECRET).
   */
  @Post('')
  @UseGuards(WebhookSecretGuard)
  async processMessage(@Body() dto: ProcessMessageDto) {
    return this.chatService.processIncomingMessage(dto);
  }

  /**
   * Retrieve chat history for a buyer-tenant session.
   * Protected by JWT Guard (for vendor management dashboard).
   */
  @Get('history')
  @UseGuards(JwtAuthGuard)
  async getHistory(
    @Query('tenantId') tenantId: string,
    @Query('buyerPhone') buyerPhone: string,
  ) {
    return this.chatService.getSessionHistory(tenantId, buyerPhone);
  }
}
