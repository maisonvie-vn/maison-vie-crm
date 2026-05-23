// ============================================================
// MAISON VIE — Edge Function: notify staff and email VIP guest on reservation
// ============================================================
// Deploy:  supabase functions deploy notify-reservation --no-verify-jwt
// Trigger 1: a Database Webhook on INSERT into public.reservations (Send Pending confirmation)
// Trigger 2: a Database Webhook on UPDATE into public.reservations (Send Status updates)
// Trigger 3: a Cron Job / GET Request with ?action=reminder (Send 4-Hour reminders)
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const NOTIFY_TO = Deno.env.get("NOTIFY_TO") ?? "info@maisonvie.vn";
const NOTIFY_FROM = Deno.env.get("NOTIFY_FROM") ?? "info@maisonvie.vn";

// Supabase details (used for cron reminder updates)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Maps for Concierge fields mapping
const SEATING_MAP: Record<string, Record<string, string>> = {
  en: { standard: "Standard Public Dining Room (1st Floor)", private: "Private Dining Room (Subject to Availability, 2nd Floor)", window: "Big Function Room (3rd Floor)" },
  fr: { standard: "Salle à Manger Publique Standard (1er Étage)", private: "Salon Privé (Sous réserve de disponibilité, 2ème Étage)", window: "Grande Salle de Réception (3ème Étage)" },
  vi: { standard: "Sảnh tiệc tiêu chuẩn (Tầng 1)", private: "Phòng riêng (Nếu còn trống, Tầng 2)", window: "Phòng tiệc lớn (Tầng 3)" },
  ja: { standard: "スタンダード一般ダイニング（1階）", private: "個室VIPルーム（空室状況による、2階）", window: "大型マルチファンクションルーム（3階）" }
};

const PURPOSE_MAP: Record<string, Record<string, string>> = {
  en: { fine_dining: "Culinary Appreciation", business: "Business & VIP Entertainment", anniversary: "Anniversary / Birthday Celebration", proposal: "Marriage Proposal 💍" },
  fr: { fine_dining: "Appréciation Gastronomique", business: "Repas d'Affaires & VIP", anniversary: "Célébration d'Anniversaire", proposal: "Demande en Mariage 💍" },
  vi: { fine_dining: "Thưởng Thức Ẩm Thực", business: "Tiếp Khách Quý & Đối Tác", anniversary: "Kỷ Niệm / Sinh Nhật", proposal: "Cầu Hôn 💍" },
  ja: { fine_dining: "お食事の愉しみ", business: "ご接待・ビジネス会食", anniversary: "記念日・お誕生日のお祝い", proposal: "プロポーズ 💍" }
};

const STATUS_LABELS: Record<string, Record<string, string>> = {
  en: { pending: "Awaiting Concierge Confirmation", confirmed: "Confirmed 🟢", declined: "Declined (Fully Booked) 🔴", rescheduled: "Rescheduled / Time Adjustment Proposed 🔵" },
  fr: { pending: "En attente de confirmation par le Concierge", confirmed: "Confirmé 🟢", declined: "Décliné (Complet) 🔴", rescheduled: "Modification d'heure proposée 🔵" },
  vi: { pending: "Đang Chờ Quản Gia Xác Nhận", confirmed: "Đã Xác Nhận 🟢", declined: "Từ chối (Hết bàn) 🔴", rescheduled: "Đề Xuất Thay Đổi Giờ 🔵" },
  ja: { pending: "コンシェルジュ確認待ち", confirmed: "予約確定 🟢", declined: "満席・予約不可 🔴", rescheduled: "日程変更のご提案 🔵" }
};

const VIP_I18N: Record<string, Record<string, any>> = {
  en: {
    pending: {
      subject: "Maison Vie — Your Invitation to Le Voyage",
      title: "An Invitation to Le Voyage",
      body: "We are delighted to receive your reservation request at Maison Vie. Our culinary team, led by Executive Chef Nguyen Thanh, is already preparing to welcome you for an unforgettable dining experience.",
      note: "Please note that our host will contact you shortly via phone or WhatsApp to finalize your preferences and confirm your reservation."
    },
    confirmed: {
      subject: "Maison Vie — Your Gastronomic Journey is Confirmed!",
      title: "Your Reservation is Confirmed",
      body: "We are absolutely delighted to confirm your upcoming reservation at Maison Vie. Executive Chef Nguyen Thanh and our service artisans look forward to welcoming you for an exceptional neoclassical French dining experience.",
      note: "Your priority table is secured. If you need any bespoke adjustments, please feel free to reach out directly to our concierge team."
    },
    declined: {
      subject: "Maison Vie — Apologies regarding your reservation request",
      title: "A Message from the Concierge",
      body: "Thank you for your interest in Maison Vie. We deeply regret to inform you that our neoclassical villa is fully committed at your requested time. We would be highly honored to welcome you at an alternative time — our Butler service will contact you shortly to arrange a priority table.",
      note: "We apologize for this inconvenience and look forward to finding a perfect time to host you soon."
    },
    rescheduled: {
      subject: "Maison Vie — Proposed Reservation Adjustment",
      title: "Reschedule Proposed",
      body: "To ensure the highest standard of hospitality, we would like to propose a slight adjustment to your reservation schedule. Please review the details below. Our team is at your immediate disposal to finalize this arrangement.",
      note: "Our concierge will call you shortly, or you can message us on WhatsApp to align on the perfect timing."
    },
    reminder: {
      subject: "Maison Vie — A Gentle Reminder of Your Dining Invitation",
      title: "Your Gastronomic Journey Awaits",
      body: "This is a gentle reminder that we look forward to welcoming you to Maison Vie in a few hours. Executive Chef Nguyen Thanh and our artisans have prepared everything to make your dining experience truly exceptional.",
      note: "If you have any last-minute delays or special requests, please call or text our hotline immediately."
    },
    dateLabel: "Date",
    timeLabel: "Time",
    guestsLabel: "Number of Guests",
    seatingLabel: "Seating Preference",
    occasionLabel: "Special Occasion",
    statusLabel: "Reservation Status",
    greeting: "Dear {name},",
    signature: "Warm regards,",
    signer: "The Concierge Team<br>Maison Vie Hanoi"
  },
  fr: {
    pending: {
      subject: "Maison Vie — Votre Invitation pour Le Voyage",
      title: "Une Invitation pour Le Voyage",
      body: "Nous sommes enchantés de recevoir votre demande de réservation chez Maison Vie. Notre équipe culinaire, sous la direction de Chef Exécutif Nguyen Thanh, se prépare déjà à vous accueillir pour une expérience gastronomique inoubliable.",
      note: "Veuillez noter que notre hôte vous contactera sous peu par téléphone ou WhatsApp pour finaliser vos préférences et confirmer votre réservation."
    },
    confirmed: {
      subject: "Maison Vie — Votre Voyage Gastronomique est Confirmé !",
      title: "Votre Réservation est Confirmée",
      body: "Nous sommes enchantés de confirmer votre réservation chez Maison Vie. Le Chef Exécutif Nguyen Thanh et notre équipe d'artisans de table se réjouissent de vous accueillir pour une expérience culinaire d'exception.",
      note: "Votre table prioritaire est réservée. Pour tout ajustement sur mesure, n'hésitez pas à contacter notre équipe de conciergerie."
    },
    declined: {
      subject: "Maison Vie — Message concernant votre demande de réservation",
      title: "Un Message de la Conciergerie",
      body: "Nous vous remercions de votre intérêt pour Maison Vie. Nous regrettons vivement de vous informer que notre villa néoclassique est complète au créneau demandé. Notre service de Conciergerie vous contactera sous peu pour vous proposer des alternatives prioritaires.",
      note: "Nous vous prions de nous excuser pour ce désagrément et espérons vous accueillir très bientôt."
    },
    rescheduled: {
      subject: "Maison Vie — Proposition de Modification de Réservation",
      title: "Modification Proposée",
      body: "Afin de vous garantir un accueil d'excellence, nous aimerions vous proposer un léger ajustement de l'heure de votre réservation. Veuillez examiner les détails ci-dessous. Notre équipe est à votre entière disposition.",
      note: "Notre concierge vous appellera rapidement, ou vous pouvez nous contacter sur WhatsApp pour convenir du moment parfait."
    },
    reminder: {
      subject: "Maison Vie — Rappel de Votre Invitation Gastronomique",
      title: "Votre Voyage Culinaire Approche",
      body: "Nous avons le plaisir de vous rappeler que nous vous attendons chez Maison Vie dans quelques heures. Notre chef et notre équipe ont tout préparé pour vous offrir une expérience d'exception.",
      note: "En cas de retard de dernière minute ou de demande particulière, veuillez contacter immédiatement notre hotline."
    },
    dateLabel: "Date",
    timeLabel: "Heure",
    guestsLabel: "Nombre de Convives",
    seatingLabel: "Préférence de Table",
    occasionLabel: "Occasion",
    statusLabel: "Statut",
    greeting: "Cher(e) {name},",
    signature: "Cordialement,",
    signer: "L'Équipe de Conciergerie<br>L'Équipe Maison Vie Hanoï"
  },
  vi: {
    pending: {
      subject: "Maison Vie — Thư Mời Hành Trình \"Le Voyage\"",
      title: "Thư Mời Hành Trình Le Voyage",
      body: "Maison Vie trân trọng cảm ơn yêu cầu đặt bàn của Quý khách cho hành trình khám phá tinh hoa ẩm thực Pháp. Đội ngũ phục vụ và Bếp trưởng Nguyễn Thanh của chúng tôi đang chuẩn bị những chuẩn mực cao nhất để mang lại cho Quý khách một buổi tối trọn vẹn.",
      note: "Quản gia của chúng tôi sẽ liên hệ trực tiếp với Quý khách qua Điện thoại hoặc WhatsApp trong thời gian sớm nhất để hoàn tất chuẩn bị."
    },
    confirmed: {
      subject: "Maison Vie — Xác Nhận Hành Trình Ẩm Thực Pháp!",
      title: "Đặt Bàn Đã Được Xác Nhận",
      body: "Maison Vie trân trọng thông báo yêu cầu đặt bàn của Quý khách đã được xác nhận chính thức. Bếp trưởng Nguyễn Thanh và đội ngũ quản gia đang hoàn tất khâu chuẩn bị cao cấp nhất để đón tiếp Quý khách.",
      note: "Vị trí đẹp nhất đã được dành riêng cho bạn. Nếu cần thêm các dịch vụ đặc biệt (trang trí, hoa tươi, nhạc...), xin hãy liên hệ quản gia."
    },
    declined: {
      subject: "Maison Vie — Thông tin về yêu cầu đặt bàn của Quý khách",
      title: "Thư Tiếc Nuối Từ Ban Quản Lý",
      body: "Maison Vie xin chân thành cảm ơn sự quan tâm của Quý khách. Chúng tôi rất tiếc phải thông báo rằng khu biệt thự Tân cổ điển đã hoàn toàn kín chỗ vào khung giờ bạn chọn. Quản gia sẽ liên hệ trực tiếp để đề xuất các khung giờ thay thế ưu tiên.",
      note: "Rất kính mong Quý khách thông cảm cho sự bất tiện này. Chúng tôi rất hy vọng được đón tiếp bạn vào dịp gần nhất."
    },
    rescheduled: {
      subject: "Maison Vie — Đề xuất Điều chỉnh Thời gian Đặt bàn",
      title: "Đề Xuất Thay Đổi Lịch",
      body: "Để đảm bảo chất lượng phục vụ và sự chuẩn bị chu đáo hoàn hảo nhất, Maison Vie xin đề nghị điều chỉnh lại thời gian đặt bàn của Quý khách sang một khung giờ mới tối ưu hơn. Rất mong bạn xem xét chi tiết bên dưới.",
      note: "Quản gia sẽ gọi điện trực tiếp, hoặc Quý khách có thể trả lời nhanh qua tin nhắn WhatsApp của chúng tôi."
    },
    reminder: {
      subject: "Maison Vie — Thư Nhắc Hẹn Hành Trình Ẩm Thực Pháp",
      title: "Hành Trình Ẩm Thực Sắp Bắt Đầu",
      body: "Maison Vie trân trọng nhắc lịch hẹn đón tiếp Quý khách tại nhà hàng trong ít giờ tới. Đội ngũ quản gia và Bếp trưởng Nguyễn Thanh của chúng tôi đã hoàn tất chuẩn bị để mang đến cho bạn trải nghiệm tuyệt vời nhất.",
      note: "Nếu Quý khách có thay đổi về thời gian hoặc yêu cầu phát sinh, xin vui lòng gọi ngay hotline để chúng tôi hỗ trợ kịp thời."
    },
    dateLabel: "Ngày",
    timeLabel: "Giờ",
    guestsLabel: "Số Lượng Khách",
    seatingLabel: "Vị Trí Ưu Thích",
    occasionLabel: "Dịp Đặc Biệt",
    statusLabel: "Trạng Thế",
    greeting: "Kính gửi Quý khách {name},",
    signature: "Trân trọng,",
    signer: "Đội Ngũ Concierge<br>Maison Vie Hà Nội"
  },
  ja: {
    pending: {
      subject: "Maison Vie — 「Le Voyage」へのご招待",
      title: "Le Voyage へのご招待",
      body: "Maison Vie へのご予約リクエストをいただき、誠にありがとうございます。エグゼクティブ・シェフ グエン・タイン率いる料理チームは、お客様に忘れられない美食体験をお届けするため、すでに準備を進めております。",
      note: "コンシェルジュ担当より、お席の確認とお好みの詳細について、まもなくお電話またはWhatsAppにてご連絡を差し上げます。"
    },
    confirmed: {
      subject: "Maison Vie — ご予約確定のお知らせ",
      title: "ご予約が確定いたしました",
      body: "Maison Vie でのご予約が正式に確定いたしました。エグゼクティブ・シェフ グエン・タインとサービススタッフ一同、お客様のご来訪を最高の状態でお迎えするため、心より準備を進めております。",
      note: "特等席をご用意いたしました。特別なご要望がございましたら、コンシェルジュまでお気軽にお申し付けください。"
    },
    declined: {
      subject: "Maison Vie — ご予約リクエストについてのお詫び",
      title: "コンシェルジュからの重要なお知らせ",
      body: "Maison Vie にご関心をお寄せいただき、誠にありがとうございます。大変心苦しいのですが、ご希望の日時は満席のためお席をご用意することができません。コンシェルジュより代替の日程をご案内いたします。",
      note: "ご不便をおかけしますことをお詫び申し上げます。またの機会にご来店いただけますよう願っております。"
    },
    rescheduled: {
      subject: "Maison Vie — ご予約日時変更のご提案",
      title: "ご予約日時変更のご提案",
      body: "より完璧なおもてなしをご提供するため、ご予約日時の調整をご提案させていただきます。詳細を以下にご案内いたしますので、ご確認ください。",
      note: "担当者がまもなくお電話を差し上げます。または、WhatsAppにて直接メッセージで日程調整を行うことも可能です。"
    },
    reminder: {
      subject: "Maison Vie — 本日のご来店時間のご案内",
      title: "まもなく美食の旅が始まります",
      body: "本日、Maison Vie へお越しいただくお時間のご案内です。エグゼクティブ・シェフをはじめスタッフ一同、お客様のご来訪を最高の状態で心よりお待ち申し上げております。",
      note: "直前の変更や遅刻などがございましたら、お早めにホットラインまでお電話にてご連絡ください。"
    },
    dateLabel: "日付",
    timeLabel: "時間",
    guestsLabel: "人数",
    seatingLabel: "お席のご希望",
    occasionLabel: "ご利用目的",
    statusLabel: "ステータス",
    greeting: "{name} 様,",
    signature: "敬具",
    signer: "コンシェルジュチーム一同<br>Maison Vie ハノイ"
  }
};

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    // ============================================================
    // ROUTE: AUTOMATED 4-HOUR CRON REMINDER SENDER
    // ============================================================
    if (action === "reminder") {
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return json({ error: "Missing Supabase DB connection environment variables on server." }, 500);
      }
      if (!RESEND_API_KEY) {
        return json({ error: "Missing Resend API Key." }, 500);
      }

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      // Get current date in Hanoi timezone (YYYY-MM-DD)
      const now = new Date();
      const hanoiStr = now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
      const hanoiDate = new Date(hanoiStr);
      const todayStr = hanoiDate.toISOString().split("T")[0];

      // Load all confirmed reservations for today that haven't received reminder
      const { data: bookings, error } = await supabase
        .from("reservations")
        .select("*")
        .eq("res_date", todayStr)
        .eq("status", "confirmed")
        .eq("reminder_sent", false);

      if (error) throw error;
      if (!bookings || bookings.length === 0) {
        return json({ ok: true, message: "No confirmed reservations need reminders at this hour." });
      }

      // Hanoi current minutes from start of day
      const currentHours = hanoiDate.getHours();
      const currentMinutes = hanoiDate.getMinutes();
      const currentTotalMin = currentHours * 60 + currentMinutes;

      const sentIds: string[] = [];

      for (const b of bookings) {
        // Parse reservation time "HH:MM"
        const [resH, resM] = b.res_time.split(":").map(Number);
        const resTotalMin = resH * 60 + resM;
        const diffMin = resTotalMin - currentTotalMin;

        // Target window: reservation starts in 3 to 5 hours (180 to 300 minutes)
        if (diffMin >= 180 && diffMin <= 300) {
          const lang = b.language && VIP_I18N[b.language] ? b.language : "en";
          const t = VIP_I18N[lang];
          const textConfig = t["reminder"];

          const seatingText = SEATING_MAP[lang][b.seating_preference] ?? SEATING_MAP[lang]["standard"];
          const purposeText = PURPOSE_MAP[lang][b.purpose] ?? PURPOSE_MAP[lang]["fine_dining"];
          const statusText = STATUS_LABELS[lang]["confirmed"];

          const guestHtml = buildGuestHtml(b, lang, textConfig, seatingText, purposeText, statusText);

          // Dispatch reminder email
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: `Maison Vie Concierge <${NOTIFY_FROM}>`,
              to: [b.email],
              subject: textConfig.subject,
              html: guestHtml,
            }),
          });

          if (res.ok) {
            sentIds.push(b.id);
            // Mark reminder_sent = true in DB
            await supabase.from("reservations").update({ reminder_sent: true }).eq("id", b.id);
          } else {
            const err = await res.text();
            console.error(`Failed to send reminder to ${b.email}:`, err);
          }
        }
      }

      return json({ ok: true, message: `Sent ${sentIds.length} reminders successfully.`, ids: sentIds });
    }

    // ============================================================
    // ROUTE: DATABASE WEBHOOK (INSERT OR UPDATE)
    // ============================================================
    const payload = await req.json();
    const eventType = payload.type || "INSERT"; // Fallback to INSERT for mock calls
    const r = payload.record ?? payload;
    const oldRecord = payload.old_record;

    const lang = r.language && VIP_I18N[r.language] ? r.language : "en";
    const t = VIP_I18N[lang];

    const seatingText = SEATING_MAP[lang][r.seating_preference] ?? SEATING_MAP[lang]["standard"];
    const purposeText = PURPOSE_MAP[lang][r.purpose] ?? PURPOSE_MAP[lang]["fine_dining"];
    const statusVal = r.status || "pending";
    const statusText = STATUS_LABELS[lang][statusVal] ?? STATUS_LABELS[lang]["pending"];

    const dietary = Array.isArray(r.dietary) && r.dietary.length
      ? r.dietary.join(", ")
      : "None";

    // 1) HANDLE ON INSERT (Initial Alert)
    if (eventType === "INSERT") {
      const staffSubject = `New Reservation Request — ${r.name} · ${r.res_date} ${r.res_time}`;
      const staffHtml = `
        <div style="font-family:Georgia,serif;max-width:560px;margin:auto;color:#222">
          <h2 style="color:#C5A55A;border-bottom:1px solid #eee;padding-bottom:8px">Maison Vie — New Reservation</h2>
          <table style="width:100%;border-collapse:collapse;font-size:15px">
            <tr><td style="padding:6px 0;color:#888;width:140px">Name</td><td><b>${esc(r.name)}</b></td></tr>
            <tr><td style="padding:6px 0;color:#888">Phone</td><td>${esc(r.phone)}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Email</td><td>${esc(r.email)}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Guests</td><td>${esc(String(r.guests))}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Date</td><td>${esc(r.res_date)}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Time</td><td>${esc(r.res_time)}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Seating Pref</td><td>${esc(seatingText)}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Special Occasion</td><td>${esc(purposeText)}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Dietary</td><td>${esc(dietary)}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Notes</td><td>${esc(r.notes || "—")}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Language</td><td>${esc(r.language || "en")}</td></tr>
            <tr><td style="padding:6px 0;color:#888">Segment</td><td><b style="color:#C5A55A;">${esc(r.customer_segment || "Standard")}</b></td></tr>
          </table>
          <p style="margin-top:20px;font-size:13px;color:#aaa">
            Received ${new Date().toLocaleString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" })} (Hanoi)
          </p>
        </div>`;

      const textConfig = t["pending"];
      const guestHtml = buildGuestHtml(r, lang, textConfig, seatingText, purposeText, statusText);

      if (RESEND_API_KEY) {
        // Email 1: Notify staff
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: `Maison Vie System <${NOTIFY_FROM}>`,
            to: [NOTIFY_TO],
            reply_to: r.email,
            subject: staffSubject,
            html: staffHtml,
          }),
        });

        // Email 2: Send VIP Guest Initial confirmation ("Awaiting verification")
        if (r.email) {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: `Maison Vie Concierge <${NOTIFY_FROM}>`,
              to: [r.email],
              subject: textConfig.subject,
              html: guestHtml,
            }),
          });
        }
      }
      return json({ ok: true, message: "New booking notifications sent." });
    }

    // 2) HANDLE ON UPDATE (Status Change Emails)
    if (eventType === "UPDATE") {
      if (!oldRecord || oldRecord.status === r.status) {
        return json({ ok: true, message: "Status unchanged — skipping notifications." });
      }

      // Check if the new status has a matching email configuration
      const statusKey = r.status as string;
      if (statusKey === "pending" || !t[statusKey]) {
        return json({ ok: true, message: `No notification triggers for status: ${statusKey}` });
      }

      const textConfig = t[statusKey];
      const guestHtml = buildGuestHtml(r, lang, textConfig, seatingText, purposeText, statusText);

      if (RESEND_API_KEY && r.email) {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: `Maison Vie Concierge <${NOTIFY_FROM}>`,
            to: [r.email],
            subject: textConfig.subject,
            html: guestHtml,
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          console.error(`Failed to send status update email to ${r.email}:`, err);
        }
      }

      return json({ ok: true, message: `Status update email dispatched for: ${statusKey}` });
    }

    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e) }, 500);
  }
});

// Helper: Build Gilded VIP Guest Email Layout
function buildGuestHtml(r: any, lang: string, textConfig: any, seatingText: string, purposeText: string, statusText: string): string {
  const t = VIP_I18N[lang];

  // Append reschedule details if available
  let bodyText = textConfig.body;
  if (r.status === "rescheduled" && r.reschedule_notes) {
    const noteHeading = lang === "vi" ? "Đề xuất đổi lịch từ Quản gia:"
      : lang === "fr" ? "Suggestion du Concierge:"
        : lang === "ja" ? "コンシェルジュからの提案内容:"
          : "Concierge Suggestion:";
    bodyText += `<div style="margin-top:15px; padding:12px; border-left:3px solid #C5A55A; background-color:#181816; font-style:italic; color:#F5F0E8;">
      <strong>${noteHeading}</strong><br>${esc(r.reschedule_notes)}
    </div>`;
  }

  return `
    <div style="background-color:#0A0A0A; padding:40px 20px; font-family:'Playfair Display', Georgia, serif; color:#F5F0E8; text-align:center;">
      <div style="max-width:600px; margin:0 auto; border:1px solid #C5A55A; padding:50px 30px; background-color:#121210; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
        <div style="font-size:24px; letter-spacing:0.25em; text-transform:uppercase; color:#C5A55A; margin-bottom:5px;">Maison Vie</div>
        <div style="font-size:14px; letter-spacing:0.15em; text-transform:uppercase; color:#8A8478; margin-bottom:30px; font-style:italic;">Le Voyage</div>
        <div style="width:40px; height:1px; background-color:#C5A55A; margin:0 auto 30px;"></div>
        
        <h3 style="font-size:20px; color:#C5A55A; font-weight:normal; margin-bottom:20px; letter-spacing:0.05em;">${textConfig.title}</h3>
        
        <div style="font-size:16px; line-height:1.8; color:#B8B0A0; text-align:left; font-family:Georgia, serif; margin-bottom:30px;">
          <p style="margin-bottom:15px; font-weight:bold; color:#F5F0E8;">${t.greeting.replace("{name}", esc(r.name))}</p>
          <p>${bodyText}</p>
        </div>
        
        <div style="background-color:#161614; border:1px solid #2A2824; padding:25px; margin-bottom:30px; text-align:left; font-family:Georgia, serif;">
          <h4 style="font-size:15px; color:#C5A55A; text-transform:uppercase; letter-spacing:0.1em; margin:0 0 15px 0; border-bottom:1px solid #2A2824; padding-bottom:8px;">Your Reservation Details</h4>
          <table style="width:100%; border-collapse:collapse; font-size:14px; color:#B8B0A0;">
            <tr><td style="padding:6px 0; font-weight:bold; width:150px; color:#8A8478;">${t.dateLabel}</td><td style="color:#F5F0E8;">${esc(r.res_date)}</td></tr>
            <tr><td style="padding:6px 0; font-weight:bold; color:#8A8478;">${t.timeLabel}</td><td style="color:#F5F0E8;">${esc(r.res_time)}</td></tr>
            <tr><td style="padding:6px 0; font-weight:bold; color:#8A8478;">${t.guestsLabel}</td><td style="color:#F5F0E8;">${esc(String(r.guests))}</td></tr>
            <tr><td style="padding:6px 0; font-weight:bold; color:#8A8478;">${t.seatingLabel}</td><td style="color:#F5F0E8;">${esc(seatingText)}</td></tr>
            <tr><td style="padding:6px 0; font-weight:bold; color:#8A8478;">${t.occasionLabel}</td><td style="color:#F5F0E8;">${esc(purposeText)}</td></tr>
            <tr><td style="padding:6px 0; font-weight:bold; color:#8A8478;">${t.statusLabel}</td><td style="color:#C5A55A; font-weight:bold;">${esc(statusText)}</td></tr>
          </table>
        </div>
        
        <p style="font-size:13px; line-height:1.6; color:#8A8478; font-style:italic; font-family:Georgia, serif; margin-bottom:30px; text-align:left;">
          ${textConfig.note}
        </p>
        
        <div style="font-size:15px; line-height:1.6; color:#B8B0A0; text-align:left; font-family:Georgia, serif;">
          <p style="margin-bottom:5px;">${t.signature}</p>
          <p style="font-weight:bold; color:#C5A55A;">${t.signer}</p>
        </div>
        
        <div style="width:100%; height:1px; background-color:#2A2824; margin:40px 0 20px;"></div>
        <div style="font-size:11px; color:#6E6A60; font-family:Georgia, serif;">
          Maison Vie Hanoi · 28 Tang Bat Ho, Hai Ba Trung, Hanoi<br>
          Hotline: +84 904 150 383 · Email: info@maisonvie.vn
        </div>
      </div>
    </div>
  `;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
