import { Injectable, Logger } from '@nestjs/common';

export type TransferOutcome =
  /** Paystack accepted it; the transfer.success / transfer.failed webhook settles it. */
  | { ok: true; status: 'success' | 'pending'; transferCode: string | null }
  /** Paystack definitely did not send it (it refused the request, or the transfer failed). */
  | { ok: false; unknown?: false; reason: string }
  /**
   * We can't tell whether Paystack received it (timeout, network error, 5xx, unreadable
   * reply). The money may have gone out, so this must not be refunded: check with
   * verifyTransfer() later.
   */
  | { ok: false; unknown: true; reason: string };

/** What Paystack says happened to a transfer, by our reference. */
export type TransferState =
  | { state: 'success' }
  | { state: 'failed'; reason: string }
  | { state: 'pending' }
  /** Paystack has no transfer with this reference: it never went out. */
  | { state: 'not_found' }
  /** Couldn't ask (network error, 5xx): try again later. */
  | { state: 'unknown'; reason: string };

/** Paystack transfer statuses that mean the money did not reach the vendor (and won't). */
const FAILED_STATES = new Set(['failed', 'reversed', 'abandoned', 'blocked', 'rejected']);
const PENDING_STATES = new Set(['pending', 'processing', 'received', 'queued', 'otp']);

/** Paystack Transfers: MoMo payouts to vendors from MarketiX's Paystack balance. */
@Injectable()
export class PaystackTransfersClient {
  private readonly logger = new Logger(PaystackTransfersClient.name);
  private readonly baseUrl = 'https://api.paystack.co';

  /** A transfer recipient for a Ghana MoMo wallet. Returns its recipient code. */
  async createMomoRecipient(params: { name: string; momoNumber: string; network: string }): Promise<{ ok: true; code: string } | { ok: false; reason: string }> {
    const res = await this.post('/transferrecipient', {
      type: 'mobile_money',
      name: params.name,
      account_number: params.momoNumber,
      bank_code: params.network,
      currency: 'GHS',
    });
    const code = res.data?.data?.recipient_code;
    if (res.ok && code) return { ok: true, code };
    return { ok: false, reason: this.reason(res, 'Paystack would not accept this MoMo number as a payout recipient.') };
  }

  /** Sends `amount` pesewas from the Paystack balance to a recipient. */
  async transfer(params: { amount: number; recipientCode: string; reference: string; reason: string }): Promise<TransferOutcome> {
    const res = await this.post('/transfer', {
      source: 'balance',
      amount: params.amount,
      recipient: params.recipientCode,
      reference: params.reference,
      reason: params.reason,
      currency: 'GHS',
    });
    const data = res.data?.data;
    if (res.uncertain || (res.ok && !data)) {
      return { ok: false, unknown: true, reason: this.reason(res, 'No clear answer from Paystack about the transfer.') };
    }
    if (!res.ok || !data) {
      return { ok: false, reason: this.reason(res, 'Paystack did not accept the transfer.') };
    }
    if (data.status === 'otp') {
      return { ok: false, reason: 'Paystack asked for an OTP. Turn off OTP for transfers in your Paystack settings, then retry.' };
    }
    if (data.status === 'success' || data.status === 'pending' || data.status === 'received' || data.status === 'processing') {
      return { ok: true, status: data.status === 'success' ? 'success' : 'pending', transferCode: data.transfer_code ?? null };
    }
    return { ok: false, reason: `Paystack reported the transfer as ${data.status}.` };
  }

  /**
   * Asks Paystack what happened to a transfer. Webhooks only prompt this check: the money
   * is moved on what Paystack's API says, so a replayed or stale webhook can't refund a
   * transfer that was paid.
   */
  async verifyTransfer(reference: string): Promise<TransferState> {
    const res = await this.request('GET', `/transfer/verify/${encodeURIComponent(reference)}`);
    if (res.uncertain) return { state: 'unknown', reason: this.reason(res, 'No clear answer from Paystack.') };
    if (res.status === 404 || (!res.ok && /not found/i.test(String(res.data?.message ?? '')))) return { state: 'not_found' };
    const data = res.data?.data;
    if (!res.ok || !data) return { state: 'unknown', reason: this.reason(res, 'Paystack could not look up the transfer.') };

    const status = String(data.status ?? '').toLowerCase();
    if (status === 'success') return { state: 'success' };
    if (FAILED_STATES.has(status)) return { state: 'failed', reason: data.reason || data.gateway_response || `Paystack reported the transfer as ${status}.` };
    if (PENDING_STATES.has(status)) return { state: 'pending' };
    return { state: 'unknown', reason: `Paystack reported an unexpected transfer status: ${status || 'none'}.` };
  }

  private reason(res: { data: any; error?: string }, fallback: string): string {
    return res.error || res.data?.message || fallback;
  }

  private post(path: string, payload: Record<string, unknown>) {
    return this.request('POST', path, payload);
  }

  /**
   * `uncertain`: no reliable answer (network error, timeout, 5xx, unreadable body), so for a
   * transfer we can't tell whether Paystack acted on it.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; data: any; uncertain: boolean; error?: string }> {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key || key.startsWith('pk_')) {
      // Nothing was sent, so this is a definite refusal.
      return { ok: false, status: 0, data: null, uncertain: false, error: 'PAYSTACK_SECRET_KEY is not set to a secret key (sk_…).' };
    }
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(payload && { 'Content-Type': 'application/json' }) },
        ...(payload && { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, data, uncertain: response.status >= 500 || data === null };
    } catch (err: any) {
      this.logger.error(`Paystack ${method} ${path} failed: ${err?.message || err}`);
      return { ok: false, status: 0, data: null, uncertain: true, error: 'Could not reach Paystack. Try again shortly.' };
    }
  }
}
