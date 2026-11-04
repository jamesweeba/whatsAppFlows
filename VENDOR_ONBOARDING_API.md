# MarketiX Vendor Onboarding API

This is the API a web frontend uses to sign a vendor up, create their shop, collect KYC documents, load products, and track review until the shop goes live on WhatsApp.

- **Base URL:** `http://localhost:3000`. In production, read it from an env variable such as `VITE_API_URL`.
- **Format:** every path starts with `/api/v1`. Request and response bodies are JSON unless noted.
- **CORS:** allowed for `localhost` origins by default. Other origins must be listed in the backend's `CORS_ORIGINS` env variable.

---

## 1. Concepts

### Authentication
- `signup` and `login` return an `accessToken`, a JWT valid for 7 days.
- Send it on every other request as `Authorization: Bearer <accessToken>`.
- A missing, invalid or expired token returns **401**. Clear the token and send the user to login.
- A vendor account owns **exactly one shop** (called a "tenant" in the API).

### Shop status (`tenant.status`)

| Status | Meaning | What the UI should show |
|---|---|---|
| `PENDING` | The shop exists but has no in-stock products yet. | The onboarding checklist and an "Add your first product" prompt. |
| `STOCKED` | Has at least one in-stock product. **Submitted automatically** and waiting in the admin queue. | "Submitted — waiting for review." |
| `UNDER_REVIEW` | An admin is reviewing the shop. KYC is locked. | "Being reviewed." |
| `MORE_INFO` | The admin needs changes. `latestReview.notes` says what. | The notes, editable KYC, and a **Resubmit** button. |
| `REJECTED` | The admin rejected the shop. `latestReview.notes` gives the reason. | The notes and a **Resubmit** button. |
| `ACTIVE` | Approved and live. A WhatsApp number from the pool is assigned. KYC is locked. | "Your shop is live on <number>." |
| `SUSPENDED` | Closed by an admin. **Read-only**: every edit returns 403. | "Suspended — contact MarketiX support." |

There is **no "submit" endpoint**. The first time the shop has an in-stock product while `PENDING`, it moves to `STOCKED` on its own. That can happen when a product is created, uploaded or updated.

### Locks
- **KYC lock:** while the shop is `UNDER_REVIEW` or `ACTIVE`, these are locked:
  - `ownerFullName`, `momoNumber` and `momoName` cannot be **changed**. Re-sending the same value is fine.
  - KYC documents cannot be uploaded.

  Either attempt returns **403**, with a message telling the vendor to contact support. Disable these inputs in those states.
- **Suspended lock:** while `SUSPENDED`, every shop, document and product edit returns **403**.

### Error format
Errors use the standard NestJS shape:
```json
{ "statusCode": 400, "message": "…", "error": "Bad Request" }
```
- **`message` type:** for body validation errors it is an **array of strings**, one per problem. Otherwise it is a single string. Handle both.
- **Unknown fields:** the API rejects fields it doesn't know with `"property X should not exist"`. Send only the documented fields.
- **Showing errors:** display `message` to the user. The messages are written for vendors.

### Phone numbers
Phone fields accept the usual Ghana formats, such as `0244111222`, `+233244111222` or `+233 24 411 1222`. Anything else fails with `"<field> must be a phone number, e.g. 0244111222 or +233244111222"`.

---

## 2. Recommended UI flow

1. **Sign up or log in.** Store the token.
2. **Check whether the vendor already has a shop:** call `GET /api/v1/tenants/status`.
   - **404 `"You do not have a tenant yet."`** → show the **Create shop** form (step 3).
   - **200** → show the **Onboarding dashboard** (step 4).
3. **Create shop form:** `POST /api/v1/tenants`, then go to the dashboard.
4. **Onboarding dashboard:** built from `GET /tenants/status`, it shows:
   - a checklist from `steps[]`, with links to fix each item;
   - a status banner from the table above;
   - `latestReview.notes` when the status is `MORE_INFO` or `REJECTED`;
   - the **Resubmit** button when `canResubmit` is true;
   - the assigned number when `number` is set.
5. **Documents page:** upload or replace the 3 required documents (Ghana Card front and back, stall photo) and an optional business registration.
6. **Products page:** add products one at a time or by Excel bulk upload. Categories come from `GET /api/v1/categories`.
7. **Refresh the status** after each action, or poll `GET /tenants/status` every 30 to 60 s while the shop is `STOCKED` or `UNDER_REVIEW`.

---

## 3. Endpoints

### 3.1 Auth

#### `POST /api/v1/auth/signup`
No token needed.
```json
{ "email": "ama@example.com", "password": "secret123", "firstName": "Ama", "lastName": "Mensah" }
```
| Field | Rules |
|---|---|
| `email` | Valid email. Must be unique: a duplicate returns **409** `"A user with this email already exists"`. |
| `password` | String, **at least 8 characters**. |
| `firstName`, `lastName` | Non-empty strings. |

**201**
```json
{
  "user": { "id": "uuid", "email": "ama@example.com", "firstName": "Ama", "lastName": "Mensah", "role": "VENDOR", "createdAt": "…" },
  "accessToken": "eyJ…"
}
```

#### `POST /api/v1/auth/login`
No token needed. Send `{ "email", "password" }`.
- **200:** the same shape as signup.
- **401:** `"Invalid email or password"`.

#### `GET /api/v1/auth/me`
Returns the logged-in user, loaded fresh from the database.

**200**
```json
{ "user": { "id": "…", "email": "…", "firstName": "…", "lastName": "…", "role": "VENDOR", "createdAt": "…", "modifiedAt": "…" } }
```
Use `role` to route: `VENDOR` goes to the vendor app, `SUPER_ADMIN` to the admin app.

---

### 3.2 Shop (tenant)

#### `POST /api/v1/tenants`
Creates the vendor's shop with status `PENDING`. The vendor is sent a welcome message.
```json
{
  "name": "Ama Groceries",
  "ownerFullName": "Ama Mensah",
  "ownerPhone": "0244111222",
  "market": "Kejetia, Kumasi",
  "stallLocation": "Row C, stall 14",
  "momoNumber": "0244111222",
  "momoName": "Ama Mensah",
  "description": "Fresh vegetables every morning",
  "deliveryFee": 10,
  "pickupNote": "Pick up at the stall, ready in 30 minutes",
  "deliveryAreas": [{ "id": "knust", "title": "KNUST" }, { "id": "adum", "title": "Adum" }],
  "deliverySlots": [{ "id": "today_pm", "title": "Today, 2–5pm", "description": "Same-day delivery" }]
}
```
| Field | Required | Rules / meaning |
|---|---|---|
| `name` | ✅ | Shop name shown to buyers. |
| `ownerFullName` | ✅ | Must match the Ghana Card. **KYC field.** |
| `ownerPhone` | ✅ | The vendor's own phone. Welcome, review and order alerts go here. It is **not** the buyer-facing number. |
| `slug` | | Lowercase letters, digits and hyphens (`my-shop`). Generated from `name` if omitted. Cannot be changed later. |
| `market` | | Market or town. Required for the "Shop details" checklist step. |
| `stallLocation` | | Where the stall is inside the market. |
| `momoNumber` | | Phone format. MoMo payout number. **KYC field.** |
| `momoName` | | The name the MoMo number is registered to. **KYC field.** |
| `countryCode` | | Defaults to `"233"`. |
| `description` | | Free text. |
| `deliveryFee` | | Number ≥ 0, in GHS. Defaults to 5. |
| `pickupNote` | | Shown to buyers who choose pickup. |
| `deliveryAreas` | | Array of `{ id, title }`. `id` uses lowercase letters, digits and `_`. `title` is at most 30 characters. |
| `deliverySlots` | | Array of `{ id, title, description? }`, with the same `id` rules. `title` is at most 30 characters and `description` at most 300. An `asap` slot is always added. |

There is **no** `whatsappNumber` field. MarketiX assigns the number on approval.

**201:** the full tenant object (see the shape in §3.2 GET).

**Errors**
- **409** `"You already have a tenant. You can only update it."`
- **409** `"The slug \"x\" is already taken…"`
- **400** validation errors.

#### `GET /api/v1/tenants`
Returns the vendor's shop.
- **404:** `"You do not have a tenant yet."`

**200**
```json
{
  "id": "uuid", "name": "Ama Groceries", "slug": "ama-groceries",
  "whatsappNumber": null, "countryCode": "233", "whatsappPhoneNumberId": null,
  "wabaStatus": "PENDING_REGISTRATION", "wabaRegisteredAt": null,
  "description": null, "deliveryFee": 10, "pickupNote": "…",
  "deliveryAreas": [{ "id": "knust", "title": "KNUST" }], "deliverySlots": null,
  "status": "PENDING", "submittedAt": null,
  "ownerFullName": "Ama Mensah", "ownerPhone": "0244111222",
  "market": "Kejetia, Kumasi", "stallLocation": "Row C, stall 14",
  "momoNumber": "0244111222", "momoName": "Ama Mensah",
  "userId": "uuid", "createdAt": "…", "modifiedAt": "…"
}
```

#### `PUT /api/v1/tenants`
Partial update: send only the fields that change.
- **Fields:** the same as create, except `slug`, which is rejected.
- **Returns:** **200** with the updated tenant.

**Errors**
- **403** if the shop is `SUSPENDED`.
- **403** if a changed KYC field (`ownerFullName`, `momoNumber`, `momoName`) is sent while `UNDER_REVIEW` or `ACTIVE`.
- **400** `"WhatsApp numbers are assigned by MarketiX when your shop is approved."` if `whatsappNumber` is sent.

#### `GET /api/v1/tenants/status`
**The main endpoint for the onboarding dashboard.**
- **404:** the vendor has no shop yet. Show the create form.

**200**
```json
{
  "status": "MORE_INFO",
  "canResubmit": true,
  "steps": [
    { "key": "shop",           "label": "Shop details",                           "done": true },
    { "key": "ownerDetails",   "label": "Owner name and phone",                   "done": true },
    { "key": "momoPayout",     "label": "MoMo payout number and registered name", "done": false },
    { "key": "ghanaCardFront", "label": "Ghana Card (front)",                     "done": true },
    { "key": "ghanaCardBack",  "label": "Ghana Card (back)",                      "done": false },
    { "key": "stallPhoto",     "label": "Photo of your stall",                    "done": true },
    { "key": "products",       "label": "At least one product in stock",          "done": true },
    { "key": "approved",       "label": "Approved by MarketiX",                   "done": false }
  ],
  "latestReview": { "decision": "MORE_INFO", "notes": "The Ghana Card back is blurry, please re-upload.", "createdAt": "…" },
  "number": null
}
```
- **`steps`:** always these 8 keys, in this order. Map each `key` to the page that fixes it:
  - `shop`, `ownerDetails` and `momoPayout` → the shop form;
  - `ghanaCard*` and `stallPhoto` → the documents page;
  - `products` → the products page;
  - `approved` is informational only.
- **`latestReview`:** `null` until an admin acts. `decision` is one of `APPROVED`, `MORE_INFO`, `REJECTED`, `SUSPENDED`, `RELEASED` or `REINSTATED`. The reviewer's identity is never included.
- **`number`:** `null` until approval, then `{ "displayNumber": "0205960861", "displayName": "Ama Groceries", "assignedAt": "…" }`. This is the WhatsApp number buyers message.
- **`canResubmit`:** true only when the status is `MORE_INFO` or `REJECTED`.

#### `POST /api/v1/tenants/resubmit`
Sends the shop back for review after `MORE_INFO` or `REJECTED`. It has no body.
- **Result:** the status becomes `STOCKED` if the shop has an in-stock product. Otherwise it becomes `PENDING`, and adding a product submits it.
- **200:** the updated tenant.

**Errors (400)**
- `"Your shop is already waiting for review."`
- `"A shop that is X cannot be resubmitted."`

---

### 3.3 KYC documents

There is one document per type. Uploading a type again **replaces** the earlier file.

| `type` | Required for review |
|---|---|
| `GHANA_CARD_FRONT` | ✅ |
| `GHANA_CARD_BACK` | ✅ |
| `STALL_PHOTO` | ✅ |
| `BUSINESS_REG` | optional |

#### `POST /api/v1/tenants/documents`
A **multipart/form-data** request with two fields:
- `file`: JPEG, PNG, WebP or PDF, **at most 5 MB**;
- `type`: one of the types above.

```bash
curl -X POST http://localhost:3000/api/v1/tenants/documents \
  -H "Authorization: Bearer $TOKEN" \
  -F "type=GHANA_CARD_FRONT" -F "file=@./card-front.jpg"
```
In the browser, use `FormData`, and **do not set `Content-Type` by hand**:
```js
const fd = new FormData();
fd.append('type', 'GHANA_CARD_FRONT');
fd.append('file', fileInput.files[0]);
await fetch(`${API}/api/v1/tenants/documents`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
```

**201**
```json
{ "id": "uuid", "tenantId": "uuid", "type": "GHANA_CARD_FRONT", "fileName": "card-front.jpg", "mimeType": "image/jpeg", "size": 183422, "uploadedAt": "…" }
```

**Errors**
- **400** `"Attach the document as the \"file\" field."`
- **400** `"Upload a JPEG, PNG, WebP or PDF file."`
- **400** `"Documents must be 5 MB or smaller."`
- **400** for an invalid `type`.
- **403** if KYC is locked (`UNDER_REVIEW` or `ACTIVE`) or the shop is `SUSPENDED`.

Check the file type and size in the browser before uploading, too.

#### `GET /api/v1/tenants/documents`
**200:** an array of the document objects above, sorted by type. Use it to show which slots are filled.

#### `GET /api/v1/tenants/documents/:id/file`
Streams the file with the correct `Content-Type`.
- **Not public:** the request needs the Bearer token, so fetch the file as a blob and show it with `URL.createObjectURL(blob)`. A bare `<img src>` won't send the token.
- **404:** `"Document not found."`

---

### 3.4 Categories

#### `GET /api/v1/categories`
Needs the token **and** an existing shop; without a shop it returns 404.

**200:** the predefined categories, in display order:
```json
[
  { "id": "veg_fruits", "title": "Vegetables & fruits", "description": "Tomatoes, onions, pepper, plantain", "sortOrder": 1, "productCount": 3 },
  { "id": "rice_oil", "title": "Rice, oil & provisions", "description": "Rice, oil, sugar, tinned foods", "sortOrder": 2, "productCount": 0 }
]
```
The current ids are `veg_fruits`, `rice_oil`, `grains_flour`, `meat_frozen`, `fish_seafood`, `dairy_eggs`, `bread_snacks`, `spices`, `drinks`, `household`, `personal_care`, `baby` and `other`. Always load them from the endpoint rather than hard-coding them.

---

### 3.5 Products

Products are what submit the shop: **the first in-stock product moves a `PENDING` shop to `STOCKED`**. After any product call, refresh `GET /tenants/status`.

All product writes return **403** when the shop is `SUSPENDED`.

#### `POST /api/v1/products`
```json
{
  "name": "Tomatoes",
  "categoryId": "veg_fruits",
  "price": 20,
  "image": "https://…/tomatoes.jpg",
  "inStock": true,
  "note": "Fresh from Techiman",
  "measures": [
    { "code": "small_bowl", "label": "Small bowl", "price": 20 },
    { "code": "basket", "label": "Basket", "price": 120, "description": "Best value" }
  ]
}
```
| Field | Required | Rules |
|---|---|---|
| `name` | ✅ | Non-empty. |
| `categoryId` | ✅ | An id from `GET /categories`. An unknown id returns 400. |
| `price` | ✅ unless `measures` is given | Number ≥ 0. With measures and no price, it defaults to the cheapest measure. |
| `image` | | Image URL. |
| `inStock` | | Boolean, default `true`. |
| `note` | | Free text. |
| `measures` | | Up to **10**. These are the ways the product is sold, such as a bowl or a basket. |
| `measures[].code` | ✅ | Lowercase letters, digits and `_`. Must be unique within the product. `remove` and `none` are reserved. |
| `measures[].label` | ✅ | **At most 15 characters.** WhatsApp shows it as "label · GH₵ price". |
| `measures[].price` | ✅ | Number ≥ 0. |
| `measures[].description` | | At most 300 characters. A hint shown under the option. |

**201:** the product, with `category` and `measures` included.

#### `GET /api/v1/products?page=1&limit=5&search=tom`
Paginated. **`limit` is capped at 5**, and `search` matches the name, ignoring case.

**200**
```json
{ "data": [ /* products with category and measures */ ], "meta": { "total": 12, "page": 1, "limit": 5, "totalPages": 3 } }
```

#### Other product endpoints
- **`GET /api/v1/products/:id`:** one product. **404** `"Product not found."`
- **`PATCH /api/v1/products/:id`:** a partial update, with the same fields as create. Sending `measures` replaces the whole list.
- **`DELETE /api/v1/products/:id`:** deletes the product.

#### `GET /api/v1/products/upload/template`
Downloads `marketix-products-template.xlsx`, which includes an example row and a sheet of the category ids.
- **Fetching:** fetch it as a blob with the token, then trigger the download.
- **Columns:** `product_name, category, price, measure_1, price_1, measure_2, price_2, measure_3, price_3, note`.
- **`category`:** either an id (`veg_fruits`) or a title (`Vegetables & fruits`), in any case.

#### `POST /api/v1/products/upload`
A **multipart/form-data** request:
- `file`: **`.xlsx` or `.xls` only**, at most 5 MB and at most **500 rows**;
- `categoryId` (optional): used for rows whose category cell is empty.

The upload is **all or nothing**: if any row is invalid, nothing is imported.

**201**
```json
{ "totalRows": 3, "created": 3, "products": [{ "row": 2, "name": "Tomatoes", "categoryId": "veg_fruits" }] }
```

**400:** some rows are invalid. Show the errors as a table:
```json
{
  "statusCode": 400,
  "message": "No products were imported: 2 of 40 rows have problems. Fix them and upload again.",
  "totalRows": 40,
  "errors": [{ "row": 7, "message": "Unknown category \"veggies\". Use an id or title from the Categories sheet." }, { "row": 12, "message": "Missing \"product_name\"." }]
}
```
The `row` numbers match the Excel row numbers, since row 1 is the header.

**Other 400s** (plain `message`):
- `"No file uploaded."`
- `"Invalid file format. Only Excel files (.xlsx, .xls) are allowed."`
- `"File size exceeds limit of 5MB."`
- `"The uploaded sheet is empty…"`
- `"A sheet can have at most 500 products…"`

---

## 4. Screens to build (summary)

| Screen | Endpoints |
|---|---|
| Sign up / Log in | `POST /auth/signup`, `POST /auth/login`, `GET /auth/me` |
| Create shop | `POST /tenants` |
| Onboarding dashboard | `GET /tenants/status`, `POST /tenants/resubmit` |
| Shop settings | `GET /tenants`, `PUT /tenants` |
| KYC documents | `GET /tenants/documents`, `POST /tenants/documents`, `GET /tenants/documents/:id/file` |
| Products list + editor | `GET /categories`, `GET/POST /products`, `GET/PATCH/DELETE /products/:id` |
| Bulk upload | `GET /products/upload/template`, `POST /products/upload` |

UI rules to follow:
- Disable the KYC inputs and document uploads while `UNDER_REVIEW` or `ACTIVE`.
- Disable all edits while `SUSPENDED`.
- Show the Resubmit button only when `canResubmit` is true.
- Never show a "submit for review" button: adding an in-stock product submits the shop.
- Prices are GHS. Display them as `GH₵ 20.00`.
