# Promoters: v1 spec

Promoters share a vendor's shop or products on WhatsApp. When a new buyer orders through their link, the promoter earns a commission that the vendor pays.

*Status, 7 Nov 2026: phases 1 (bot), 2 (vendor side) and 3 (attribution) built; money and admin to do.*

---

## Contents

1. [Decisions](#decisions)
2. [How it works end to end](#how-it-works-end-to-end)
3. [Data model](#data-model)
4. [The promoter on WhatsApp](#the-promoter-on-whatsapp)
5. [Attribution: which order belongs to which promoter](#attribution-which-order-belongs-to-which-promoter)
6. [Money](#money)
7. [Vendor API](#vendor-api)
8. [Admin API](#admin-api)
9. [Web app (OMNISCIENT_GOD)](#web-app-omniscient_god)
10. [Build order](#build-order)
11. [Later](#later)

---

## Decisions

| Topic | v1 rule |
|---|---|
| Who can be a promoter | Anyone. Sign-up is open on the platform WhatsApp number and needs a verified MoMo number. A vendor can also be a promoter. |
| Who approves | **Each vendor approves promoters for their own shop.** Promoters ask to join, or the vendor invites them. |
| What is promoted | The **whole shop** or a **single product**. A promoter can have one shop link and any number of product links per vendor. |
| Commission rate | **The vendor sets it**: a shop rate, plus an optional per-product rate that overrides it. Allowed range is 1–20%. |
| What it is paid on | Shop link: all items in the order. Product link: only the order lines for that product. The delivery fee is never included. |
| Which orders count | Only the buyer's **first order with that shop**, placed within **14 days** of tapping the link. |
| Two links tapped | The **last link tapped** gets the credit. |
| Rate changes | The rate is **locked when the buyer taps the link**. |
| When it is earned | The order was **paid by MoMo or card** and **delivered**. Cash-on-delivery orders earn nothing. |
| Hold | Commission becomes withdrawable **7 days** after delivery. |
| Payout | The promoter withdraws to MoMo through Paystack transfers. The minimum is **GH₵ 20**. |
| Promoter removed | Their links stop working. Commission already earned is still paid. Buyers who already tapped a link still count until the 14 days end. |
| Fraud | No commission if the buyer's number or MoMo number matches the promoter's number or MoMo number. |
| Vendor privacy | A vendor can turn off "accept requests from new promoters" and still invite people. |

### Three changes from what we discussed, because of how the code and WhatsApp work

1. **Promoters withdraw when they choose, with no weekly automatic run.** Vendors already work this way (`PayoutService`: withdraw once per Accra day), and the app has no scheduler. This reuses everything and needs no cron. The promoter sends `WITHDRAW` to the bot.
2. **Invites are sent by the vendor, not by the platform.** WhatsApp only lets a business send free-form messages to someone who has messaged it in the last 24 hours. Anything else needs a Meta-approved template, and the app has no templates yet. So an invite produces a **join link** (`wa.me/<platform>?text=JOIN K7Q2MX`), and the vendor forwards it from their own phone. When the invitee taps it, they're the one starting the chat.
3. **Promoter commission comes on top of the MarketiX 10%.** The vendor pays both. The promoter rate is capped at 20%, so at the maximum the vendor keeps 70% of the item value on that order. The web app must show this clearly when the vendor sets a rate.

---

## How it works end to end

1. **Ama signs up.** She messages the platform number "I want to promote", gives her name and MoMo number, confirms the name Paystack returns, and accepts the terms.
2. **Ama joins a shop.** She sends `SHOPS`, picks Auntie Esi's Groceries and requests to join. Auntie Esi gets a WhatsApp alert. In the web app she approves Ama for **the whole shop** or for **chosen products**.
3. **Ama gets her links.** The bot sends one message per link with ready-to-forward text:
   > Fresh groceries from Auntie Esi's, delivered in Madina 🍅
   > Order here 👉 wa.me/233XXXXXXXXX?text=Hi!%20I%27d%20like%20to%20order%20(ref%20K7Q2MX)
4. **Kofi taps the link** and messages the shop. The shop's chat sees `(ref K7Q2MX)` and records a **referral**: Kofi, this shop, this link, the rate today, expiring in 14 days.
5. **Kofi orders** within 14 days. It's his first order with the shop, so the referral attaches to the order.
6. **The order is paid by MoMo and delivered.** When the vendor's earning is recorded, the commission is calculated. It's taken from the vendor's balance and credited to Ama, withdrawable in 7 days. Ama gets a WhatsApp message: "You earned GH₵ 12.00 from Auntie Esi's."
7. **Ama withdraws.** She sends `WITHDRAW` and the money arrives in her MoMo wallet.

**Invite path:** Auntie Esi enters Yaw's number and what he may promote. She gets a join link and sends it to Yaw. Yaw taps it, signs up (step 1) if he's new, and is approved straight away. Then step 3 follows.

---

## Data model

Amounts are in **pesewas** (`Int`), as in `VendorLedgerEntry`. Rates are whole percent (`Int`, 1–20).

### Changes to existing models

| Model | New fields |
|---|---|
| `Tenant` | `promotionsEnabled Boolean @default(false)`, `acceptPromoterRequests Boolean @default(true)`, `promoterRate Int?` (required before promotions can be enabled) |
| `Product` | `promoterRate Int?`. Null means the shop rate applies. |
| `LedgerEntryType` | `PROMOTER_COMMISSION`: a negative amount on the vendor's ledger. The existing `@@unique([orderId, type])` keeps it to one per order. |

### New models

**`Promoter`**: one per phone number.
`id`, `phone @unique`, `fullName`, `momoNumber`, `momoNetwork`, `momoName` (returned by Paystack resolve), `momoVerifiedAt`, `termsAcceptedAt`, `status` (`SIGNING_UP | ACTIVE | SUSPENDED`), `signupStep` (where the sign-up chat is, e.g. `ASK_NAME`), `pendingInviteCode` (an invite accepted once sign-up finishes), `lastInboundMessageId` (so a message Meta delivers twice is handled once), timestamps. Phase 4 adds `paystackRecipientCode` and `paystackRecipientFor`.

**`PromoterMembership`**: a promoter's relationship with one shop.
`id`, `tenantId`, `promoterId?` (null while an invite is unaccepted), `invitedPhone?`, `inviteCode? @unique`, `status` (`REQUESTED | INVITED | APPROVED | DECLINED | REMOVED`), `requestedAt`, `decidedAt`, `removedAt`.
`@@unique([tenantId, promoterId])`.

**`PromoLink`**: one shareable link.
`id`, `code @unique` (6 characters, no look-alike letters, e.g. `K7Q2MX`), `membershipId`, `tenantId`, `promoterId`, `productId?` (null means the whole shop), `active Boolean`, `createdAt`.
Only one active shop link per membership, enforced in code or with a partial unique index.

**`Referral`**: "this buyer tapped this link".
`id`, `tenantId`, `buyerPhone`, `promoterId`, `linkId?`, plus copies of `linkCode`, `productId?` and `productName?` (so it outlives a deleted link or product), `ratePercent` (locked), `tappedAt`, `expiresAt` (tappedAt + 14 days), `orderId? @unique` (Order gets a `referral` back-relation), `attachedAt`, `baseAmount` and `commissionAmount` (pesewas, worked out when the order is attached). Its state (`WAITING`, `EXPIRED`, `PENDING`, `EARNED`, `NO_COMMISSION` with a reason: `CANCELLED`, `CASH`, `OWN_NUMBER`, `PRODUCT_NOT_IN_ORDER`) is worked out from the order each time (`referral-rules.ts`), not stored.
`@@index([tenantId, buyerPhone, tappedAt])`.

**`PromoterLedgerEntry`**: the promoter's balance, working like `VendorLedgerEntry`.
`id`, `promoterId`, `type` (`COMMISSION | PAYOUT | PAYOUT_REVERSAL`), `amount`, `orderId?`, `orderNumber?`, `tenantId?`, `payoutId?`, `details Json?`, `availableAt?`, `createdAt`.
`@@unique([orderId, type])`.

**`PromoterPayout`**: mirrors `VendorPayout` (`amount`, `status`, `reference`, `transferCode`, `momoNumber`, `momoName`, `failureReason`, `paidAt`).

---

## The promoter on WhatsApp

All of this happens on the **platform number** (`PLATFORM_PHONE_NUMBER_ID`). Today `WabaWebhookController` drops messages sent to it, because no tenant owns that number. The new branch is: if `phone_number_id` is the platform number, pass the message to a new `PromoterChatService`.

Commands are case-insensitive and work as plain text. Interactive buttons and lists are used where they help.

| Message | What happens |
|---|---|
| Anything, from an unknown number | A short explanation of the programme, with a **Become a promoter** button |
| `PROMOTE` / the button | Sign-up: name → MoMo number → "This number belongs to AMA MENSAH. Is that you?" (Yes/No) → terms (Agree) → done |
| `JOIN K7Q2MX` | Accepts an invite. Runs sign-up first if the person is new, then approves them for that shop and sends the links |
| `SHOPS` | A list message (10 rows a page) of shops with `promotionsEnabled` and `acceptPromoterRequests`. Each row shows the name, market and rate. Tapping a row sends a request |
| `LINKS` | One message per active link, ready to forward |
| `EARNINGS` | Available, on hold (with the next release date), lifetime total, and the last 5 commissions |
| `WITHDRAW` | Pays out the available balance if it's at least GH₵ 20, once per Accra day |
| `HELP` | The command list |

The sign-up chat stores its progress in `Promoter.signupStep`, so a promoter can stop halfway and carry on later. The MoMo check uses Paystack's resolve-account endpoint through the existing transfers client.

Messages to promoters about approvals and earnings are sent **best effort**. If they fall outside the 24-hour window they may fail, and `EARNINGS` and `LINKS` always show the current state. Proper templates come later.

---

## Attribution: which order belongs to which promoter

**When a buyer messages a shop** (`ChatService.processIncomingMessage`):

1. Look for `ref <CODE>` in the text with a regex.
2. Record a `Referral` if all of these hold:
   - the link is active,
   - its membership is `APPROVED`,
   - the shop has `promotionsEnabled`,
   - the promoter is `ACTIVE`,
   - the buyer isn't the promoter,
   - the buyer has **no earlier order with this shop**.
3. The rate is locked at the product's `promoterRate`, or the shop rate if the product has none, or the shop rate for a shop link.
4. Continue as normal and send the Flow. The buyer sees no difference.

Hidden-number buyers have no usable phone number, so they can't be credited in v1.

**When an order is created** (Flow place order):

1. If this is the buyer's first order with the shop, find their **latest** referral for the shop that's unexpired and unused.
2. Attach it by setting `Referral.orderId`. A referral on an order that was cancelled or never paid moves to the new order; cancelled and unpaid orders don't make a buyer "not new".

A cash-on-delivery order still uses up the referral, because the buyer is no longer new; it shows as `NO_COMMISSION` (`CASH`). A product link whose first order lacks the product earns GH₵ 0 (`PRODUCT_NOT_IN_ORDER`). Orders that vendors enter by hand in the web app are never attributed.

**Fraud check, at settlement:** if the buyer's phone or `paymentPhone` equals the promoter's `phone` or `momoNumber`, it shows as `NO_COMMISSION` (`OWN_NUMBER`) and no money moves.

---

## Money

This hooks into `PayoutService.settleOrder`, right after a new `ORDER_EARNING` is recorded, so it inherits the existing rules: paid, delivered and confirmed (or released by an admin), and recorded only once.

```
base       = shop link    → split.items  (items total, no delivery fee)
             product link → sum of OrderItem.totalPrice where productId = link.productId
commission = round(base × ratePercent / 100), never more than the vendor's share
```

In one transaction:
- Vendor ledger: `PROMOTER_COMMISSION`, `-commission`, details `{ promoterId, linkCode, ratePercent, base }`
- Promoter ledger: `COMMISSION`, `+commission`, `availableAt` = delivery + 7 days (or the card hold, if that's later)

Vendor statements (`payout-report.service.ts`) get a "Promoter commission" line. The admin summary shows total promoter commission and promoter balances owed.

**Promoter withdrawals** reuse `PaystackTransfersClient` (recipient → transfer → webhook). The transfer webhook currently looks up `VendorPayout` by reference. Promoter payouts get a distinct reference prefix (`MXP-…`), so the webhook knows which table to update.

---

## Vendor API

These need the vendor JWT and live under `/promotions`.

| Method & path | Purpose |
|---|---|
| `GET /promotions/settings` | `{ promotionsEnabled, acceptPromoterRequests, promoterRate }` |
| `PATCH /promotions/settings` | Update the settings. Enabling needs a rate. The rate must be 1–20. |
| `PATCH /products/:id` | Accepts `promoterRate` (1–20, or null) on the existing product update |
| `GET /promotions/promoters?status=` | Memberships with the promoter's name, verified MoMo name, links, and orders, sales and commission so far |
| `POST /promotions/requests/:id/approve` | Body `{ scope: "shop" }` or `{ scope: "products", productIds: [...] }`. Creates the links and tells the promoter |
| `POST /promotions/requests/:id/decline` | Declines the request |
| `POST /promotions/invites` | Body `{ phone, scope, productIds? }` → `{ inviteCode, joinLink, shareText }` |
| `DELETE /promotions/invites/:id` | Cancels an unaccepted invite |
| `POST /promotions/promoters/:id/links` | Body `{ productId? }`. Adds a shop or product link |
| `DELETE /promotions/links/:id` | Deactivates a link |
| `DELETE /promotions/promoters/:id` | Removes the promoter and deactivates their links |
| `GET /promotions/sales?page=&limit=` | Credited orders: order no., promoter, link (shop or product), base, rate, commission, state and reason |

A new request also triggers a WhatsApp alert to the vendor's `ownerPhone` through `NotificationService`, as other vendor alerts do.

## Admin API

| Method & path | Purpose |
|---|---|
| `GET /admin/promoters` | List and search promoters: shops, balance, lifetime earnings, self-referral flags |
| `POST /admin/promoters/:id/suspend` and `/reinstate` | A suspended promoter's links stop counting and they can't withdraw (written to `AuditLog`) |
| `GET /admin/promoter-payouts` and `POST …/:id/retry` | Same as vendor payouts |

---

## Web app (OMNISCIENT_GOD)

**Vendor portal:**
- **New page `/vendor/promoters`** (in `VendorLayout` navigation):
  - **Settings card:** an on/off switch, an "Accept requests from new promoters" switch, and the shop rate. It includes a worked example: "On a GH₵ 100 order you keep GH₵ 70: MarketiX 10%, promoter 20%."
  - **Requests:** a list with Approve (choose *Whole shop* or *Pick products*) and Decline.
  - **Promoters:** each promoter with their links, orders, sales and commission. Actions: add a product link, remove a link, remove the promoter.
  - **Invite:** phone number plus scope. The result shows the join link and a **Copy** / **Share on WhatsApp** button.
  - **Sales from promoters:** the `/promotions/sales` table.
- **`ProductEditor`:** an optional "Promoter commission %" field, with "uses shop rate (x%)" as the placeholder.
- **`Money`:** the "Promoter commission" deduction shown in the statement.

**Admin:** a new **Promoters** page, and a promoter tab on **Payouts**.

---

## Build order

Each phase can ship and be tested on its own.

1. **Data and the promoter bot:** migrations, the platform-number webhook branch, sign-up with MoMo check, `SHOPS` / request, `JOIN` invites, `LINKS`, `HELP`.
2. **Vendor side:** the `/promotions` API, the request alert, and the vendor **Promoters** page plus the `ProductEditor` field in the web app.
3. **Attribution:** `ref` detection in `ChatService`, attaching referrals at order creation, and the "Sales from promoters" view.
4. **Money:** the commission in `settleOrder`, both ledgers, `EARNINGS`, `WITHDRAW` with promoter payouts and webhook routing, and the statement lines.
5. **Admin:** the promoters list, suspend and reinstate, the payouts tab, and summary figures.

Tests follow the existing pattern: unit specs for the commission maths and attribution rules, and `*.db.spec.ts` for the ledger and payouts.

---

## Later

Commission on cash-on-delivery orders, on repeat orders, buyer discounts on promoter links, product links that open the Flow on that product, Meta templates for invites and earnings alerts, a promoter web dashboard, a platform cut of commissions, leaderboards and bonuses.
