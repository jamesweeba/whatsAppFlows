# Product videos: v1 spec

Vendors can add a short video to a product. An admin approves it, and buyers can then watch it from the order form, delivered as a WhatsApp video in the chat.

*Status, 7 Nov 2026: built. After deploying, upload the new `src/flow/flow.json` to Meta (it adds "🎥 Watch video").*

---

## Decisions

| Topic | v1 rule |
|---|---|
| What gets a video | **Per product, optional.** The photo stays as it is. The video is an extra, never a replacement. |
| Length | **30 seconds at most.** Longer uploads are cut to their first 30 seconds, and the vendor is told. |
| Approval | **An admin approves every video** before buyers see it, as with shop banners. Rejections carry a reason the vendor sees. |
| Replacing | A new upload waits for approval. Buyers keep seeing the approved one until then. |
| Removing | The vendor can remove their video at any time, with no approval needed. |
| How buyers watch | **"🎥 Watch video"** on the product screen of the order form. The server sends the video to the buyer's chat, and their basket is kept. |
| Marking | Products with an approved video show **🎥** in the catalogue. |

---

## How it works

**Vendor (web app, product editor):**
1. Under the photo, **Add video**: record or pick a clip on the phone, up to 100 MB before compression.
2. The server converts it in the background: MP4 (H.264/AAC), at most 720p, at most 30 seconds, well under WhatsApp's 16 MB. The editor shows *"Processing…"*, then *"Waiting for approval"*.
3. A rejected video shows the admin's reason. The vendor can upload again.

**Admin (web app):**
4. The sidebar and the Vendors list show how many videos are waiting, as banners do. On the vendor's review page, the Products card plays the pending video next to the product, with **Approve** and **Reject** (with a reason). Both are written to the audit log.

**Buyer (WhatsApp):**
5. In the catalogue, the product shows *"🎥 Video · from GH₵ 120"*.
6. On the product screen, they tap **🎥 Watch video**. The server sends the video into the chat with a caption (*"Rice (5 kg) from Auntie Esi's"*). The screen shows *"Sent! Close this form to watch it in the chat. Your basket is saved."*
7. They watch it, reopen the order form, and their basket is still there (it's stored on the server).

---

## Technical design

### Converting video: ffmpeg
- Add `ffmpeg` to the production image (`apk add ffmpeg` in the Dockerfile, roughly +80 MB). Developers need it installed locally to test uploads.
- **Conversion runs after the upload returns**, so the vendor never waits on a long request: `-t 30`, scale to at most 720 px on the short side, H.264 `-crf 28 -preset veryfast`, AAC 96k, `+faststart`. A 30-second phone clip takes a few seconds.
- If the result is still over 15 MB, it's re-encoded once at a lower bitrate. If it still doesn't fit, it's rejected with a message.
- A still frame from the video is saved as the poster image the admin sees before pressing play.
- If the server restarts mid-conversion, the stuck upload is marked failed at startup, and the vendor uploads again.

### Sending to WhatsApp: upload, then reuse
- When a buyer first asks for the video, the server uploads it to Meta from the **shop's own number** (`POST /{phone-number-id}/media`) and stores the returned media id. Later sends reuse that id.
- Meta keeps uploaded media for 30 days, so after **25 days** the server uploads it again. A send that fails because the media expired also re-uploads once.
- This needs no public URL and keeps video files private on our server.

### Data model (Product)
| Field | Meaning |
|---|---|
| `videoStatus` | `NONE`, `PROCESSING`, `PENDING` (waiting for an admin), `REJECTED` or `FAILED` (conversion failed). Approved = `videoApprovedAt` is set. |
| `videoUpdatedAt` / `videoApprovedAt` | When the pending upload arrived / when the live video was approved |
| `videoRejectedReason` | Shown to the vendor |
| `videoDurationSec`, `videoBytes` | Of the live video |
| `waVideoMediaId`, `waVideoUploadedAt` | Meta's copy for the shop's number |

Files are kept like banners: `videos/<tenant>/<product>/pending.mp4`, `live.mp4` and `poster.jpg`. Approving moves pending to live.

### API
**Vendor (JWT):**
- `POST /products/:id/video` (multipart `file`, up to 100 MB) returns the video state.
- `GET /products/:id/video` returns the state: `{ status, live: { durationSec, approvedAt } | null, pending: { uploadedAt } | null, rejectedReason }`.
- `GET /products/:id/video/pending` and `/live` stream the files; add `/poster` for the still.
- `DELETE /products/:id/video/pending` cancels an upload. `DELETE /products/:id/video` removes the live video.

**Admin:**
- `GET /admin/videos?status=pending` lists products waiting.
- `GET /admin/products/:id/video/pending` plays one.
- `POST /admin/products/:id/video/approve` and `.../reject` `{ reason }` decide (audit: `VIDEO_APPROVED`, `VIDEO_REJECTED`). `POST .../remove` `{ reason }` takes a live video down (audit: `VIDEO_REMOVED`).

### The order form (Flow)
- PRODUCT screen: a new `EmbeddedLink` *"🎥 Watch video"* (`visible: ${data.has_video}`) sends `data_exchange { step: "send_video", sku }`. The server sends the video to the buyer from the shop's number and re-shows PRODUCT with a one-line note.
- CATALOGUE rows: "🎥 Video ·" before the price for products with an approved video.
- `flow.json` changes, so it has to be re-uploaded to Meta (see PROJECT.md, "Keeping the Flow on Meta in sync").
- To stop repeated taps sending the same video over and over, a product's video goes to the same buyer at most once a minute.

---

## Build order
1. **Upload and conversion:** schema, ffmpeg conversion, vendor endpoints, product editor upload and status.
2. **Admin approval:** endpoints, the review UI on the vendor page, sidebar count, audit log.
3. **Buyers:** Meta media upload and reuse, the Flow button and 🎥 marker, sending, re-uploading `flow.json`.

## Later
A daily "today at my stall" shop video, automatic approval for trusted vendors, and stats on how often videos are watched and whether watchers buy.
