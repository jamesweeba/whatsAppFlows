# MarketiX: WhatsApp ordering backend

A NestJS + Prisma (PostgreSQL) backend that lets Ghanaian market vendors take grocery orders on WhatsApp. Buyers browse and check out inside a **WhatsApp Flow**. They pay by **MoMo** (via Paystack) or cash on delivery, and share a **map pin** so the rider can find them. Vendors manage products and orders through a JWT-protected REST API.

*Status as of 3 Nov 2026: working end to end against a draft Flow on Meta. The flow redesign described below is not yet committed.*

---

## Contents

1. [Architecture](#architecture)
2. [The buyer journey](#the-buyer-journey)
3. [The WhatsApp Flow](#the-whatsapp-flow)
4. [After the order: payment, receipt, pin](#after-the-order-payment-receipt-pin)
5. [Data model](#data-model)
6. [Vendor API](#vendor-api)
7. [Configuration](#configuration)
8. [Keeping the Flow on Meta in sync](#keeping-the-flow-on-meta-in-sync)
9. [Running and testing](#running-and-testing)
10. [Known limitations and open issues](#known-limitations-and-open-issues)

---

## Architecture

| Module | Responsibility |
|---|---|
| `waba/` | WhatsApp Cloud API: inbound webhook (`waba-webhook.controller.ts`), outbound messages, flows, location requests (`waba.service.ts`), vendor number onboarding (OTP). |
| `chat/` | Handles each inbound buyer message: dedupe, store, classify intent (AI), reply. Also handles Flow completion, location pins, and buyers with hidden numbers. |
| `flow/` | The WhatsApp Flow data endpoint: decrypt the request, route it to a step, build the next screen, encrypt the response. Owns the server-side basket (`FlowCart`) and order placement. `flow.json` is the Flow definition uploaded to Meta. |
| `order/` | Order creation (server-side totals), receipts, status changes with buyer notifications, location pins. |
| `payment/` | Paystack MoMo charges and the `charge.success` webhook. |
| `product/` | Products, measures, Excel bulk upload, photos, and product videos (`product-video.service.ts`: upload, ffmpeg conversion in `video-converter.ts`, approval, sending to buyers; see [VIDEO_SPEC.md](VIDEO_SPEC.md)). Video conversion needs `ffmpeg` (the Dockerfile installs it). |
| `category/` | The platform-wide predefined category list (`GET /categories`). The only code that reads the `Category` table; products, the upload and the Flow use `CategoryService`. |
| `tenant/` | Vendor shop settings: delivery fee, delivery areas and slots. |
| `promoter/` | Promoters (see [PROMOTERS_SPEC.md](PROMOTERS_SPEC.md)): the WhatsApp bot on the platform number (`PLATFORM_PHONE_NUMBER_ID`) for sign-up, finding shops, invites and links; shop memberships and links. Messages to the platform number go here instead of `chat/`. |
| `auth/` | Vendor signup/login (JWT); guards for the Meta signature and the internal webhook secret. |
| `common/` | Money formatting, Ghana phone helpers, env helpers. |

**Message paths**

```
WhatsApp ──webhook──▶ WabaWebhookController ──▶ ChatService ──▶ reply / Flow message / receipt
WhatsApp Flow ──data_exchange (encrypted)──▶ FlowController ──▶ FlowService ──▶ next screen
Paystack ──charge.success──▶ PaymentController ──▶ order marked paid
```

---

## The buyer journey

1. The buyer messages the shop. `ChatService` classifies the message and sends the ordering Flow, at most once every 15 minutes.
2. In the Flow: **WELCOME → CATALOGUE → PRODUCT → BASKET → CHECKOUT → ORDER_RECEIVED** (with an optional **SEARCH** box that leads to CATALOGUE).
3. On **Place order**, the order is created and the **MoMo prompt** goes out straight away.
4. On **Done**, the buyer gets the **receipt** and a **"Send location"** request in the chat. If they never tap Done, both are sent after 60 s.
5. The buyer drops a pin, and it is attached to the order.
6. The vendor moves the order through `PROCESSING → OUT_FOR_DELIVERY → DELIVERED`. The buyer is messaged at each step, including the rider's name and phone and a cash reminder for COD.

A repeat buyer taps **Repeat my last order** on WELCOME and confirms a pre-filled checkout.

---

## The WhatsApp Flow

Definition: [`src/flow/flow.json`](src/flow/flow.json) (Flow JSON 7.3, data API 3.0). Server logic: [`src/flow/flow.service.ts`](src/flow/flow.service.ts).

### Screens

| Screen | What the buyer sees | Notes |
|---|---|---|
| **WELCOME** | One-tap list: *🔍 Search products*, *Repeat my last order* (if any), **All products**, then each category with in-stock products. | A NavigationList must be the only component on its screen, so the heading and caption are the list's `label`/`description`. |
| **SEARCH** | One text box and a **Search** button, a *We sell* line (the shop's categories, or product names if it has none) and an *Or pick an item* dropdown of up to 200 in-stock products that opens the picked product directly. Opened from the *🔍 Search products* row on WELCOME or CATALOGUE; pre-filled with the last term on *Search again*. | Searches the whole shop: every word must appear in the product name, note or category title (any case). Results are a CATALOGUE whose category is `search:<term>`, so paging, *Back to list* and *Add more products* re-run the search. |
| **CATALOGUE** | Basket bar: with items, **View basket & checkout** (green cart icon, item count, total, *Tap to checkout* badge; category and page in the small print); when empty, the category and page with a grey cart, then a *🔍 Search* row and up to **15 products** per page with Previous/Next rows. | A product already in the basket shows "✓ 2 in basket · GH₵ 240" in its metadata line. |
| **PRODUCT** | Measure choice with prices ("Basket · GH₵ 120"), quantity 1–10, Add/Update basket, *Remove from basket*. | Opened from the basket, Remove deletes only that line; opened from the catalogue, it removes the whole product. |
| **BASKET** | Top list: **Proceed to checkout** (green cart icon, total, item count, *Tap to order* badge) + *Add more products* (grey plus icon). Below: up to 20 basket lines, newest first, each with its price. | |
| **CHECKOUT** | ⚠️ line (only after an error, e.g. invalid MoMo number), **Your order** (up to 8 lines, delivery, total) with *Edit basket*, then **1. Where should we deliver?** (area, landmark, time), **2. Who receives it?** (name, rider phone), **3. How will you pay?** (method, MoMo number). Item count and total sit on the **Place order** button. | Every field except the delivery area is pre-filled from what was just submitted, else the buyer's last Flow order, else their WhatsApp number; the area starts empty ("Select delivery area") and is only kept when CHECKOUT is re-shown after an error. *Edit basket* sends no `cart_id`, which is how it is told apart from Place order when WhatsApp drops the step. |
| **ORDER_RECEIVED** | **✅ Order placed**, order number and total, then a numbered *What happens next*: 1. approve the MoMo prompt (or have the cash ready), 2. tap the button and share the location pin, 3. delivery time. Button: **Done · share my location**. | Terminal screen; the button sends `{ order_id }` back to the chat, which triggers the receipt and the pin request. |

### How requests are routed

Every button sends a `data_exchange` with a payload. The server works out the step in this order:

1. `data.step` (current name) or `data.action` (older Flows).
2. **Otherwise, from the screen and fields.** WhatsApp has been seen to drop the `step` field from payloads, so this fallback is required:
   - `WELCOME` → `open_category` (or `open_search` when `sku` is `open_search`)
   - `SEARCH` → `search`
   - `PRODUCT` with `qty` → `add_line`; without → back to `open_category`
   - `CHECKOUT` → `place_order`
   - `CATALOGUE`/`BASKET` list rows: rows that are not about a product carry their step in the `sku` slot (`open_basket`, `build_summary`, `open_category`, `open_search`); a real product id means `open_product`.

### Rules WhatsApp enforces (learned the hard way)

- **A NavigationList may only appear alongside other NavigationLists**, at most two per screen.
- **In a NavigationList, either every row has `end` or none does.** Mixing them makes the screen fail on the phone. A test checks this across a whole shopping session.
- **Hidden-number buyers (BSUIDs such as `GH.2858…`) are addressed with `recipient`, never `to`,** for every message type (Meta's documented rule). If WhatsApp refuses or fails to deliver the location request, the buyer is asked by text to send a pin from the 📎 menu.
- Lists hold 1–20 rows; text caps are in `LIMIT` in `flow.service.ts` (e.g. nav title 30, nav description 20, end 10, badge 15).

### The basket (`FlowCart`)

- One cart per `flow_token`. The token is `tenantId:buyerPhone:timestamp`, created when the Flow is sent.
- Lines are `{ sku, measure, qty }`, **re-priced from the database on every request**; out-of-stock products and removed measures drop out.
- `place_order` can safely run twice per cart (unique `flowCartId` on `Order`), so double taps and Meta retries return the same order.
- Carts idle for 1 h start empty; abandoned carts are deleted after 7 days.

---

## After the order: payment, receipt, pin

| When | What happens | Where |
|---|---|---|
| **Place order** | Order created. **MoMo prompt** starts in the background (the Flow response never waits for Paystack). A 60 s fallback timer starts. | `FlowService.placeOrder`, `requestPayment` |
| **Done tapped** | Receipt sent (waits for the MoMo result if it is still pending, and includes a ⚠️ warning if it failed), then the "Send location" request. | `ChatService.confirmFlowOrder`, `FlowService.completeOrder` |
| **60 s, no Done** | Same receipt + location request, for buyers who closed the Flow with ✕. | `FlowService.scheduleConfirmationFallback` |
| **Pin shared** | Attached to the buyer's newest order that asked for a pin in the last 30 min. | `OrderService.attachLocation` |

**Exactly once:** `paymentRequestedAt` makes sure the MoMo prompt is sent only once (released on failure, so it can be retried). `confirmationSentAt` makes sure the receipt and pin request are sent only once, whichever of Done and the fallback comes first.

**Privacy:** completing an order checks both the shop and the buyer's phone (normalised, so `024…` matches `233…`), so a stray order reference never reveals another buyer's receipt.

---

## Data model

Defined in [`prisma/schema.prisma`](prisma/schema.prisma). The main tables:

| Model | Purpose |
|---|---|
| `Tenant` | A vendor shop: WhatsApp number id, `deliveryFee`, `deliveryAreas` and `deliverySlots` (JSON lists shown on CHECKOUT; "asap" is always first). |
| `Category` | **Platform-wide predefined list** (seeded by migration): `veg_fruits`, `rice_oil`, `grains_flour`, `meat_frozen`, `fish_seafood`, `dairy_eggs`, `bread_snacks`, `spices`, `drinks`, `household`, `personal_care`, `baby`, `other`. |
| `Product` | `price` (the cheapest measure's price when measures exist), `inStock`, `note`, `categoryId`. |
| `ProductMeasure` | A way a product is sold (olonka, basket, 5 kg…), each with its own price. A product with none is sold as a single "Each". |
| `FlowCart` | Server-side basket for one Flow session. |
| `Order` / `OrderItem` | See below. Items store `measureCode` so "Repeat my last order" can rebuild the basket. |
| `ChatSession` / `ChatMessage` | The WhatsApp thread as the vendor dashboard shows it; pins are stored with `source = LOCATION`. |

**Order fields added for the Flow:** `customerName`, `deliveryArea`, `landmark`, `contactPhone`, `deliverySlot`, `flowCartId`, `paymentRequestedAt`, `confirmationSentAt`, `riderName`, `riderPhone`, and the pin: `locationRequestedAt`, `locationLatitude`, `locationLongitude`, `locationName`, `locationAddress`, `locationReceivedAt`.

**Order statuses:** `PENDING`, `AWAITING_PAYMENT` (MoMo), `PAID`, `CONFIRMED` (COD), `PROCESSING`, `OUT_FOR_DELIVERY`, `DELIVERED`, `COMPLETED`, `CANCELLED`, `REFUNDED`.

**Migrations added in this round** (all applied to the local database):

| Migration | Change |
|---|---|
| `20261103090000_flow_design_b` | Flow order fields, `FlowCart`, `ProductMeasure`, per-tenant `Category`, `LOCATION` message source. |
| `20261103120000_predefined_categories` | Turns categories into the platform-wide list and seeds it. **Clears every existing product's category.** |
| `20261103150000_order_confirmation_sent` | `Order.confirmationSentAt`. |

---

## Vendor API

All routes are under `/api/v1` and need a vendor JWT unless noted.

| Method & path | Purpose |
|---|---|
| `POST /auth/signup`, `POST /auth/login`, `GET /auth/me` | Vendor accounts. |
| `POST /tenants`, `GET /tenants`, `PUT /tenants` | Shop settings, including `deliveryAreas` `[{id, title}]` and `deliverySlots` `[{id, title, description?}]`. |
| `POST /waba/onboard`, `/request-otp`, `/verify-otp` | Connect the shop's WhatsApp number. |
| `GET /categories` | The predefined categories, with the vendor's product count in each. |
| `POST /products` | Create a product. `categoryId` is required; `measures` `[{code, label, price, description?}]` is optional (up to 10). |
| `POST /products/upload` | Excel bulk upload (multipart `file` + `categoryId`). Optional `measure_1`/`price_1` … `measure_10`/`price_10` columns. |
| `GET /products`, `GET/PATCH/DELETE /products/:id` | Manage products. `measures` on PATCH replaces them all. |
| `POST /orders`, `GET /orders`, `GET /orders/:id`, `DELETE /orders/:id` | Manage orders. |
| `PATCH /orders/:id/status` | Change status (+ `notes`, `riderName`, `riderPhone`). Messages the buyer on packed / out for delivery / delivered. |
| `POST /flow/send` | Push the ordering Flow to a buyer. |
| `GET/POST /chat/…` | Sessions and history for the dashboard. `POST /chat` is guarded by `x-webhook-secret` (`WEBHOOK_SECRET`). |

**Called by Meta and Paystack, not vendors:** `GET/POST /webhook` (WhatsApp verification and messages), `POST /flow` (Flow data exchange, signed by Meta; also mounted at the bare `/webhook` path outside `/api/v1`), `POST /payments/paystack/webhook`.

---

## Configuration

Copy `.env.example` to `.env`. The app loads **only `.env`** (`import 'dotenv/config'` in `main.ts`).

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL. |
| `JWT_SECRET` | Vendor auth. |
| `META_BASE_URL`, `META_API_VERSION`, `META_WABA_ID`, `META_SYSTEM_USER_TOKEN`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | WhatsApp Cloud API. |
| `META_FLOW_ID` | The Flow the server sends. **Use the ID in your `.env`**; `.env.example` has a placeholder ID. |
| `META_FLOW_MODE` | `draft` (default when unset) or `published`. |
| `META_FLOW_PRIVATE_KEY`, `META_FLOW_PASSPHRASE` | RSA key for Flow request encryption; validated at boot. |
| `PAYSTACK_SECRET_KEY` | MoMo charges. |
| `AI_API_URL`, `AI_API_KEY`, `AI_MODEL` | Intent classification. |
| `WEBHOOK_SECRET` | Guards `POST /api/v1/chat`. Without it, that endpoint rejects every request. |
| `VENDOR_ORDER_TEMPLATE`, `VENDOR_ORDER_TEMPLATE_LANGUAGE` | The approved WhatsApp template for new-order alerts to vendors (default `order`, `en_US`). Templates reach vendors outside the 24-hour window. |

---

## Keeping the Flow on Meta in sync

`flow.json` and the server must change together: the server's screen data has to match the screens Meta serves. **Whenever `flow.json` changes, upload it to `META_FLOW_ID` and restart the server.**

Upload (replaces the Flow's draft JSON):

```bash
curl -X POST "https://graph.facebook.com/v21.0/$META_FLOW_ID/assets" \
  -H "Authorization: Bearer $META_SYSTEM_USER_TOKEN" \
  -F "file=@src/flow/flow.json;type=application/json" \
  -F "name=flow.json" -F "asset_type=FLOW_JSON"
```

A response with `"validation_errors": []` means Meta accepted it. To check what Meta is actually serving, `GET /$META_FLOW_ID/assets` returns a `download_url` for the current JSON.

You can also paste the JSON into WhatsApp Manager → Flows → Edit. A **published** Flow cannot be edited; clone it and update `META_FLOW_ID`. Test with a **newly sent** Flow message, since older messages may open a cached version.

---

## Running and testing

```bash
npm install
npx prisma migrate deploy     # apply migrations
npx prisma generate
npm run start:dev             # watch mode
npm test                      # unit tests (vitest), 118 passing
npx tsc --noEmit -p tsconfig.json
```

The Flow endpoint must be reachable by Meta over HTTPS; locally that is an ngrok URL set as the Flow's endpoint in WhatsApp Manager.

Key test files: `flow.service.spec.ts` (every screen, step routing without `step`, the NavigationList rules, pre-fill, idempotency, the 60 s fallback, MoMo outcomes), `chat.service.spec.ts` (Done, fallback, pins, receipts), `order.service.spec.ts` (status notifications, pins).

---

## Known limitations and open issues

| Issue | Impact | Next step |
|---|---|---|
| **Most MoMo prompts fail** in testing (4 of 5 recent MoMo orders have no `paymentRequestedAt`). | Buyers get a ⚠️ on the receipt instead of a prompt. | Check the server log for `MoMo prompt for MX-… failed:`; likely the Paystack key or test numbers. |
| Product photo is a placeholder on every PRODUCT screen. | Wastes space, shows nothing. | Flows need embedded base64 images, not URLs. Decide how product images get into the Flow, or remove the image. |
| The 60 s fallback timer lives in memory. | A restart inside that minute skips the fallback for that order. | Replace with a periodic sweep of orders with no `confirmationSentAt` if it matters. |
| Checkout validation messages appear inside the total line. | Easy to miss. | A dedicated notice field on CHECKOUT. |
| Product names include units, e.g. "Tomatoes (1 basket)". | Clashes with measures ("from GH₵ 15"). | Rename to plain names now that measures exist. |
| Delivery area that isn't on the list is saved as free text. | Odd addresses. | Reject unknown area ids. |
| Basket updates are read-modify-write without a lock. | Two simultaneous requests could lose an edit (rare). | Optimistic locking on `FlowCart.updatedAt`. |
| Flow tokens (with the buyer's phone) are logged on every request. | Phone numbers in logs. | Log a hashed token. |
| Excel upload still requires `price` even when measures are given. | Differs from the API, which uses the cheapest measure. | Make `price` optional when measure columns are filled. |

**Local test data** (Marketix shop): 20 products, all categorised; measures on Tomatoes, Onions, Rice, Gari, Plantain and Smoked Herrings. The measure prices are placeholders.
