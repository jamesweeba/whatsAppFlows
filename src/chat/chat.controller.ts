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
  constructor(private readonly chatService: ChatService) {}

  /**
   * Process a text message or WhatsApp Flow response from a buyer.
   * Protected by WebhookSecretGuard: callers must supply the shared secret in `x-webhook-secret`.
   */
  @Post('')
  @UseGuards(WebhookSecretGuard)
  async processMessage(@Body() dto: ProcessMessageDto) {
    return this.chatService.processIncomingMessage(dto);
  }

  /**
   * List buyer conversations for the vendor's shop.
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
   * Full conversation thread and orders for one session.
   * GET /api/v1/chat/sessions/:id
   */
  @Get('sessions/:id')
  @UseGuards(JwtAuthGuard)
  async getSessionDetail(@Request() req: any, @Param('id') id: string) {
    return this.chatService.getSessionDetailForVendor(req.user.id, id);
  }

  /**
   * Latest chat history between the vendor's shop and a buyer.
   * GET /api/v1/chat/history?buyerPhone=+233...
   */
  @Get('history')
  @UseGuards(JwtAuthGuard)
  async getHistory(@Request() req: any, @Query('buyerPhone') buyerPhone: string) {
    return this.chatService.getSessionHistory(req.user.id, buyerPhone);
  }
}
