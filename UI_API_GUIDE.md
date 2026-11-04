# MarketiX: vendor and admin API, for building the UI

This document describes the backend API that two web apps will use. Build the user interface from it. Everything here matches the running backend; where something is missing or limited, it says so under **Backend constraints**.

---

## 1. The product and its users

MarketiX lets Ghanaian market vendors (tomato sellers at Kejetia, rice sellers at Makola…) sell on WhatsApp. Buyers never use these apps: they order inside WhatsApp. These apps are for the two other groups.

| App | Users | Device and context | What they do |
|---|---|---|---|
| **Vendor app** | Market traders, often not tech-savvy, English as a second language | **Phone first**, often on slow 3G, small screens, outdoors | Sign up, set up the shop, upload ID documents, load products, track review, then manage orders. |
| **Admin app** | MarketiX staff ("super admins") | Desktop / laptop | Review new shops (KYC due diligence), approve them and assign a WhatsApp number, suspend shops, manage the pool of WhatsApp numbers. |

**Design direction**

- Vendor app: large tap targets, one task per screen, plain short words ("Add product", "Your shop is being reviewed"), progress shown as a checklist, money always in cedis. Avoid jargon such as "KYC", "tenant", "WABA": say "ID documents", "shop", "WhatsApp number".
- Admin app: dense but calm. Tables, filters, a side-by-side review screen, clear destructive-action confirmations.
- Both: show the server's error `message` to the user. It is written to be human-readable.

---

## 2. Conventions

| Topic | Rule |
|---|---|
| Base URL | `{API}/api/v1`, e.g. `http://localhost:3000/api/v1`. Make it configurable. |
| Auth | `Authorization: Bearer <accessToken>` on every request except signup and login. Tokens last 7 days; there is no refresh endpoint. On `401`, send the user to login. |
| Body format | JSON (`Content-Type: application/json`), except file uploads (`multipart/form-data`). |
| Unknown fields | **Rejected.** Sending a field the endpoint does not accept returns `400` with `"property X should not exist"`. Send only documented fields. |
| Dates | ISO 8601 strings in UTC, e.g. `"2026-11-03T14:02:00.000Z"`. Display in Africa/Accra time (UTC+0). |
| Money | Numbers in Ghana cedis (GH₵), up to 2 decimals. Display as `GH₵ 1,200` or `GH₵ 12.50`. |
| Phones | Accept `0244111222`, `+233244111222` or `233244111222`. Display as `024 411 1222`. |
| IDs | UUID strings, except category ids, which are readable strings such as `veg_fruits`. |

### Errors

Errors use this shape. `message` is a string, or an array of strings for validation errors:

```json
{ "statusCode": 400, "message": ["ownerPhone must be a phone number, e.g. 0244111222 or +233244111222"], "error": "Bad Request" }
```

| Status | Meaning in the UI |
|---|---|
| `400` | Fix the input; show `message` next to the form. |
| `401` | Not logged in or token expired → login screen. |
| `403` | Not allowed (wrong role, or the shop is suspended / locked). Show `message`. |
| `404` | Not found, or the feature is disabled. |
| `409` | The action conflicts with the current state (e.g. already approved, no free numbers). Show `message` and refresh the data. |

---

## 3. Enums and how to show them

### Shop status (`TenantStatus`)

| Value | Vendor sees | Admin badge | Colour |
|---|---|---|---|
| `PENDING` | "Add your first product to get reviewed" | Pending | grey |
| `STOCKED` | "Waiting for review" | Waiting | blue |
| `UNDER_REVIEW` | "Being reviewed" | In review | blue |
| `MORE_INFO` | "We need a few changes" + reviewer notes + **Resubmit** | More info | amber |
| `REJECTED` | "Not approved yet" + reviewer notes + **Resubmit** | Rejected | red |
| `ACTIVE` | "Your shop is live" + its WhatsApp number | Active | green |
| `SUSPENDED` | "Your shop is suspended" (everything read-only) | Suspended | red |

```
PENDING ──(first in-stock product)──▶ STOCKED ──(admin starts review)──▶ UNDER_REVIEW
                                         ▲                                  │
                                         │   ┌───── MORE_INFO ◀────────────┤
                                         ├───┤      (vendor resubmits)      │
                                         │   └───── REJECTED  ◀────────────┤
                                         │          (vendor resubmits)      ▼
                                         │                         ACTIVE (approved, number assigned)
                                         │                                  │
                         reinstate ──────┘ (if number was released)         ▼
                         reinstate ──────────────────────────────────▶ SUSPENDED ──▶ release number
```

Approve works from `STOCKED` or `UNDER_REVIEW`. Suspend works from any status.

### Other enums

| Enum | Values |
|---|---|
| `UserRole` | `VENDOR`, `SUPER_ADMIN` |
| `DocumentType` | `GHANA_CARD_FRONT` ("Ghana Card, front"), `GHANA_CARD_BACK` ("Ghana Card, back"), `STALL_PHOTO` ("Photo of your stall"), `BUSINESS_REG` ("Business registration", optional) |
| `NumberStatus` | `FREE`, `ASSIGNED`, `COOLING` (released, reusable after 7 days) |
| `ReviewDecision` | `APPROVED`, `MORE_INFO`, `REJECTED`, `SUSPENDED`, `RELEASED`, `REINSTATED` |
| `OrderStatus` | `PENDING`, `AWAITING_PAYMENT` ("Waiting for MoMo"), `PAID`, `CONFIRMED`, `PROCESSING` ("Packed"), `OUT_FOR_DELIVERY` ("On the way"), `DELIVERED`, `COMPLETED`, `CANCELLED`, `REFUNDED` |
| `PaymentMethod` | `MOMO` ("Mobile Money"), `CARD`, `COD` ("Cash on delivery") |
| `Fulfillment` | `DELIVERY`, `PICKUP` |
| Number `qualityRating` | `GREEN`, `YELLOW`, `RED`, `UNKNOWN` or null. Yellow/red need attention. |

---

## 4. Vendor app

### 4.1 Account

**`POST /auth/signup`**, public

```json
{ "email": "ama@example.com", "password": "at-least-8-chars", "firstName": "Ama", "lastName": "Mensah" }
```

**`POST /auth/login`**, public: `{ "email", "password" }`

Both return:

```json
{
  "user": { "id": "uuid", "email": "ama@example.com", "firstName": "Ama", "lastName": "Mensah", "role": "VENDOR", "createdAt": "…" },
  "accessToken": "eyJ…"
}
```

- `409` on signup: "A user with this email already exists".
- `401` on login: "Invalid email or password".
- If `role` is `SUPER_ADMIN`, send the user to the admin app instead.

**`GET /auth/me`** returns `{ "user": { id, email, firstName, lastName, role, createdAt, modifiedAt } }`.

There is no logout endpoint (drop the token), and no password reset.

### 4.2 Shop setup (first run)

After signup, call `GET /tenants`. A `404` ("You do not have a tenant yet.") means the shop setup screen.

**`POST /tenants`**

```json
{
  "name": "Ama's Vegetables",
  "ownerFullName": "Ama Mensah",
  "ownerPhone": "0244111222",
  "market": "Kejetia, Kumasi",
  "stallLocation": "Row 4, near the main gate",
  "momoNumber": "0244111222",
  "momoName": "Ama Mensah",
  "description": "Fresh vegetables daily",
  "deliveryFee": 10,
  "deliveryAreas": [{ "id": "knust", "title": "KNUST Campus" }, { "id": "ayigya", "title": "Ayigya" }],
  "deliverySlots": [{ "id": "today_pm", "title": "Today, 5 pm – 7 pm", "description": "Evening delivery" }]
}
```

| Field | Rules |
|---|---|
| `name`, `ownerFullName` | Required. |
| `ownerPhone` | Required. The vendor's own phone (alerts go here), **not** the shop's WhatsApp number. |
| `market` | Optional, but the "Shop details" checklist step only completes when it is set, so make it required in the form. |
| `momoNumber` + `momoName` | Optional at setup, needed before review ("MoMo payout"). `momoName` is the name the MoMo account is registered to. |
| `slug` | Optional, lowercase-with-hyphens; generated from the name if omitted. Can be hidden. |
| `deliveryFee` | GH₵, ≥ 0, default 5. |
| `deliveryAreas[]` | `id` matches `^[a-z0-9_]+$` (generate it from the title), `title` ≤ 30 chars. |
| `deliverySlots[]` | Same `id` rule, `title` ≤ 30, optional `description` ≤ 300. A "Now · within 1 hour" (`asap`) slot is always added automatically. Do not ask for it. |

Returns the shop (see **Shop object** below). `409` if the user already has a shop.

**There is no WhatsApp number field.** MarketiX assigns one when the shop is approved.

### 4.3 Home: onboarding checklist

**`GET /tenants/status`**, the main screen until the shop is live

```json
{
  "status": "STOCKED",
  "canResubmit": false,
  "steps": [
    { "key": "shop", "label": "Shop details", "done": true },
    { "key": "ownerDetails", "label": "Owner name and phone", "done": true },
    { "key": "momoPayout", "label": "MoMo payout number and registered name", "done": false },
    { "key": "ghanaCardFront", "label": "Ghana Card (front)", "done": true },
    { "key": "ghanaCardBack", "label": "Ghana Card (back)", "done": false },
    { "key": "stallPhoto", "label": "Photo of your stall", "done": false },
    { "key": "products", "label": "At least one product in stock", "done": true },
    { "key": "approved", "label": "Approved by MarketiX", "done": false }
  ],
  "latestReview": { "decision": "MORE_INFO", "notes": "Your Ghana Card photo is blurry.", "createdAt": "…" },
  "number": null
}
```

- Show `steps` as a checklist with a progress bar, and link each undone step to the screen that fixes it: `shop`/`ownerDetails`/`momoPayout` → shop settings, the three document steps → documents, `products` → add product.
- On `MORE_INFO` or `REJECTED`, show `latestReview.notes` prominently with a **Resubmit** button (`canResubmit` is true).
- On `ACTIVE`, `number` is `{ "displayNumber": "0205960861", "displayName": "Ama's Vegetables", "assignedAt": "…" }`. Show a celebratory "Your shop is live" card with:
  - the number,
  - a share link `https://wa.me/233205960861?text=Hi` (number in international digits, no `+`),
  - a QR code of that link,
  - a **Send test order** button (`POST /flow/send` to the vendor's own `ownerPhone`; see 4.8).

**`POST /tenants/resubmit`**, no body. Returns the shop, now `STOCKED`, or `PENDING` if nothing is in stock. `400` if the shop is not in `MORE_INFO` / `REJECTED`.

### 4.4 Shop settings

**`GET /tenants`** returns the **Shop object**:

```json
{
  "id": "uuid", "name": "Ama's Vegetables", "slug": "amas-vegetables", "status": "ACTIVE",
  "whatsappNumber": "0205960861", "countryCode": "233",
  "ownerFullName": "Ama Mensah", "ownerPhone": "0244111222", "market": "Kejetia, Kumasi", "stallLocation": "Row 4",
  "momoNumber": "0244111222", "momoName": "Ama Mensah",
  "description": "…", "deliveryFee": 10, "pickupNote": null,
  "deliveryAreas": [{ "id": "knust", "title": "KNUST Campus" }], "deliverySlots": [],
  "submittedAt": "…", "createdAt": "…", "modifiedAt": "…",
  "whatsappPhoneNumberId": "…", "wabaStatus": "VERIFIED", "wabaRegisteredAt": "…", "userId": "uuid"
}
```

Hide the last row of fields; they are internal.

**`PUT /tenants`**: any subset of `name`, `description`, `ownerFullName`, `ownerPhone`, `market`, `stallLocation`, `momoNumber`, `momoName`, `deliveryFee`, `pickupNote`, `deliveryAreas`, `deliverySlots`.

| Rule | UI |
|---|---|
| **Locked while `UNDER_REVIEW` or `ACTIVE`:** `ownerFullName`, `momoNumber`, `momoName`. Changing them returns `403` ("… cannot be changed while your shop is live. Contact MarketiX support…"). Sending the unchanged value is fine. | Show these fields read-only with a lock icon and "Contact support to change" in those states. |
| `SUSPENDED` shops cannot change anything (`403`). | Make the whole settings screen read-only. |
| `whatsappNumber` is rejected (`400`). | Never show it as editable. |

### 4.5 ID documents

**`POST /tenants/documents`** (`multipart/form-data`)

| Field | Value |
|---|---|
| `file` | JPEG, PNG, WebP or PDF, **max 5 MB** |
| `type` | A `DocumentType` value |

Returns `{ "id", "tenantId", "type", "fileName", "mimeType", "size", "uploadedAt" }`.

- One document per type: uploading the same type again **replaces** it.
- `400` for a wrong file type or size. `403` while `UNDER_REVIEW` / `ACTIVE` (documents are locked) or `SUSPENDED`.
- UI: one card per type with the camera / file picker (phones: offer "Take photo"), a thumbnail when uploaded, and "Replace". Mark `BUSINESS_REG` optional. Compress photos client-side when you can; vendors are on slow data.

**`GET /tenants/documents`** returns an array of the objects above.

**`GET /tenants/documents/:id/file`** streams the file (needs the auth header, so fetch it as a blob to show a thumbnail or preview).

### 4.6 Products

Products belong to one of a fixed list of categories and can be sold in several **measures** (ways of selling, each with its own price: "Olonka GH₵ 15", "Basket GH₵ 85"). A product without measures is sold "each" at its `price`.

**`GET /categories`**

```json
[{ "id": "veg_fruits", "title": "Vegetables & fruits", "description": "Tomatoes, onions, pepper, plantain", "sortOrder": 1, "productCount": 13 }]
```

The ids are: `veg_fruits`, `rice_oil`, `grains_flour`, `meat_frozen`, `fish_seafood`, `dairy_eggs`, `bread_snacks`, `spices`, `drinks`, `household`, `personal_care`, `baby`, `other`.

**`GET /products?page=1&limit=5&search=tom`**

```json
{ "data": [Product, …], "meta": { "total": 20, "page": 1, "limit": 5, "totalPages": 4 } }
```

**Product object**

```json
{
  "id": "uuid", "name": "Tomatoes", "price": 15, "inStock": true, "note": "Fresh from Kejetia",
  "image": null, "photoUrl": null, "categoryId": "veg_fruits", "tenantId": "uuid", "createdAt": "…", "modifiedAt": "…",
  "category": { "id": "veg_fruits", "title": "Vegetables & fruits", "description": "…", "sortOrder": 1, "createdAt": "…", "modifiedAt": "…" },
  "measures": [
    { "id": "uuid", "productId": "uuid", "code": "olonka", "label": "Olonka", "description": "About 2 kg", "price": 15, "sortOrder": 0 },
    { "id": "uuid", "productId": "uuid", "code": "basket", "label": "Basket", "description": "Best value", "price": 85, "sortOrder": 1 }
  ]
}
```

Show "from GH₵ 15" (the lowest measure price) when there are measures.

**`POST /products`**

```json
{
  "name": "Tomatoes", "categoryId": "veg_fruits", "note": "Fresh from Kejetia", "inStock": true,
  "measures": [
    { "code": "olonka", "label": "Olonka", "price": 15, "description": "About 2 kg" },
    { "code": "basket", "label": "Basket", "price": 85 }
  ]
}
```

| Field | Rules |
|---|---|
| `name`, `categoryId` | Required. |
| `price` | Required **unless** measures are given; then it defaults to the cheapest measure. |
| `measures[]` | Up to 10. `code`: `^[a-z0-9_]+$`, unique per product, not `remove` or `none` (generate it from the label: "Half basket" → `half_basket`). `label` ≤ **15** chars. `price` ≥ 0. `description` ≤ 300 (shown under the option, e.g. "Best value"). Order = display order. |
| `note` | One short line shown to buyers under the product name. |
| `inStock` | Default true. |

The form should offer common measures as quick chips (Olonka, Half basket, Basket, Bag, Half bag, Bunch, Tin, Each) with a price field each.

Adding the first in-stock product moves a `PENDING` shop to `STOCKED`. Refresh `/tenants/status` afterwards.

**Photos.** A product has at most one photo, uploaded as a file (there is no photo link field):

- **`POST /products/:id/photo`** (`multipart/form-data`, field `file`): JPEG, PNG or WebP, **max 5 MB**. The type is read from the file's bytes, so anything else (including a renamed file) gets `400` "Upload a JPEG, PNG or WebP photo.". Uploading again **replaces** the photo. Returns `{ "photoUrl": "/api/v1/products/<id>/photo?v=1793792464688" }`. `403` when the shop is `SUSPENDED`.
- **`DELETE /products/:id/photo`** removes it and returns `{ "photoUrl": null }`. Deleting the product removes its photo too.
- **`GET /products/:id/photo`** is **public** (no token), so use it directly as an `<img src>`: prefix `photoUrl` with the API's origin. The `?v=` changes on every upload, so the response is cached for good. `404` when there is no photo.
- Every product response has `photoUrl` (`null` when there is no photo). Create the product first, then upload its photo. Shrink photos in the browser before uploading.
- `image` is **not** a photo: it is an emoji shown before the product name in WhatsApp text lists (e.g. `"🍅"`).

**`GET /products/:id`**, **`PATCH /products/:id`** (any subset of the create fields; `measures` **replaces all** measures; `[]` removes them), **`DELETE /products/:id`** → `{ "message": "Product deleted successfully." }`. All product changes return `403` when the shop is `SUSPENDED`.

### 4.7 Bulk upload (Excel)

**`GET /products/upload/template`** downloads `marketix-products-template.xlsx`:

- A **Products** sheet with the columns `product_name | category | price | measure_1 | price_1 | measure_2 | price_2 | measure_3 | price_3 | note` and two example rows.
- A **Categories** sheet listing the valid category ids.

**`POST /products/upload`** (`multipart/form-data`)

- `file`: `.xlsx` or `.xls`, max 5 MB, max **500 rows**.
- `categoryId`: optional, used for rows whose `category` cell is empty.
- The `category` cell accepts an id (`veg_fruits`) or a title (`Vegetables & fruits`). `price` may be empty when measures are given. Up to `measure_10`/`price_10` are read.

**All or nothing.** Success (`201`):

```json
{ "totalRows": 2, "created": 2, "products": [{ "row": 2, "name": "Tomatoes", "categoryId": "veg_fruits" }, { "row": 3, "name": "Rice (5 kg)", "categoryId": "rice_oil" }] }
```

If any row is invalid, **nothing is imported** (`400`), and the body is:

```json
{
  "message": "No products were imported: 2 of 7 rows have problems. Fix them and upload again.",
  "totalRows": 7,
  "errors": [
    { "row": 2, "message": "Give a \"price\", or at least one measure with its price." },
    { "row": 6, "message": "Unknown category \"electronics\". Use an id or title from the Categories sheet." }
  ]
}
```

`row` is the spreadsheet row number (the header is row 1). UI: a three-step screen: 1 Download template → 2 Fill it in → 3 Upload. On errors, show a table of row and problem with "Fix the sheet and upload again".

### 4.8 Orders (once live)

Most orders arrive from buyers through WhatsApp; the vendor manages them here.

**`GET /orders?page=1&limit=10&status=AWAITING_PAYMENT&search=MX-AB`**: `search` matches order number, buyer phone or notes.

```json
{ "data": [Order, …], "meta": { "total": 42, "page": 1, "limit": 10, "totalPages": 5 } }
```

**Order object** (main fields)

```json
{
  "id": "uuid", "orderNumber": "MX-VUPPVS", "status": "CONFIRMED", "createdAt": "…",
  "buyerPhone": "+233598402862", "customerName": "Kofi Boateng", "contactPhone": "+233244000000",
  "totalAmount": 250, "deliveryFee": 10, "paymentMethod": "COD", "paymentPhone": null,
  "fulfillment": "DELIVERY", "deliveryArea": "KNUST Campus", "landmark": "Unity Hall, Block C",
  "deliveryAddress": "KNUST Campus — Unity Hall, Block C", "deliverySlot": "Now · within 1 hour",
  "locationLatitude": 6.6745, "locationLongitude": -1.5716, "locationName": "Unity Hall", "locationReceivedAt": "…",
  "riderName": null, "riderPhone": null, "notes": null,
  "items": [{ "id": "uuid", "productId": "uuid", "productName": "Tomatoes (Basket)", "measureCode": "basket", "unitPrice": 120, "quantity": 2, "totalPrice": 240 }]
}
```

- When `locationLatitude`/`locationLongitude` are set, the buyer shared a map pin. Show a map preview and an "Open in Maps" link: `https://maps.google.com/?q={lat},{lng}`.
- `buyerPhone` may be a hidden id such as `GH.989894404158856` for buyers who hide their number. Do not format it as a phone.

**`GET /orders/:id`**: one order.

**`PATCH /orders/:id/status`**

```json
{ "status": "OUT_FOR_DELIVERY", "riderName": "Kofi", "riderPhone": "0244000000", "notes": "Optional note" }
```

The buyer automatically gets a WhatsApp message when the status changes to `PROCESSING` ("packed"), `OUT_FOR_DELIVERY` (with the rider's name and phone, and a cash reminder for COD) or `DELIVERED`. UI: show the next action as one big button ("Mark as packed" → "Send rider" (asks for rider name and phone) → "Mark delivered"), with the full status list in a secondary menu.

**`DELETE /orders/:id`**: delete an order (confirm first).

**`POST /orders`**: create an order manually (e.g. phone orders). Body: `buyerPhone`, `items[]` (`productName`, `unitPrice`, `quantity`, optional `productId`, `measureCode`), optional `paymentMethod`, `fulfillment`, `deliveryAddress`, `deliveryFee`, `notes`, `status`. Totals are calculated by the server.

**`POST /flow/send`**: send the WhatsApp ordering form to a phone. Body: `{ "toPhone": "0244111222" }`. Only works when the shop is `ACTIVE` (otherwise `400`). Use it for **Send test order**.

### 4.9 Conversations (optional screen)

- **`GET /chat/sessions?page=1&limit=20&search=+233`**: buyer conversations, each with its latest message, orders and counts.
- **`GET /chat/sessions/:id`**: the full thread with orders. Messages have `sender` (`BUYER`, `VENDOR`, `SYSTEM`), `source` (`TEXT`, `FLOW_SELECTION`, `MEDIA`, `LOCATION`), `text` and `createdAt`.

Read-only: vendors cannot reply from the app yet.

---

## 5. Admin app

Every route below requires a `SUPER_ADMIN` token; vendors get `403`. Base path: `/admin`.

### 5.1 Dashboard

**`GET /admin/summary`**

```json
{ "waiting": 3, "moreInfo": 1, "freeNumbers": 2, "activeShops": 14 }
```

Four tiles. Turn **Free numbers** amber when it is 2 or fewer: approval fails when it reaches 0.

### 5.2 Review queue

**`GET /admin/tenants`**, default `status=STOCKED,UNDER_REVIEW`. Also accepts any comma-separated statuses, e.g. `?status=ACTIVE` or `?status=SUSPENDED`. Oldest submission first.

```json
[{
  "id": "uuid", "ref": "MX-V-0012", "name": "Ama's Vegetables", "ownerFullName": "Ama Mensah", "ownerPhone": "0244111222",
  "market": "Kejetia, Kumasi", "status": "STOCKED", "productCount": 12, "kycCompleteness": 0.6, "submittedAt": "…"
}]
```

Show a table with: shop, owner, market, product count, a KYC completeness bar (`kycCompleteness` is 0–1), time waiting (from `submittedAt`), status badge, and a **Review** button. Add filter chips for the statuses. There is no pagination; the full list is returned.

### 5.3 Vendor review screen

**`GET /admin/tenants/:id`**: the Shop object (including `refNumber` and the formatted `ref`, e.g. `"MX-V-0012"`) plus:

```json
{
  "user": { "email": "ama@example.com", "firstName": "Ama", "lastName": "Mensah", "createdAt": "…" },
  "number": null,
  "documents": [{ "id": "uuid", "type": "GHANA_CARD_FRONT", "fileName": "card.jpg", "mimeType": "image/jpeg", "size": 120394, "uploadedAt": "…" }],
  "kyc": [{ "key": "ghanaCardFront", "label": "Ghana Card (front)", "done": true }],
  "products": { "sample": [Product, …], "inStock": 12, "uncategorised": 0 },
  "reviews": [{
    "id": "uuid", "decision": "MORE_INFO", "notes": "Ghana Card photo is blurry.",
    "checks": { "ghanaCardMatches": false, "momoNameMatches": true, "calledOwner": true, "productsLookGenuine": true },
    "numberId": null, "createdAt": "…", "reviewer": { "firstName": "Esi", "lastName": "Owusu", "email": "esi@marketix.app" }
  }]
}
```

`products.sample` holds the first 10 products, with `category: { id, title }`, `measures` and `photoUrl`. `reviews` is newest first.

**`GET /admin/tenants/:id/products?search=tom&stock=all&page=1&limit=20`**: every product of the shop, in the order the vendor added them, so the reviewer can see all of what the shop wants to sell. `search` matches the product name; `stock` is `all` (default), `in` or `out`; `limit` 1–50 (default 20). Each product has `category: { id, title }`, `measures` and `photoUrl` (see 4.6; the photo is public). `404` "Shop not found.".

```json
{ "data": [Product, …], "meta": { "total": 42, "page": 1, "limit": 20, "totalPages": 3 }, "counts": { "all": 42, "in": 30, "out": 12 } }
```

`counts` are the stock tab badges: they follow `search` but not `stock`.

**`GET /admin/tenants/:id/documents/:documentId/file`** streams a document (fetch it with the auth header; show images in a lightbox and PDFs in a viewer).

**Layout**

- **Left column:** shop and owner details, MoMo number and registered name, documents (click to open), product sample (warn if `uncategorised > 0`), review history.
- **Right column (sticky):**
  - the **due-diligence checklist** with four checkboxes,
  - a **number picker** (free numbers from `GET /admin/numbers?status=FREE`, showing quality), default "Next free number",
  - a **WhatsApp display name** field (default: shop name),
  - a **notes** field,
  - three buttons: **Approve** (disabled until all four checks are ticked), **Request more info**, **Reject** (both require notes).

| Check key | Label | Help text |
|---|---|---|
| `ghanaCardMatches` | Ghana Card matches the owner | Name and photo on the card match the owner details. |
| `momoNameMatches` | MoMo name matches | The payout number is registered to the owner, not someone else. |
| `calledOwner` | Called the owner | Confirmed the stall location and that they expect WhatsApp orders. |
| `productsLookGenuine` | Products look genuine | Real groceries, sensible prices, nothing prohibited. |

**`POST /admin/tenants/:id/start-review`**, no body: `STOCKED` → `UNDER_REVIEW` (marks it as taken). Call it when the reviewer opens a `STOCKED` shop. `409` if it is in any other state (ignore that when it is already `UNDER_REVIEW`).

**`PUT /admin/tenants/:id/checks`**: save the checklist as the reviewer ticks it. Send any subset, e.g. `{ "momoNameMatches": true }` on each checkbox change.

```json
{ "checks": { "ghanaCardMatches": true, "momoNameMatches": true, "calledOwner": false, "productsLookGenuine": false } }
```

- Only while `UNDER_REVIEW`: `409` "Start the review before ticking checks; this shop is STOCKED." (call start-review first).
- The saved ticks come back on `GET /admin/tenants/:id` as `reviewChecks` (`null` when none are saved): use them to initialise the checkboxes, so a reload or another admin sees the progress.
- Each tick that changes is one "Checklist updated" entry in the audit log (5.8). Re-sending the same value logs nothing.
- Ticks are cleared when a decision is made, so a resubmitted shop is checked afresh.

**`POST /admin/tenants/:id/review`**

```json
{
  "decision": "APPROVED",
  "checks": "optional: { ghanaCardMatches, momoNameMatches, calledOwner, productsLookGenuine }; saved ticks are used when omitted, values sent here win",
  "notes": "Optional for approval",
  "numberId": "uuid-of-a-free-number (optional)",
  "displayName": "Ama's Vegetables (optional)"
}
```

| Decision | Requires | Result |
|---|---|---|
| `APPROVED` | All four checks `true`, counting the ones saved with `PUT …/checks` (else `400` listing the missing ones) | Assigns the number, shop becomes `ACTIVE`. Returns `{ "tenant": Shop, "number": Number }`. Show a success state with the assigned number. |
| `MORE_INFO` | Non-empty `notes` (shown to the vendor) | Shop → `MORE_INFO`. Returns the Shop. |
| `REJECTED` | Non-empty `notes` | Shop → `REJECTED`. Returns the Shop. |

Approval errors (`409`), with the exact messages:

- "No free WhatsApp numbers left in the pool. Add one first." → link to the number pool.
- "That number is not free any more. Pick another." → reload the picker.
- "Only a shop waiting for review can be approved; this one is ACTIVE." → someone else acted; refresh.

#### Private notes

Admins' notes on a shop: calls made, promises, follow-ups. **Vendors never see them**, and they are never sent on WhatsApp. Any admin can read and add; only the author can edit or delete their own note (`403` "You can only change your own notes." otherwise). Every add, edit and delete is written to the audit log (5.8), so deleted or edited text is never lost.

| Method and path | Body | Returns |
|---|---|---|
| `GET /admin/tenants/:id/notes` | | Every note, newest first |
| `POST /admin/tenants/:id/notes` | `{ "body": "Called Ama, Ghana Card coming tomorrow." }` | The new note (`201`) |
| `PATCH /admin/tenants/:id/notes/:noteId` | `{ "body": "…" }` | The updated note |
| `DELETE /admin/tenants/:id/notes/:noteId` | | `204` |

```json
{
  "id": "uuid", "body": "Called Ama, Ghana Card coming tomorrow.",
  "createdAt": "2026-11-04T10:00:00.000Z", "editedAt": null,
  "author": { "id": "uuid", "name": "Steph Dua" },
  "mine": true
}
```

- `body` is trimmed; 1–2000 characters (`400` "Write something in the note." / "Notes can be at most 2000 characters.").
- `mine` is `true` for the signed-in admin's own notes: show Edit and Delete only on those. `editedAt` is set once the note has been edited ("edited").
- `404` "Shop not found." for an unknown shop; `404` "Note not found. It may have been deleted." when another tab already deleted it (refresh the list).

### 5.4 Vendors (every shop)

The directory of every shop on the platform, with tabs, search, a market filter, sort and pagination. The review queue (5.2) stays for working through submissions; this page is for finding any shop.

**`GET /admin/vendors?tab=active&search=ama&market=Kejetia,%20Kumasi&sort=orders&page=1&limit=10`**

| Query | Values | Default |
|---|---|---|
| `tab` | `all`, `not_submitted`, `pending_review`, `more_info`, `active`, `suspended`, `rejected` (any case; unknown → `400`) | `all` |
| `search` | Matches shop name or owner name (contains, any case), owner phone or WhatsApp number (any format: `0244…`, `+233 24…`, at least 3 digits), or the ref (`MX-V-0113`, `0113`) | none |
| `market` | A `market` value from `/admin/vendors/markets`, exact match ignoring case and surrounding spaces | all markets |
| `sort` | `newest` (joined, newest first) or `orders` (most orders in the last 30 days first) | `newest` |
| `page`, `limit` | `limit` 1–50 | `1`, `10` |

| Tab | Shop states |
|---|---|
| `all` | every state |
| `not_submitted` | `PENDING` (no in-stock product yet) |
| `pending_review` | `STOCKED`, `UNDER_REVIEW` |
| `more_info` | `MORE_INFO` |
| `active` | `ACTIVE` |
| `suspended` | `SUSPENDED` |
| `rejected` | `REJECTED` |

```json
{
  "data": [{
    "id": "uuid", "ref": "MX-V-0113", "name": "Adjoa Plantain Hub",
    "ownerFullName": "Adjoa Kyei", "ownerPhone": "0261813957", "market": "Kejetia, Kumasi",
    "status": "ACTIVE", "whatsappNumber": "0592001113",
    "orders30d": 12, "lastOrderAt": "2026-11-03T08:12:00.000Z", "createdAt": "2026-09-27T10:00:00.000Z",
    "noteCount": 2
  }],
  "meta": { "total": 11, "page": 1, "limit": 10, "totalPages": 2 },
  "counts": { "all": 24, "not_submitted": 2, "pending_review": 6, "more_info": 2, "active": 11, "suspended": 1, "rejected": 2 }
}
```

- `counts` are the tab badges. They apply `search` and `market` (but not `tab`), so each badge matches what clicking that tab would show. `meta.total` equals `counts[tab]`.
- `orders30d` and `lastOrderAt` count only paid orders, or ones past payment (`PAID`, `CONFIRMED`, `PROCESSING`, `OUT_FOR_DELIVERY`, `DELIVERED`, `COMPLETED`). `lastOrderAt` is the latest such order ever (not limited to 30 days); `null` means "No orders yet".
- `noteCount` is the number of private admin notes on the shop (5.3); show it next to the ref when above 0.
- `whatsappNumber` is `null` until the shop is approved. Phones are stored as typed; format them for display (e.g. `+233 59 200 1113`).
- **View** opens the review screen: `GET /admin/tenants/:id`.

**`GET /admin/vendors/markets`**: options for the Market dropdown, busiest first. Add an "All markets" option that omits `market`.

```json
[{ "market": "Kejetia, Kumasi", "count": 9 }, { "market": "Asafo, Kumasi", "count": 4 }]
```

### 5.5 Suspend, release, reinstate

Each needs a confirmation dialog explaining the effect.

| Endpoint | Body | Effect | Returns |
|---|---|---|---|
| `POST /admin/tenants/:id/suspend` | `{ "reason": "…" }` (required, shown to the vendor) | Shop → `SUSPENDED`, read-only; buyers are told the shop is temporarily closed. **Keeps its number.** | Shop |
| `POST /admin/tenants/:id/release` | none | Only for `SUSPENDED` shops with a number. The number goes `COOLING` for 7 days; the shop loses it. | `{ "tenant": Shop, "number": Number }` |
| `POST /admin/tenants/:id/reinstate` | none | Only for `SUSPENDED`. Back to `ACTIVE` if it kept its number; otherwise back to `STOCKED` (or `PENDING`) to be approved for a new number. | Shop |

Put these in a "Danger zone" on the review screen for `ACTIVE` / `SUSPENDED` shops.

### 5.6 WhatsApp number pool

Numbers registered under the MarketiX WABA. One number per active shop.

**`GET /admin/numbers/summary`**: the four tiles and the filter-chip counts.

```json
{ "total": 16, "free": 2, "assigned": 12, "cooling": 2, "qualityIssues": 1 }
```

Tiles: **Total in pool** (`total`), **Free** (`free`, "Ready to assign"), **Assigned** (`assigned`), **Cooling** (`cooling`, "Free again after 7 days"). Chips: All · `total`, Free · `free`, Assigned · `assigned`, Cooling · `cooling`, Quality issues · `qualityIssues`. Reload the summary after any action on this page.

**`GET /admin/numbers?status=FREE,COOLING&quality=issues`**: the table. `status` takes one or more of `FREE`, `ASSIGNED`, `COOLING` (comma-separated, any case); `quality=issues` keeps only `YELLOW` / `RED`. Chip → query: All → none, Free → `status=FREE`, Assigned → `status=ASSIGNED`, Cooling → `status=COOLING`, Quality issues → `quality=issues`. Oldest first; no pagination.

```json
[{
  "id": "uuid", "phoneNumberId": "1404916169377344", "displayNumber": "0205960861", "wabaId": "…",
  "status": "ASSIGNED", "displayName": "Marketix", "qualityRating": "GREEN", "messagingLimit": "TIER_1K",
  "qualityIssue": false, "refreshedAt": "…", "assignedAt": "…", "releasedAt": null, "createdAt": "…", "modifiedAt": "…",
  "tenant": { "id": "uuid", "name": "Marketix", "status": "ACTIVE" }
}]
```

| Column | From | Display |
|---|---|---|
| Number | `displayNumber`, with `phoneNumberId` underneath | Format as `+233 20 596 0861`. Shorten the id, e.g. `1404 … 7344`. |
| Status | `status` | Badge. Already adjusted: a `COOLING` number released over 7 days ago comes back as `FREE`. |
| Assigned shop | `tenant` | Shop name linking to the review screen (`/admin/tenants/:id`); `—` when `null`. |
| Display name | `displayName` | `—` when `null`. |
| Quality | `qualityRating` | Dot + label: `GREEN` → Green, `YELLOW` → Yellow, `RED` → Red, `null` / `UNKNOWN` → Unrated. Highlight the row when `qualityIssue` is true. |
| Tier | `messagingLimit` | `TIER_250` → 250 / day, `TIER_1K` → 1K / day, `TIER_10K` → 10K / day, `TIER_100K` → 100K / day, `TIER_UNLIMITED` → Unlimited. Meta may not report a tier for every number: show `—` when `null`. |
| Since | depends on status | Free: "Registered {createdAt}". Assigned: "Assigned {assignedAt}". Cooling: "Free on {releasedAt + 7 days}". |
| Action | depends on status | Free → **Assign**. Assigned → **Release**. Cooling → **Free now**. |

Quality and tier refresh **only when asked** (there is no background job), so show "Last checked {refreshedAt}" and say "refreshed from Meta on demand" rather than "hourly".

#### Actions

| Action | Endpoint | Notes |
|---|---|---|
| **Add registered number** | `POST /admin/numbers` `{ "phoneNumberId": "1404916169377344", "displayNumber": "0205960861", "wabaId": "optional", "displayName": "optional" }` | See below. |
| **Assign** (Free row) | No endpoint of its own. | See below. |
| **Release** (Assigned row) | `POST /admin/numbers/:id/release` `{ "reason": "…" }` | See below. |
| **Free now** (Cooling row) | `POST /admin/numbers/:id/free` | Skips the rest of the 7 days. Confirm first: buyers of the old shop may still message it. `400` if the number is not cooling. |
| **Refresh** (one row) | `POST /admin/numbers/:id/refresh` | Returns the updated number. |
| **Refresh all** (page header) | `POST /admin/numbers/refresh` | Returns `{ "total": 16, "refreshed": 15, "failed": [{ "id": "uuid", "displayNumber": "0205…", "error": "…" }] }`. One failure does not stop the rest; list any `failed` in a toast. Takes about a second per number. |

**Add registered number.** A dialog with two required fields, *Phone number id* (Meta's numeric id from WhatsApp Manager, not the phone number) and *Phone number*, plus optional *Display name* and *WABA id* (defaults to the MarketiX WABA). The backend checks the number with Meta before saving, and saves Meta's quality and tier at once, so the new row is not "Unrated" unless Meta has no rating yet. `displayName` defaults to the name verified on Meta. Show the error under the form:

- `409` "That number is already in the pool (0205960861)."
- `400` "Meta could not find phone number id 999… . Meta WABA Error: …": wrong id, or the number is not under this WABA's token.
- `400` "Meta has phone number id 1404… as +233 20 596 0861, not 0209999999. Check both values.": the two fields do not belong together.

**Assign.** Opens a picker of shops waiting for review, from `GET /admin/vendors?tab=pending_review` (search box → `search`). Choosing a shop opens its review screen (5.3) with this number preselected in the number picker; approving there with `numberId` assigns it. The four due-diligence checks are still required. If the number was taken meanwhile, approval returns `409` "That number is not free any more. Pick another."

**Release.** A confirmation dialog. The response is `{ "tenant": Shop, "number": Number, "suspended": true }`.

- Shop still open (`tenant.status` is not `SUSPENDED`): the dialog says *"{shop} will be suspended and lose this number. Buyers will be told the shop is closed. The number cools for 7 days before it can be reused."* and requires a **reason**, which is shown to the vendor. The shop is suspended and the number released in one step (`suspended: true`).
- Shop already `SUSPENDED`: no reason needed; only the number is released (`suspended: false`).
- Errors: `400` "Give a reason: … will be suspended …" (reason missing for an open shop); `409` "This number is not assigned to a shop." / "This number has already been released." (someone else acted: refresh).

The shop can later be reinstated from its review screen (5.5); without a number it goes back to the review queue for a new one.

### 5.7 Orders (every shop)

Read-only: admins see orders, vendors change them (4.8).

**Which orders count**

| Group | Statuses | Used for |
|---|---|---|
| Placed | `PAID`, `CONFIRMED`, `PROCESSING`, `OUT_FOR_DELIVERY`, `DELIVERED`, `COMPLETED`, `CANCELLED`, `REFUNDED` | **Orders** counts. Orders never paid are left out, so abandoned MoMo prompts don't inflate the numbers. |
| Open | `PAID`, `CONFIRMED`, `PROCESSING`, `OUT_FOR_DELIVERY` | **Open** ("New, confirmed or out for delivery"): the vendor still has to fulfil them. |
| Delivered | `DELIVERED`, `COMPLETED` | **Delivered sales** = sum of their `totalAmount` (includes the delivery fee), in GHS. |
| Cancelled | `CANCELLED`, `REFUNDED` | "N cancelled" under the order count. |
| Unpaid | `PENDING`, `AWAITING_PAYMENT` | Only on a shop's order list (`tab=unpaid`). |

**Period** (all three endpoints that take it): `period` = `today`, `7d`, `30d` (default), `90d` or `all`; or a custom range with `from` and/or `to` as `YYYY-MM-DD` (whole days, both inclusive), which wins over `period`. Filters on when the order was created. Errors (`400`): "Unknown period week. Use: …", "from must be a date like 2026-11-04.", "from must be on or before to.".

#### Overview page

**`GET /admin/orders/overview?period=30d&search=ama&sort=orders&page=1&limit=10`**

| Query | Values | Default |
|---|---|---|
| `period`, `from`, `to` | see above | `30d` |
| `search` | Shop name or ref (`MX-V-0101`), order number (`MX-83JBPE`), customer name, or a buyer / contact / MoMo phone in any format (at least 3 digits) | none |
| `sort` | `orders` (most orders), `sales` (most delivered sales), `recent` (latest order first) | `orders` |
| `page`, `limit` | `limit` 1–50 | `1`, `10` |

```json
{
  "summary": { "orders": 251, "open": 3, "deliveredSales": 43156, "buyers": 24 },
  "data": [{
    "id": "uuid", "ref": "MX-V-0101", "name": "Mama Abena Tomatoes", "market": "Kejetia, Kumasi", "status": "ACTIVE",
    "orders": 64, "cancelled": 5, "open": 0, "deliveredSales": 9846, "lastOrderAt": "2026-11-04T04:10:00.000Z"
  }],
  "meta": { "total": 12, "page": 1, "limit": 10, "totalPages": 2 }
}
```

- Tiles: **Orders** = `summary.orders`; **Open orders** = `summary.open`; **Delivered sales** = `summary.deliveredSales` (format `GH₵ 43,156`); **Buyers** = `summary.buyers` ("Unique phone numbers").
- Rows are shops with at least one placed order in the period; shops with none are not listed.
- `search` narrows the **orders**, so the tiles and rows always describe the same orders. Searching a buyer's phone shows only the shops that buyer ordered from, with only that buyer's orders counted.
- Columns: Shop (name links to the shop, ref underneath), Market, Status (shop status badge, e.g. Active / Suspended), Orders (with "N cancelled" underneath when `cancelled > 0`), Open (highlight when > 0), Delivered sales, Last order (relative time), **View orders**.

#### A shop's orders ("View orders")

**`GET /admin/vendors/:id/orders?tab=placed&period=30d&search=0244&page=1&limit=20`**

| Query | Values | Default |
|---|---|---|
| `tab` | `placed`, `open`, `delivered`, `cancelled`, `unpaid`, `all` | `placed` |
| `period`, `from`, `to` | see above | `30d` |
| `search` | Order number, customer name, or buyer / contact / MoMo phone | none |
| `page`, `limit` | `limit` 1–50 | `1`, `20` |

```json
{
  "shop": { "id": "uuid", "ref": "MX-V-0001", "name": "Marketix", "market": null, "status": "ACTIVE", "whatsappNumber": "0205960861" },
  "summary": { "orders": 14, "open": 14, "deliveredSales": 0, "buyers": 5 },
  "counts": { "placed": 14, "open": 14, "delivered": 0, "cancelled": 0, "unpaid": 8, "all": 22 },
  "data": [{
    "id": "uuid", "orderNumber": "MX-83JBPE", "status": "CONFIRMED", "customerName": "Aseye", "buyerPhone": "+233598402862",
    "totalAmount": 20, "deliveryFee": 5, "paymentMethod": "COD", "fulfillment": "DELIVERY", "deliveryArea": "Other area",
    "itemCount": 1, "createdAt": "…", "updatedAt": "…"
  }],
  "meta": { "total": 14, "page": 1, "limit": 20, "totalPages": 1 }
}
```

- Header: shop name, ref, status badge, WhatsApp number, a back link to the overview, and the same four tiles from `summary` (for this shop).
- Tabs from `counts`: Placed · 14, Open · 14, Delivered · 0, Cancelled · 0, Unpaid · 8, All · 22. Counts follow `period` and `search`; `meta.total` equals `counts[tab]`.
- Table, newest first: order number, customer name and phone, status badge (labels in section 3, `OrderStatus`), items (`itemCount`), total (`GH₵`), payment method (MoMo / Card / Cash on delivery), Delivery or Pickup (+ area), placed at. Clicking a row opens the detail.
- `404` "Shop not found." for an unknown id.

#### Order detail

**`GET /admin/orders/:id`**: the full Order (same fields as the vendor's order detail in 4.8) with `items` and the shop:

```json
{
  "id": "uuid", "orderNumber": "MX-83JBPE", "status": "CONFIRMED", "totalAmount": 20, "deliveryFee": 5,
  "buyerPhone": "+233598402862", "customerName": "Aseye", "contactPhone": "0598402862",
  "paymentMethod": "COD", "paymentPhone": null, "momoNetwork": null,
  "fulfillment": "DELIVERY", "deliveryArea": "Other area", "landmark": "Near the church", "deliveryAddress": "…", "deliverySlot": "asap",
  "locationLatitude": 6.6885, "locationLongitude": -1.6244, "locationName": null, "locationAddress": null, "locationReceivedAt": "…",
  "riderName": null, "riderPhone": null, "notes": null, "createdAt": "…", "updatedAt": "…",
  "items": [{ "id": "uuid", "productName": "Tomatoes", "measureCode": "basket", "unitPrice": 15, "quantity": 1, "totalPrice": 15 }],
  "tenant": { "id": "uuid", "ref": "MX-V-0001", "name": "Marketix", "market": null, "status": "ACTIVE", "whatsappNumber": "0205960861" }
}
```

Show items with a subtotal, the delivery fee and the total; buyer and contact details; delivery details with a map link when `locationLatitude` / `locationLongitude` are set (`https://maps.google.com/?q={lat},{lng}`); payment; rider. No actions. `404` "Order not found.".

### 5.8 Audit log

Every admin action: who did it, when, and why. Entries are written in the same transaction as the action (an action that fails leaves no entry) and **cannot be edited or deleted**: there are no endpoints for it, and the database refuses `UPDATE` / `DELETE` on the table. Names are copied into each entry, so it still reads correctly after a shop is renamed or deleted.

**What is logged**

| `action` | Label | Written when | `details` |
|---|---|---|---|
| `REVIEW_STARTED` | Review started | `POST /admin/tenants/:id/start-review` | "Started reviewing." |
| `CHECKLIST_UPDATED` | Checklist updated | each changed tick in `PUT /admin/tenants/:id/checks` | 'Ticked "MoMo registered name matches".' / 'Unticked "…".' |
| `APPROVED` | Approved | approval | "Assigned +233 59 200 1128." + notes |
| `MORE_INFO_REQUESTED` | More info requested | more-info decision | the notes the vendor sees |
| `REJECTED` | Rejected | rejection | the notes |
| `SUSPENDED` | Suspended | suspend, or release of a live shop | the reason |
| `NUMBER_RELEASED` | Number released | release (shop or number pool page) | "+233 59 200 1176 released." + reason |
| `REINSTATED` | Reinstated | reinstate | "Reopened with its number." / "Back in the review queue for a new number." / "Back to not submitted: no products in stock." |
| `NUMBER_ADDED` | Number added | `POST /admin/numbers` | "Registered under WABA 123… (quality green, 1K / day)." |
| `NUMBER_FREED` | Number freed early | `POST /admin/numbers/:id/free` | "+233 59 200 1183 freed before its 7 days of cooling ended." |
| `NUMBER_REFRESHED` | Number refreshed | one number, or refresh all (one entry for the run, no number) | "Refreshed from Meta: quality green, 1K / day." / "Refreshed 15 of 16 numbers from Meta. Failed: +233 …" |
| `DOCUMENT_VIEWED` | Document viewed | each open of a KYC file on the review screen | "Opened Ghana Card (front)." |
| `NOTE_ADDED` | Note added | `POST /admin/tenants/:id/notes` | the note |
| `NOTE_EDITED` | Note edited | `PATCH …/notes/:noteId` (only when the text changes) | 'Now: "…" Before: "…"' (`metadata.previous` has the old text) |
| `NOTE_DELETED` | Note deleted | `DELETE …/notes/:noteId` | the deleted note |

**`GET /admin/audit-log?search=ama&action=APPROVED,SUSPENDED&adminId=uuid&period=30d&page=1&limit=25`**

| Query | Values | Default |
|---|---|---|
| `search` | Shop name or ref (`MX-V-0118`), WhatsApp number in any format, admin name, or text in details | none |
| `action` | One or more actions from the table above, comma-separated, any case (unknown → `400`) | all actions |
| `adminId` | A user id from `/admin/audit-log/admins` | all admins |
| `period`, `from`, `to` | as in 5.7: `today`, `7d`, `30d`, `90d`, `all`, or `from` / `to` dates | `30d` |
| `page`, `limit` | `limit` 1–50 | `1`, `25` |

```json
{
  "data": [{
    "id": "uuid",
    "createdAt": "2026-11-03T06:53:00.000Z",
    "action": "NUMBER_RELEASED",
    "actionLabel": "Number released",
    "actor": { "id": "uuid", "name": "Steph Dua" },
    "tenant": { "id": "uuid", "name": "Tafo Mini Mart", "ref": null, "exists": false },
    "number": { "id": "uuid", "displayNumber": "0592001176" },
    "details": "+233 59 200 1176 released. Shop closed permanently.",
    "metadata": null
  }],
  "meta": { "total": 48, "page": 1, "limit": 25, "totalPages": 2 }
}
```

Table columns:

- **When**: `createdAt` as "3 Nov, 06:53" with a relative time underneath.
- **Admin**: `actor.name` (e.g. shorten to "Steph D.").
- **Action**: a badge with `actionLabel`. Colour by kind: green for `APPROVED`; red for `SUSPENDED`, `NUMBER_RELEASED`, `REJECTED`; blue for `NUMBER_ADDED`, `NUMBER_FREED`, `NUMBER_REFRESHED`; grey for the rest.
- **Shop / number**: `tenant.name` linking to the review screen when `tenant.exists` is true, plain text when false (the shop was deleted), with `number.displayNumber` underneath. Either may be `null`; show `—` when both are.
- **Details**: `details`.
- `metadata` holds structured extras for a detail drawer (optional): `checks` ticked with a decision; `{ check, value }` for a checklist entry; `{ documentId, type }` for a document view; `{ before, after }` quality and tier for a refresh; `{ total, refreshed, failed }` for refresh all.

**`GET /admin/audit-log/admins`**: options for the Admin dropdown (add "All admins", which omits `adminId`).

```json
[{ "id": "uuid", "name": "MarketiX Admin", "email": "admin@marketix.app", "current": true }]
```

`current: false` is someone who appears in the log but is no longer a super admin (`email` is `null` then).

**`GET /admin/audit-log/export?…`**: **Export CSV**. Same `search`, `action`, `adminId`, `period` / `from` / `to` as the list, no paging: every matching entry, newest first, up to 10,000. Responds with `text/csv` as a download named `marketix-audit-log-YYYY-MM-DD.csv`. Columns: When (UTC, ISO), Admin, Action, Shop, Shop ref, Number, Details. Fetch it with the auth header as a blob, then save it with that file name (read it from `Content-Disposition`, which the API exposes to the browser).

---

## 6. Screen inventory

**Vendor (mobile-first)**

1. Sign up / Log in
2. Shop setup (multi-step: shop → owner → MoMo → delivery)
3. Home: onboarding checklist, or "Your shop is live" card with number, share link, QR, test order
4. ID documents (one card per type, camera upload)
5. Products: list (search, 5 per page), add/edit with measure chips, delete
6. Bulk upload (template → upload → result / error table)
7. Orders: list with status filter tabs; order detail with map pin and the next-step button
8. Shop settings (KYC fields locked after review starts)
9. Conversations (read-only, optional)

**Admin (desktop)**

1. Log in
2. Dashboard tiles + review queue table
3. Vendor review (two-column, checklist, number picker, decisions, danger zone)
4. Vendors: every shop, with tabs and counts, search, market filter, sort, pagination (`GET /admin/vendors`)
5. Number pool (summary tiles, filter chips with counts, table, add number dialog, assign via review, release with reason, refresh all)
6. Orders: platform tiles + one row per shop (`GET /admin/orders/overview`); a shop's orders with status tabs (`GET /admin/vendors/:id/orders`); order detail (`GET /admin/orders/:id`)
7. Audit log: filters (search, action, admin, period), table, CSV export (`GET /admin/audit-log`, `/admins`, `/export`)

---

## 7. Backend constraints the UI must handle

| Constraint | What to do |
|---|---|
| **CORS allowlist.** Locally, any `http://localhost:<port>` or `http://127.0.0.1:<port>` origin is allowed. In production only origins listed in the backend's `CORS_ORIGINS` are allowed. Auth uses the `Authorization` header, not cookies (no `credentials: 'include'`). `Content-Disposition` is exposed, so downloads can read their file name. | Call the API directly from the browser. Give the backend team the deployed URLs of the vendor and admin apps so they can be added to `CORS_ORIGINS`. |
| `GET /products` returns **at most 5 per page**, whatever `limit` you send. | Paginate or use infinite scroll in steps of 5. |
| Admin lists (`/admin/tenants`, `/admin/numbers`) are not paginated. | Paginate and filter client-side. |
| No password reset, no logout endpoint, no token refresh. | Logout = delete the token. Show "Contact support" for forgotten passwords. |
| Vendor WhatsApp notifications (welcome, approved, more info…) may not be delivered yet. | Don't rely on them: the vendor app must show the status and reviewer notes itself (from `/tenants/status`). |
| Document and template downloads need the auth header. | Fetch with `fetch` + blob, then `URL.createObjectURL`, not a plain `<a href>`. |
| Uploads are limited to 5 MB (documents and Excel) and 500 rows (Excel). | Check size before uploading; compress photos. |
| Unknown request fields are rejected. | Send only the documented fields. |
| Display names are not sent to Meta automatically. | After approval, remind the admin to submit the display name in WhatsApp Manager. |
