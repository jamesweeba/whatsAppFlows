import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Promoter, PromoterSignupStep as Step, PromoterStatus } from '@prisma/client';
import { optionalEnv } from '../common/config.js';
import { formatGhanaLocal, isGhanaMobile, isHiddenNumber, toGhanaLocal, toInternationalDigits } from '../common/phone.util.js';
import { PaystackTransfersClient } from '../payout/paystack-transfers.client.js';
import { momoNetworkOf } from '../payout/payout-math.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WabaService } from '../waba/waba.service.js';
import { cleanFullName, COMMISSION_HOLD_DAYS, parsePromoterCommand, PROMOTER_IDS, PromoterCommand, REFERRAL_DAYS, shareText } from './promoter-rules.js';
import { JoinResult, PromoterService } from './promoter.service.js';

/** Links sent per LINKS request, so one message doesn't flood the chat. */
const MAX_LINKS_SENT = 10;

const TEXT = {
  intro:
    '👋 Welcome to *MarketiX Promoters*.\n\n' +
    "Share market shops' products with your contacts and earn money when they order. " +
    "Each shop pays you a commission on a new customer's first order, sent to your MoMo.\n\nIt's free to join.",
  hiddenNumber:
    'To promote shops on MarketiX we need to see your phone number, and your WhatsApp settings hide it. ' +
    'Please message us from a WhatsApp account that shows your number.',
  suspended: 'Your promoter account is paused. Please contact MarketiX support.',
  askName: "Let's get you set up. What's your *full name*?",
  badName: 'Please send your full name, for example *Ama Mensah*.',
  askMomo: 'Thanks! What *MoMo number* should we pay your commission to? For example *024 411 1222*.',
  badMomo: "That doesn't look like a Ghana MoMo number. Please send it like *024 411 1222* (MTN, Telecel or AirtelTigo).",
  terms:
    '*Before you start*\n\n' +
    `• You earn when a *new customer* places their *first order* with a shop through your link, within ${REFERRAL_DAYS} days.\n` +
    '• The order must be paid by MoMo or card and delivered. Cash orders don’t earn commission.\n' +
    `• Commission is ready to withdraw ${COMMISSION_HOLD_DAYS} days after delivery.\n` +
    '• Each shop decides who promotes it and sets its own commission.\n' +
    '• No fake orders and no ordering through your own link. Accounts that cheat are closed and not paid.',
  menu: '*What would you like to do?*\n\n• *SHOPS*: find shops to promote\n• *LINKS*: get your links to share\n• *HELP*: show this menu',
  noShops: 'No shops are taking new promoters right now. Please check back soon.',
  noLinks: "You don't have any links yet. Send *SHOPS* to find a shop to promote.",
  invalidInvite: "That invite code isn't valid any more. Ask the shop to send you a new link.",
  wrongNumber: 'This invite was sent to a different WhatsApp number. Ask the shop to invite this number instead.',
  closed: "That shop isn't taking promoters right now. Send *SHOPS* to see who is.",
};

/**
 * The promoter bot on the platform number (PLATFORM_PHONE_NUMBER_ID): sign-up, finding
 * shops, invites and links. A promoter is known by their WhatsApp number; there is no login.
 */
@Injectable()
export class PromoterBotService {
  private readonly logger = new Logger(PromoterBotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly waba: WabaService,
    private readonly promoters: PromoterService,
    private readonly transfers: PaystackTransfersClient,
  ) {}

  /** The platform number's Meta id, or '' when it isn't configured. */
  static platformNumberId(): string {
    return optionalEnv('PLATFORM_PHONE_NUMBER_ID');
  }

  /** Handle one inbound message to the platform number. Never throws. */
  async handle(message: { phone: string; text: string; messageId: string }): Promise<void> {
    try {
      await this.route(message);
    } catch (err: any) {
      this.logger.error(`Promoter message ${message.messageId} failed: ${err?.message || err}`);
    }
  }

  private async route({ phone, text, messageId }: { phone: string; text: string; messageId: string }) {
    if (isHiddenNumber(phone)) return this.say(phone, TEXT.hiddenNumber);
    const command = parsePromoterCommand(text);

    const promoter = await this.prisma.promoter.findUnique({ where: { phone } });
    if (!promoter) return this.welcomeNewcomer(phone, command, messageId);
    if (!(await this.claim(promoter.id, messageId))) return; // Meta delivered it again

    if (promoter.status === PromoterStatus.SUSPENDED) return this.say(phone, TEXT.suspended);
    if (promoter.status === PromoterStatus.SIGNING_UP) return this.continueSignup(promoter, command, text);

    switch (command.kind) {
      case 'shops':
        return this.sendShops(promoter, command.page);
      case 'request':
        return this.reportJoin(promoter, await this.promoters.requestToJoin(promoter, command.tenantId));
      case 'join':
        return this.reportJoin(promoter, await this.promoters.acceptInvite(promoter, command.code));
      case 'links':
        return this.sendLinks(promoter);
      default:
        return this.sendMenu(phone);
    }
  }

  // ───────────────────────── Sign-up ─────────────────────────

  /** Someone the bot doesn't know: explain, or start sign-up if they asked to promote or followed an invite. */
  private async welcomeNewcomer(phone: string, command: PromoterCommand, messageId: string) {
    if (command.kind !== 'promote' && command.kind !== 'join') {
      return this.buttons(phone, TEXT.intro, [{ id: PROMOTER_IDS.START, title: 'Become a promoter' }]);
    }
    let pendingInviteCode: string | null = null;
    if (command.kind === 'join') {
      const invite = await this.promoters.findOpenInvite(command.code);
      if (!invite) return this.say(phone, TEXT.invalidInvite);
      if (invite.invitedPhone !== phone) return this.say(phone, TEXT.wrongNumber);
      pendingInviteCode = invite.inviteCode;
    }
    try {
      await this.prisma.promoter.create({ data: { phone, pendingInviteCode, lastInboundMessageId: messageId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return; // the same message, delivered twice
      throw err;
    }
    const lead = pendingInviteCode ? "👋 You've been invited to promote a shop on MarketiX. " : '👋 ';
    return this.say(phone, lead + TEXT.askName);
  }

  private async continueSignup(promoter: Promoter, command: PromoterCommand, text: string) {
    if (command.kind === 'join') {
      const invite = await this.promoters.findOpenInvite(command.code);
      if (!invite || invite.invitedPhone !== promoter.phone) {
        await this.say(promoter.phone, invite ? TEXT.wrongNumber : TEXT.invalidInvite);
      } else {
        promoter = await this.update(promoter, { pendingInviteCode: invite.inviteCode });
      }
      return this.promptStep(promoter);
    }

    switch (promoter.signupStep ?? Step.ASK_NAME) {
      case Step.ASK_NAME: {
        if (command.kind !== 'text') return this.promptStep(promoter);
        const fullName = cleanFullName(text);
        if (!fullName) return this.say(promoter.phone, TEXT.badName);
        return this.promptStep(await this.update(promoter, { fullName, signupStep: Step.ASK_MOMO }));
      }
      case Step.ASK_MOMO:
        return command.kind === 'text' ? this.takeMomoNumber(promoter, text) : this.promptStep(promoter);
      case Step.CONFIRM_MOMO_NAME:
        if (command.kind === 'yes') {
          return this.promptStep(await this.update(promoter, { momoVerifiedAt: new Date(), signupStep: Step.ASK_TERMS }));
        }
        if (command.kind === 'no') {
          const cleared = await this.update(promoter, { momoNumber: null, momoNetwork: null, momoName: null, signupStep: Step.ASK_MOMO });
          return this.say(cleared.phone, `No problem. ${TEXT.askMomo.replace('Thanks! ', '')}`);
        }
        return this.promptStep(promoter);
      case Step.ASK_TERMS:
        return command.kind === 'agree' || command.kind === 'yes' ? this.finishSignup(promoter) : this.promptStep(promoter);
    }
  }

  /** Check the MoMo number and ask the promoter to confirm the name Paystack has for it. */
  private async takeMomoNumber(promoter: Promoter, text: string) {
    const momoNumber = toGhanaLocal(text);
    const network = isGhanaMobile(momoNumber) ? momoNetworkOf(momoNumber) : null;
    if (!network) return this.say(promoter.phone, TEXT.badMomo);

    const resolved = await this.transfers.resolveMomoName({ momoNumber, network });
    if (resolved.ok) {
      const updated = await this.update(promoter, { momoNumber, momoNetwork: network, momoName: resolved.name, signupStep: Step.CONFIRM_MOMO_NAME });
      return this.promptStep(updated);
    }
    // Paystack couldn't tell us the name: carry on with the number as given.
    this.logger.warn(`MoMo name check for promoter ${promoter.id} failed: ${resolved.reason}`);
    const updated = await this.update(promoter, { momoNumber, momoNetwork: network, momoName: null, momoVerifiedAt: null, signupStep: Step.ASK_TERMS });
    await this.say(
      promoter.phone,
      `We couldn't check the name on ${formatGhanaLocal(momoNumber)} right now, so please make sure it's registered to you. You can change it later.`,
    );
    return this.promptStep(updated);
  }

  private async finishSignup(promoter: Promoter) {
    const inviteCode = promoter.pendingInviteCode;
    const active = await this.update(promoter, {
      status: PromoterStatus.ACTIVE,
      signupStep: null,
      termsAcceptedAt: new Date(),
      pendingInviteCode: null,
    });
    this.logger.log(`Promoter ${active.id} signed up.`);
    const firstName = active.fullName?.split(' ')[0] ?? '';
    await this.say(active.phone, `🎉 You're a MarketiX promoter${firstName ? `, ${firstName}` : ''}!`);
    if (inviteCode) return this.reportJoin(active, await this.promoters.acceptInvite(active, inviteCode));
    return this.sendMenu(active.phone);
  }

  /** (Re)send the question for the current sign-up step. */
  private promptStep(promoter: Promoter) {
    switch (promoter.signupStep ?? Step.ASK_NAME) {
      case Step.ASK_NAME:
        return this.say(promoter.phone, TEXT.askName);
      case Step.ASK_MOMO:
        return this.say(promoter.phone, TEXT.askMomo);
      case Step.CONFIRM_MOMO_NAME:
        return this.buttons(
          promoter.phone,
          `MoMo number ${formatGhanaLocal(promoter.momoNumber ?? '')} is registered to *${promoter.momoName}*. Is that you?`,
          [
            { id: PROMOTER_IDS.MOMO_YES, title: 'Yes, that’s me' },
            { id: PROMOTER_IDS.MOMO_NO, title: 'Use another number' },
          ],
        );
      case Step.ASK_TERMS:
        return this.buttons(promoter.phone, TEXT.terms, [{ id: PROMOTER_IDS.AGREE, title: 'I agree' }]);
    }
  }

  // ───────────────────────── Shops and links ─────────────────────────

  private async sendShops(promoter: Promoter, page: number) {
    const { shops, hasMore } = await this.promoters.openShops(page);
    if (!shops.length) return this.say(promoter.phone, page ? 'No more shops. Send *SHOPS* to start again.' : TEXT.noShops);
    const rows = shops.map((shop) => ({
      id: `${PROMOTER_IDS.REQUEST}${shop.id}`,
      title: shop.name,
      description: [shop.market, `${shop.promoterRate}% commission`].filter(Boolean).join(' · '),
    }));
    if (hasMore) rows.push({ id: `${PROMOTER_IDS.SHOPS_PAGE}${page + 1}`, title: 'More shops ➡️', description: '' });
    const from = this.sender();
    if (!from) return;
    await this.waba.sendInteractiveList({
      phoneNumberId: from,
      toPhone: toInternationalDigits(promoter.phone),
      bodyText: "Pick a shop to promote. The shop approves you, then I'll send your links.",
      buttonText: 'See shops',
      sectionTitle: 'Shops taking promoters',
      rows,
    });
  }

  private async reportJoin(promoter: Promoter, result: JoinResult) {
    const phone = promoter.phone;
    switch (result.kind) {
      case 'requested':
        return this.say(phone, `✅ Request sent to *${result.shopName}*. I'll message you when they approve you.`);
      case 'approved':
        await this.say(phone, `🎉 *${result.shopName}* has approved you as a promoter!`);
        return this.sendLinks(promoter, result.tenantId);
      case 'already_requested':
        return this.say(phone, `You've already asked *${result.shopName}*. They haven't decided yet.`);
      case 'already_approved':
        return this.say(phone, `You already promote *${result.shopName}*. Send *LINKS* to get your links.`);
      case 'not_accepted':
        return this.say(phone, `*${result.shopName}* isn't taking you on as a promoter right now.`);
      case 'closed':
        return this.say(phone, TEXT.closed);
      case 'invalid_invite':
        return this.say(phone, TEXT.invalidInvite);
      case 'wrong_number':
        return this.say(phone, TEXT.wrongNumber);
    }
  }

  /** One ready-to-forward message per link: all shops, one shop, or just the links with these codes. */
  async sendLinks(promoter: Pick<Promoter, 'id' | 'phone'>, tenantId?: string, onlyCodes?: string[]) {
    let links = await this.promoters.activeLinks(promoter.id, tenantId);
    if (onlyCodes) links = links.filter((link) => onlyCodes.includes(link.code));
    if (!links.length) return this.say(promoter.phone, TEXT.noLinks);

    const more = links.length > MAX_LINKS_SENT ? ` (the first ${MAX_LINKS_SENT} of ${links.length})` : '';
    await this.say(promoter.phone, `Here are your links${more}. Forward each message below to your contacts, groups or Status 👇`);
    for (const link of links.slice(0, MAX_LINKS_SENT)) {
      await this.say(
        promoter.phone,
        shareText({
          code: link.code,
          shopName: link.tenant.name,
          market: link.tenant.market,
          shopNumber: link.tenant.whatsappNumber ?? '',
          productName: link.product?.name,
        }),
      );
    }
  }

  private sendMenu(phone: string) {
    return this.buttons(phone, TEXT.menu, [
      { id: PROMOTER_IDS.SHOPS, title: 'Find shops' },
      { id: PROMOTER_IDS.LINKS, title: 'My links' },
    ]);
  }

  // ───────────────────────── Helpers ─────────────────────────

  /** Record the message as handled; false if it already was (Meta retries webhooks). */
  private async claim(promoterId: string, messageId: string): Promise<boolean> {
    const { count } = await this.prisma.promoter.updateMany({
      where: { id: promoterId, OR: [{ lastInboundMessageId: null }, { lastInboundMessageId: { not: messageId } }] },
      data: { lastInboundMessageId: messageId },
    });
    return count === 1;
  }

  private update(promoter: Promoter, data: Prisma.PromoterUpdateInput) {
    return this.prisma.promoter.update({ where: { id: promoter.id }, data });
  }

  /** A plain message to a promoter from the platform number, best effort (for the vendor side's news). */
  tell(phone: string, text: string) {
    return this.say(phone, text);
  }

  /** The sending number, or null (logged) when PLATFORM_PHONE_NUMBER_ID isn't set, so nothing is sent. */
  private sender(): string | null {
    const id = PromoterBotService.platformNumberId();
    if (!id) this.logger.warn('Promoter message skipped: PLATFORM_PHONE_NUMBER_ID is not set.');
    return id || null;
  }

  private async say(phone: string, text: string) {
    const from = this.sender();
    if (!from) return;
    try {
      await this.waba.sendTextMessage(from, toInternationalDigits(phone), text);
    } catch (err: any) {
      this.logger.warn(`Promoter reply to ${phone} failed: ${err?.message || err}`);
    }
  }

  private async buttons(phone: string, bodyText: string, buttons: { id: string; title: string }[]) {
    const from = this.sender();
    if (!from) return;
    try {
      await this.waba.sendInteractiveButtons({
        phoneNumberId: from,
        toPhone: toInternationalDigits(phone),
        bodyText,
        buttons,
      });
    } catch (err: any) {
      this.logger.warn(`Promoter buttons to ${phone} failed: ${err?.message || err}`);
    }
  }
}
