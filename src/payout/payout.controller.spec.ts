import { describe, expect, it, vi } from 'vitest';
import { PayoutController, VENDOR_FAILURE_MESSAGE } from './payout.controller.js';

const failed = { id: 'p1', status: 'FAILED', failureReason: 'You cannot initiate third party payouts as a starter business' };
const paid = { id: 'p2', status: 'SUCCESS', failureReason: null };

describe('PayoutController: vendors never see Paystack’s own failure reasons', () => {
  const reports = {
    shopSummary: vi.fn().mockResolvedValue({ balance: 100, lastPayout: failed }),
    shopEntries: vi.fn().mockResolvedValue({ data: [{ id: 'e1', payout: failed }, { id: 'e2', payout: null }], meta: {} }),
    payoutList: vi.fn().mockResolvedValue({ data: [failed, paid], meta: {} }),
  };
  const payouts = { withdraw: vi.fn().mockResolvedValue(failed) };
  const tenants = { findByUser: vi.fn().mockResolvedValue({ id: 't1' }) };
  const controller = new PayoutController(reports as any, payouts as any, tenants as any, {} as any);
  const req = { user: { id: 'u1' } };

  it('in the summary', async () => {
    expect((await controller.summary(req)).lastPayout).toEqual({ ...failed, failureReason: VENDOR_FAILURE_MESSAGE });
  });

  it('in the statement', async () => {
    const { data } = await controller.statement(req, 1, 20);
    expect(data.map((e) => e.payout?.failureReason ?? null)).toEqual([VENDOR_FAILURE_MESSAGE, null]);
  });

  it('in the payout list', async () => {
    const { data } = await controller.list(req, undefined, 1, 20);
    expect(data.map((p) => p.failureReason)).toEqual([VENDOR_FAILURE_MESSAGE, null]);
  });

  it('in the reply to a withdrawal', async () => {
    expect(await controller.withdraw(req, { amount: 20000 })).toMatchObject({ failureReason: VENDOR_FAILURE_MESSAGE });
    expect(payouts.withdraw).toHaveBeenCalledWith('t1', 'u1', 20000);
  });
});
