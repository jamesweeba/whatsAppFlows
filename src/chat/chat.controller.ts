import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
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
   * List all buyer conversations with latest message preview and orders.
   * GET /api/v1/chat/sessions?page=1&limit=20&search=+233
   */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async getSessions(
    @Request() req: any,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
  ) {
    return this.chatService.getSessionsForVendor(req.user.id, page, limit, search);
  }

  /**
   * Get full conversation thread and all orders placed for a specific session.
   * GET /api/v1/chat/sessions/:id
   */
  @Get('sessions/:id')
  @UseGuards(JwtAuthGuard)
  async getSessionDetail(@Request() req: any, @Param('id') id: string) {
    return this.chatService.getSessionDetailForVendor(req.user.id, id);
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

