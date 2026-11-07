import { Prisma, Promoter, PromoterSignupStep, PromoterStatus } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROMOTER_IDS } from './promoter-rules.js';
import { PromoterBotService } from './promoter-bot.service.js';

const PHONE = '+233244111222';

/** Just enough of prisma.promoter, in memory. */
function fakePrisma() {
  const rows = new Map<string, Promoter>();
  const byId = (id: string) => [...rows.values()].find((r) => r.id === id)!;
  return {
    rows,
    promoter: {
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.phone) ?? null),
      create: vi.fn(async ({ data }: any) => {
        if (rows.has(data.phone)) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        const row = {
          id: `p-${rows.size + 1}`,
          fullName: null, momoNumber: null, momoNetwork: null, momoName: null, momoVerifiedAt: null, termsAcceptedAt: null,
          status: PromoterStatus.SIGNING_UP, signupStep: PromoterSignupStep.ASK_NAME, pendingInviteCode: null, lastInboundMessageId: null,
          createdAt: new Date(), modifiedAt: new Date(),
          ...data,
        } as Promoter;
        rows.set(row.phone, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(byId(where.id), data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = byId(where.id);
        if (row.lastInboundMessageId === data.lastInboundMessageId) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
}

describe('PromoterBotService', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let waba: { sendTextMessage: ReturnType<typeof vi.fn>; sendInteractiveButtons: ReturnType<typeof vi.fn>; sendInteractiveList: ReturnType<typeof vi.fn> };
  let promoters: Record<string, ReturnType<typeof vi.fn>>;
  let transfers: { resolveMomoName: ReturnType<typeof vi.fn> };
  let payouts: { summary: ReturnType<typeof vi.fn>; withdraw: ReturnType<typeof vi.fn> };
  let bot: PromoterBotService;
  let n = 0;

  /** Send a message from PHONE and return everything the bot said back, as text. */
  const send = async (text: string, phone = PHONE) => {
    waba.sendTextMessage.mockClear();
    waba.sendInteractiveButtons.mockClear();
    waba.sendInteractiveList.mockClear();
    await bot.handle({ phone, text, messageId: `wamid.${++n}` });
    return [
      ...waba.sendTextMessage.mock.calls.map((c) => c[2] as string),
      ...waba.sendInteractiveButtons.mock.calls.map((c) => c[0].bodyText as string),
      ...waba.sendInteractiveList.mock.calls.map((c) => c[0].bodyText as string),
    ].join('\n');
  };
  const promoter = () => prisma.rows.get(PHONE)!;

  beforeEach(() => {
    vi.stubEnv('PLATFORM_PHONE_NUMBER_ID', 'PLATFORM_ID');
    prisma = fakePrisma();
    waba = {
      sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'out' }),
      sendInteractiveButtons: vi.fn().mockResolvedValue({ messageId: 'out' }),
      sendInteractiveList: vi.fn().mockResolvedValue({ messageId: 'out' }),
    };
    promoters = {
      findOpenInvite: vi.fn().mockResolvedValue(null),
      acceptInvite: vi.fn(),
      requestToJoin: vi.fn(),
      openShops: vi.fn().mockResolvedValue({ shops: [], hasMore: false }),
      activeLinks: vi.fn().mockResolvedValue([]),
    };
    transfers = { resolveMomoName: vi.fn().mockResolvedValue({ ok: true, name: 'AMA MENSAH' }) };
    payouts = { summary: vi.fn(), withdraw: vi.fn() };
    bot = new PromoterBotService(prisma as any, waba as any, promoters as any, transfers as any, payouts as any);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('explains the programme to a stranger without signing them up', async () => {
    expect(await send('hello')).toContain('MarketiX Promoters');
    expect(waba.sendInteractiveButtons.mock.calls[0][0].buttons[0].id).toBe(PROMOTER_IDS.START);
    expect(prisma.rows.size).toBe(0);
  });

  it('signs a promoter up: name, MoMo number checked with Paystack, terms', async () => {
    expect(await send(PROMOTER_IDS.START)).toContain('full name');
    expect(await send('Ama Mensah')).toContain('MoMo number');
    expect(await send('024 411 1222')).toContain('registered to *AMA MENSAH*');
    expect(transfers.resolveMomoName).toHaveBeenCalledWith({ momoNumber: '0244111222', network: 'MTN' });
    expect(await send(PROMOTER_IDS.MOMO_YES)).toContain('Before you start');
    expect(await send(PROMOTER_IDS.AGREE)).toContain("You're a MarketiX promoter, Ama!");

    expect(promoter()).toMatchObject({
      status: PromoterStatus.ACTIVE,
      signupStep: null,
      fullName: 'Ama Mensah',
      momoNumber: '0244111222',
      momoNetwork: 'MTN',
      momoName: 'AMA MENSAH',
    });
    expect(promoter().momoVerifiedAt).toBeInstanceOf(Date);
    expect(promoter().termsAcceptedAt).toBeInstanceOf(Date);
  });

  it('asks again for a bad name or MoMo number, and lets them change the number', async () => {
    await send('I want to promote');
    expect(await send('024')).toContain('full name, for example');
    await send('Ama Mensah');
    expect(await send('12345')).toContain("doesn't look like a Ghana MoMo number");
    await send('0244111222');
    expect(await send(PROMOTER_IDS.MOMO_NO)).toContain('MoMo number');
    expect(promoter()).toMatchObject({ momoNumber: null, signupStep: PromoterSignupStep.ASK_MOMO });
  });

  it('carries on unverified when Paystack cannot tell the name', async () => {
    transfers.resolveMomoName.mockResolvedValue({ ok: false, reason: 'unsupported' });
    await send('promote');
    await send('Ama Mensah');
    const reply = await send('0201234567');
    expect(reply).toContain("couldn't check the name");
    expect(reply).toContain('Before you start');
    expect(promoter()).toMatchObject({ momoNetwork: 'VOD', momoName: null, momoVerifiedAt: null, signupStep: PromoterSignupStep.ASK_TERMS });
  });

  it('handles a message Meta delivers twice only once', async () => {
    await send('promote');
    await bot.handle({ phone: PHONE, text: 'Ama Mensah', messageId: 'wamid.same' });
    await bot.handle({ phone: PHONE, text: 'Kofi Boateng', messageId: 'wamid.same' });
    expect(promoter().fullName).toBe('Ama Mensah');
  });

  it('starts sign-up from an invite meant for this number and accepts it at the end', async () => {
    promoters.findOpenInvite.mockResolvedValue({ inviteCode: 'K7Q2MX', invitedPhone: PHONE });
    promoters.acceptInvite.mockResolvedValue({ kind: 'approved', shopName: "Auntie Esi's", tenantId: 't-1' });

    expect(await send('JOIN K7Q2MX')).toContain("You've been invited");
    expect(promoter().pendingInviteCode).toBe('K7Q2MX');
    await send('Ama Mensah');
    await send('0244111222');
    await send(PROMOTER_IDS.MOMO_YES);
    const reply = await send(PROMOTER_IDS.AGREE);

    expect(promoters.acceptInvite).toHaveBeenCalledWith(expect.objectContaining({ id: promoter().id }), 'K7Q2MX');
    expect(reply).toContain("*Auntie Esi's* has approved you");
    expect(promoters.activeLinks).toHaveBeenCalledWith(promoter().id, 't-1');
    expect(promoter().pendingInviteCode).toBeNull();
  });

  it("refuses an invite sent to someone else's number", async () => {
    promoters.findOpenInvite.mockResolvedValue({ inviteCode: 'K7Q2MX', invitedPhone: '+233200000000' });
    expect(await send('JOIN K7Q2MX')).toContain('different WhatsApp number');
    expect(prisma.rows.size).toBe(0);
  });

  describe('once signed up', () => {
    beforeEach(async () => {
      await prisma.promoter.create({ data: { phone: PHONE, fullName: 'Ama Mensah', status: PromoterStatus.ACTIVE, signupStep: null } });
    });

    it('lists shops taking promoters, with a row for the next page', async () => {
      promoters.openShops.mockResolvedValue({ shops: [{ id: 't-1', name: "Auntie Esi's", market: 'Madina', promoterRate: 10 }], hasMore: true });
      await send('SHOPS');
      const rows = waba.sendInteractiveList.mock.calls[0][0].rows;
      expect(rows).toEqual([
        { id: `${PROMOTER_IDS.REQUEST}t-1`, title: "Auntie Esi's", description: 'Madina · 10% commission' },
        { id: `${PROMOTER_IDS.SHOPS_PAGE}1`, title: 'More shops ➡️', description: '' },
      ]);
    });

    it('sends a request to the shop and says so', async () => {
      promoters.requestToJoin.mockResolvedValue({ kind: 'requested', shopName: "Auntie Esi's" });
      expect(await send(`${PROMOTER_IDS.REQUEST}t-1`)).toContain("Request sent to *Auntie Esi's*");
      expect(promoters.requestToJoin).toHaveBeenCalledWith(expect.objectContaining({ phone: PHONE }), 't-1');
    });

    it('sends one forwardable message per link', async () => {
      promoters.activeLinks.mockResolvedValue([
        { code: 'AAAAAA', tenant: { name: "Auntie Esi's", market: 'Madina', whatsappNumber: '+233200000001' }, product: null },
        { code: 'BBBBBB', tenant: { name: "Auntie Esi's", market: 'Madina', whatsappNumber: '+233200000001' }, product: { name: 'Rice' } },
      ]);
      const reply = await send('links');
      expect(waba.sendTextMessage).toHaveBeenCalledTimes(3);
      expect(reply).toContain('ref%20AAAAAA');
      expect(reply).toContain('*Rice* from');
    });

    it('shows earnings with a Withdraw button once enough is ready', async () => {
      payouts.summary.mockResolvedValue({
        balance: 4500, available: 2500, onHold: 2000, nextReleaseAt: new Date('2026-11-14T10:00:00Z'), inFlight: 0, earned: 4500, minWithdrawal: 2000,
        recent: [{ amount: 1500, shopName: "Auntie Esi's", orderNumber: 'MX-AB12CD' }],
      });
      const reply = await send('earnings');
      expect(reply).toContain('Ready to withdraw: *GH₵ 25.00*');
      expect(reply).toContain('On the way: GH₵ 20.00');
      expect(reply).toContain("GH₵ 15.00 · Auntie Esi's · MX-AB12CD");
      expect(waba.sendInteractiveButtons.mock.calls[0][0].buttons).toEqual([{ id: PROMOTER_IDS.WITHDRAW, title: 'Withdraw GH₵ 25.00' }]);
    });

    it('says why a withdrawal was refused, or that the money is on its way', async () => {
      payouts.withdraw.mockResolvedValueOnce({ kind: 'refused', message: 'You can withdraw once a day. Try again tomorrow.' });
      expect(await send('WITHDRAW')).toBe('You can withdraw once a day. Try again tomorrow.');
      promoter().momoNumber = '0244111222';
      payouts.withdraw.mockResolvedValueOnce({ kind: 'processing', amount: 2500, momoNumber: '0244111222' });
      expect(await send(PROMOTER_IDS.WITHDRAW)).toContain('GH₵ 25.00 is on its way to your MoMo (024 411 1222)');
    });

    it('shows the menu for anything else, and nothing for a suspended promoter but a notice', async () => {
      expect(await send('what is this')).toContain('What would you like to do?');
      promoter().status = PromoterStatus.SUSPENDED;
      expect(await send('SHOPS')).toContain('paused');
      expect(promoters.openShops).not.toHaveBeenCalled();
    });
  });

  it('sends nothing when the platform number is not configured', async () => {
    vi.stubEnv('PLATFORM_PHONE_NUMBER_ID', '');
    await send('hello');
    await send(PROMOTER_IDS.START);
    expect(waba.sendTextMessage).not.toHaveBeenCalled();
    expect(waba.sendInteractiveButtons).not.toHaveBeenCalled();
  });

  it("sends nothing when PLATFORM_PHONE_NUMBER_ID is a shop's number", async () => {
    (prisma as any).tenant = { findUnique: vi.fn().mockResolvedValue({ name: "Auntie Esi's" }) };
    await bot.onModuleInit();
    await send(PROMOTER_IDS.START);
    expect(waba.sendTextMessage).not.toHaveBeenCalled();
  });

  it('asks people with hidden numbers to use a visible one', async () => {
    expect(await send('promote', 'GH.989894404158856')).toContain('hide it');
    expect(prisma.rows.size).toBe(0);
  });
});
