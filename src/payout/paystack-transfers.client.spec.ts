import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeTransferMode, PaystackTransfersClient } from './paystack-transfers.client.js';

const reply = (status: number, body: unknown) => Promise.resolve(new Response(body === undefined ? 'not json' : JSON.stringify(body), { status }));
const transfer = () => new PaystackTransfersClient().transfer({ amount: 1000, recipientCode: 'RCP_x', reference: 'payout_x', reason: 'test' });

describe('PaystackTransfersClient', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_x';
    delete process.env.PAYSTACK_FAKE_TRANSFERS;
    vi.stubGlobal('fetch', fetchMock.mockReset());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PAYSTACK_FAKE_TRANSFERS;
  });

  describe('transfer: never reports "failed" unless Paystack surely did not send it', () => {
    it('is unsure after a timeout or network error', async () => {
      fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
      expect(await transfer()).toMatchObject({ ok: false, unknown: true });
    });

    it('is unsure after a 5xx or an unreadable reply', async () => {
      fetchMock.mockReturnValueOnce(reply(502, { status: false, message: 'Bad gateway' }));
      expect(await transfer()).toMatchObject({ ok: false, unknown: true });
      fetchMock.mockReturnValueOnce(reply(200, undefined));
      expect(await transfer()).toMatchObject({ ok: false, unknown: true });
    });

    it('fails when Paystack refuses the request', async () => {
      fetchMock.mockReturnValue(reply(400, { status: false, message: 'Insufficient balance' }));
      expect(await transfer()).toEqual({ ok: false, reason: 'Insufficient balance' });
    });

    it('fails without calling Paystack when the key is not a secret key', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'pk_test_x';
      expect(await transfer()).toEqual({ ok: false, reason: 'PAYSTACK_SECRET_KEY is not set to a secret key (sk_…).' }); // definite, not "unknown"
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is accepted when Paystack queues or sends it', async () => {
      fetchMock.mockReturnValue(reply(200, { status: true, data: { status: 'pending', transfer_code: 'TRF_1' } }));
      expect(await transfer()).toEqual({ ok: true, status: 'pending', transferCode: 'TRF_1' });
    });
  });

  describe('verifyTransfer', () => {
    const verify = () => new PaystackTransfersClient().verifyTransfer('payout_x');

    it.each([
      ['success', { state: 'success' }],
      ['reversed', { state: 'failed' }],
      ['failed', { state: 'failed' }],
      ['pending', { state: 'pending' }],
      ['otp', { state: 'pending' }],
      ['something-new', { state: 'unknown' }],
    ])('maps Paystack status %s', async (status, expected) => {
      fetchMock.mockReturnValue(reply(200, { status: true, data: { status } }));
      expect(await verify()).toMatchObject(expected);
    });

    it('knows when Paystack never got the transfer', async () => {
      fetchMock.mockReturnValue(reply(404, { status: false, message: 'Transfer not found' }));
      expect(await verify()).toEqual({ state: 'not_found' });
    });

    it('is unsure when Paystack can not be reached', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      expect(await verify()).toMatchObject({ state: 'unknown' });
      fetchMock.mockReset().mockReturnValue(reply(503, { status: false }));
      expect(await verify()).toMatchObject({ state: 'unknown' });
    });

    it('asks for the reference it was given', async () => {
      fetchMock.mockReturnValue(reply(200, { status: true, data: { status: 'success' } }));
      await verify();
      expect(fetchMock).toHaveBeenCalledWith('https://api.paystack.co/transfer/verify/payout_x', expect.objectContaining({ method: 'GET' }));
    });
  });

  describe('PAYSTACK_FAKE_TRANSFERS (local testing)', () => {
    const client = () => new PaystackTransfersClient();
    const send = () => client().transfer({ amount: 1000, recipientCode: 'RCP_FAKE', reference: 'payout_x', reason: 'test' });

    it.each([
      ['success', { ok: true, status: 'success' }, { state: 'success' }],
      ['pending', { ok: true, status: 'pending' }, { state: 'success' }],
      ['fail', { ok: false }, { state: 'failed' }],
      ['unknown', { ok: false, unknown: true }, { state: 'not_found' }],
    ])('%s: fakes the transfer and its check, without calling Paystack', async (mode, transferResult, verifyResult) => {
      process.env.PAYSTACK_FAKE_TRANSFERS = mode;
      expect(await client().createMomoRecipient({ name: 'Ama', momoNumber: '0244111222', network: 'MTN' })).toEqual({ ok: true, code: 'RCP_FAKE' });
      expect(await send()).toMatchObject(transferResult);
      expect(await client().verifyTransfer('payout_x')).toMatchObject(verifyResult);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is off when unset', () => {
      expect(fakeTransferMode({})).toBeNull();
    });

    it('refuses to run in production, with a live key, or with a typo', () => {
      expect(() => fakeTransferMode({ PAYSTACK_FAKE_TRANSFERS: 'success', NODE_ENV: 'production' })).toThrow('local testing only');
      expect(() => fakeTransferMode({ PAYSTACK_FAKE_TRANSFERS: 'success', PAYSTACK_SECRET_KEY: 'sk_live_abc' })).toThrow('local testing only');
      expect(() => fakeTransferMode({ PAYSTACK_FAKE_TRANSFERS: 'yes' })).toThrow('must be one of');
    });

    it('stops the server at startup when unsafe', () => {
      process.env.PAYSTACK_FAKE_TRANSFERS = 'success';
      process.env.PAYSTACK_SECRET_KEY = 'sk_live_abc';
      expect(() => client().onModuleInit()).toThrow('local testing only');
    });
  });
});
