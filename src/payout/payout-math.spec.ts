import { describe, expect, it } from 'vitest';
import { momoNetworkOf, orderSplit } from './payout-math.js';

describe('orderSplit', () => {
  it('takes 10% of the items only; the vendor keeps the whole delivery fee', () => {
    // GH₵ 1,050 total = GH₵ 1,000 items + GH₵ 50 delivery
    expect(orderSplit({ totalAmount: 1050, deliveryFee: 50 })).toEqual({ items: 100000, commission: 10000, deliveryFee: 5000, vendorShare: 95000 });
  });

  it('works in whole pesewas, with no floating-point drift', () => {
    const split = orderSplit({ totalAmount: 25.55, deliveryFee: 5.1 });
    expect(split).toEqual({ items: 2045, commission: 205, deliveryFee: 510, vendorShare: 2350 });
    expect(split.items - split.commission + split.deliveryFee).toBe(split.vendorShare);
  });

  it('never lets a bad delivery fee push items below zero', () => {
    expect(orderSplit({ totalAmount: 10, deliveryFee: 15 })).toMatchObject({ items: 0, commission: 0, vendorShare: 1000 });
  });
});

describe('momoNetworkOf', () => {
  it.each([
    ['0244111222', 'MTN'],
    ['+233 55 123 4567', 'MTN'],
    ['0201234567', 'VOD'],
    ['233501234567', 'VOD'],
    ['0261234567', 'ATL'],
    ['0571234567', 'ATL'],
    ['0301234567', null],
  ])('%s → %s', (phone, network) => {
    expect(momoNetworkOf(phone)).toBe(network);
  });
});
