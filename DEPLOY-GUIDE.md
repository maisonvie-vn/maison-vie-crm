# 🏛️ Maison Vie — CRM Reservation System Upgrade & Deploy Guide

This guide describes how to deploy the upgraded, full-featured **Maison Vie Gastronomic Reservation CRM**. The system now includes automated VIP segmentation, real-time hourly capacity checking (auto-blocking), private reschedule modals, and automated 4-hour guest reminder dispatch triggers.

---

## 📂 System Architecture & File Structure

| File | Purpose |
|------|---------|
| `le-voyage.html` | **Public Landing Page** — Elegant multi-language site with dynamic capacity auto-blocking. (Rename to `index.html` on Vercel/GitHub). |
| `dashboard.html` | **Staff CRM Dashboard** — Secure admin page to view bookings, trigger reschedules, and classify VIPs. |
| `supabase-setup.sql` | **Database Schema** — Creates tables, indexes, RPC capacity check functions, and automatic VIP triggers. |
| `notify-reservation.ts` | **Edge Function** — Combined email system (sends initial alert, status updates, and 4-hour reminders). |
| `DEPLOY-GUIDE.md` | **This Guide** — Step-by-step setup documentation. |

---

## 🚀 STEP-BY-STEP DEPLOYMENT

### STEP 1 — Database & SQL Initialization (Supabase)

1. Create a free account at [supabase.com](https://supabase.com) and click **New Project** (e.g., `maison-vie-crm`).
2. Go to **SQL Editor** ➔ Click **New Query**.
3. Paste the contents of `supabase-setup.sql` in full and click **Run**. 
   * *This sets up the `reservations` table (with new columns: `reschedule_notes`, `reminder_sent`, `customer_segment`), enables Row-Level Security, registers the `check_slot_capacity` RPC, and sets up the automated VIP trigger.*

---

### STEP 2 — Access Credentials Configuration

1. In the Supabase Dashboard, navigate to **Project Settings** ➔ **API** and copy:
   * **Project URL** (`https://xxxx.supabase.co`)
   * **anon public** key (`eyJhbGci...`)
2. Open **`le-voyage.html`** and locate the `CONFIG` block at line **660**. Paste the credentials:
   ```js
   const SUPABASE_URL = "https://xxxx.supabase.co";
   const SUPABASE_ANON_KEY = "eyJhbGciOi...";
   ```
3. Open **`dashboard.html`** and locate the `CONFIG` block at line **131**. Paste the exact same credentials:
   ```js
   const SUPABASE_URL = "https://xxxx.supabase.co";
   const SUPABASE_ANON_KEY = "eyJhbGciOi...";
   ```

---

### STEP 3 — Staff Access Accounts (Auth)

To secure the CRM Dashboard:
1. In Supabase, navigate to **Authentication** ➔ **Users**.
2. Click **Add User** ➔ **Create User** (Email & Password).
   * Enter a secure email address (e.g. `thanhceo.mr@gmail.com`) and a strong password.
   * **Uncheck** *"Auto-confirm User"* or *"Send email confirmation"* to activate the account instantly, then click **Save**.

---

### STEP 4 — Edge Function & Resend Email Setup

This single unified Edge Function handles **Host alerts**, **Initial guest pending letters**, **Status updates (Confirmed/Declined/Rescheduled)**, and **4-hour reminders**.

#### A. Set up Resend (Email Gateway)
1. Register for a free account at [resend.com](https://resend.com) (provides 100 free emails/day).
2. Go to **API Keys** and generate a key (e.g., `re_xxxx`).
3. Add and verify your domain or email address (e.g., `info@maisonvie.vn`) as a sender.

#### B. Configure Environment Secrets in Supabase
In Supabase, navigate to **Project Settings** ➔ **Edge Functions** ➔ **Secrets** and add:
* `RESEND_API_KEY` = `re_xxxx` (Your Resend API Key)
* `NOTIFY_TO` = `info@maisonvie.vn` (Staff target notification email)
* `NOTIFY_FROM` = `info@maisonvie.vn` (Sender address verified on Resend)

*(Note: Supabase automatically injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` inside Deno Edge Functions, which are used to query and mark reminders).*

#### C. Deploy the Edge Function
Make sure you have the Supabase CLI installed, then deploy from the terminal:
```bash
supabase functions deploy notify-reservation --no-verify-jwt
```
Alternatively, you can create a new function in the Supabase Edge Functions dashboard UI and paste the contents of `notify-reservation.ts`.

#### D. Attach Database Webhooks
Navigate to Supabase ➔ **Database** ➔ **Webhooks** and create **two** webhooks pointing to the deployed Edge Function URL:
1. **Webhook 1 (On INSERT)**:
   * **Event**: `INSERT` on table `reservations`.
   * **Target**: HTTP POST pointing to your Edge Function URL (`https://xxxx.supabase.co/functions/v1/notify-reservation`).
2. **Webhook 2 (On UPDATE)**:
   * **Event**: `UPDATE` on table `reservations`.
   * **Target**: HTTP POST pointing to the exact same URL.

---

### STEP 5 — Automated 4-Hour Reminders Trigger

To trigger automated email reminders exactly 3 to 5 hours prior to the guest's dining appointment, the Edge Function has a scheduled routing check.

You need to schedule an hourly trigger that pings your function's URL with the action parameter:
`https://xxxx.supabase.co/functions/v1/notify-reservation?action=reminder`

#### How to trigger this hourly:
* **Option A: Vercel Cron (Recommended)**:
  If you are deploying the code on Vercel, you can simply add a `vercel.json` file in your root:
  ```json
  {
    "crons": [{
      "path": "/api/trigger-reminders",
      "schedule": "0 * * * *"
    }]
  }
  ```
  And make `/api/trigger-reminders` do a backend fetch request to your Supabase URL `https://xxxx.supabase.co/functions/v1/notify-reservation?action=reminder`.
* **Option B: Free Online Cron Service**:
  Register a free account on [cron-job.org](https://cron-job.org), configure it to send an HTTP GET request to `https://xxxx.supabase.co/functions/v1/notify-reservation?action=reminder` every **60 minutes**, and you are set!

---

### STEP 6 — Upload & Publish (GitHub & Vercel)

1. Create a repository on GitHub (e.g. `maison-vie-crm`).
2. **Important**: Rename `le-voyage.html` to `index.html` inside the folder.
3. Upload `index.html` and `dashboard.html` directly to the repository.
4. Log into [vercel.com](https://vercel.com) ➔ **Add New Project** ➔ Import the GitHub repository and click **Deploy**.
5. Live endpoints:
   * Public Webpage: `https://your-domain.vercel.app/`
   * CRM Dashboard: `https://your-domain.vercel.app/dashboard.html`

---

## 👑 UNDERSTANDING DYNAMIC CRM LOGIC

1. **Auto-Blocking Engine**: When a user selects a date on the reservation form, the page queries the DB in real-time. If a specific time slot already has $\ge 15$ guests booked (`pending` or `confirmed`), the slot is struck out and disabled (`Hết chỗ`) dynamically in the language of choice.
2. **Automated VIP CRM Badge**: The Postgres database trigger analyzes guest booking history upon status updates. If a guest completes $\ge 3$ reservations, their row is automatically promoted to `VIP` with a gold crown `👑 VIP CUSTOMER` badge displayed on the staff CRM dashboard.
3. **Smart Reschedule Proposals**: When the host moves a booking to "Rescheduled", the dashboard triggers a custom dark-and-gold modal asking for reschedule suggestion notes. The notes are stored and automatically emailed to the guest with localized headers.
