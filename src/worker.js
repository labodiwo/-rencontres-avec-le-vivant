import { DurableObject } from "cloudflare:workers";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const clean = (value, max = 500) =>
  String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, max);

const cleanMultiline = (value, max = 30000) =>
  String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);

const isEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const safeEqual = (a, b) => {
  const left = new TextEncoder().encode(String(a ?? ""));
  const right = new TextEncoder().encode(String(b ?? ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
};

const slugify = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

const getAvailabilityStub = (env) => {
  const id = env.AVAILABILITY.idFromName("calendar");
  return env.AVAILABILITY.get(id);
};

const getBlogStub = (env) => {
  const id = env.BLOG.idFromName("blog");
  return env.BLOG.get(id);
};

const getReservationsStub = (env) => {
  const id = env.RESERVATIONS.idFromName("reservations");
  return env.RESERVATIONS.get(id);
};

export class AvailabilityStore extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const availability =
      (await this.ctx.storage.get("availability")) || {};

    if (request.method === "GET" && url.pathname === "/availability") {
      return json({ ok: true, availability });
    }

    if (request.method === "POST" && url.pathname === "/availability") {
      const body = await request.json();
      const week = clean(body.week, 10);
      const status = clean(body.status, 20);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
        return json({ ok: false, error: "Semaine invalide." }, 400);
      }

      if (!["available", "pending", "booked"].includes(status)) {
        return json({ ok: false, error: "Statut invalide." }, 400);
      }

      if (status === "available") delete availability[week];
      else availability[week] = status;

      await this.ctx.storage.put("availability", availability);
      return json({ ok: true, availability });
    }

    return json({ ok: false, error: "Route introuvable." }, 404);
  }
}

export class BlogStore extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const posts = (await this.ctx.storage.get("posts")) || {};

    const sortedPosts = () =>
      Object.values(posts).sort((a, b) => {
        const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
        if (dateCompare !== 0) return dateCompare;
        return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      });

    if (request.method === "GET" && url.pathname === "/posts") {
      return json({ ok: true, posts: sortedPosts() });
    }

    if (request.method === "POST" && url.pathname === "/images") {
      const contentType = clean(request.headers.get("content-type"), 100);

      if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
        return json({ ok: false, error: "Format d’image non accepté." }, 415);
      }

      const bytes = await request.arrayBuffer();

      if (!bytes.byteLength || bytes.byteLength > 1600000) {
        return json(
          { ok: false, error: "L’image est trop volumineuse après compression." },
          413,
        );
      }

      const imageId = crypto.randomUUID();

      await this.ctx.storage.put(`image:${imageId}`, {
        type: contentType,
        bytes,
      });

      return json({ ok: true, imageId });
    }

    if (request.method === "GET" && url.pathname.startsWith("/images/")) {
      const imageId = decodeURIComponent(url.pathname.slice("/images/".length));
      const stored = await this.ctx.storage.get(`image:${imageId}`);

      if (!stored?.bytes || !stored?.type) {
        return new Response("Image introuvable.", { status: 404 });
      }

      return new Response(stored.bytes, {
        headers: {
          "content-type": stored.type,
          "cache-control": "public, max-age=86400",
        },
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/posts/")) {
      const slug = decodeURIComponent(url.pathname.slice("/posts/".length));
      const post = posts[slug];
      if (!post) return json({ ok: false, error: "Article introuvable." }, 404);
      return json({ ok: true, post });
    }

    if (request.method === "POST" && url.pathname === "/posts") {
      const body = await request.json();
      const originalSlug = clean(body.slug, 100);
      const title = clean(body.title, 180);
      const category = clean(body.category, 80);
      const date = clean(body.date, 10);
      const excerpt = cleanMultiline(body.excerpt, 500);
      const content = cleanMultiline(body.content, 30000);
      const status = clean(body.status, 20);
      const coverImageId = clean(body.coverImageId, 80);
      const coverCaption = cleanMultiline(body.coverCaption, 300);
      const galleryImageIds = Array.isArray(body.galleryImageIds)
        ? body.galleryImageIds
            .map((value) => clean(value, 80))
            .filter(Boolean)
            .slice(0, 6)
        : [];
      const galleryCaptions = Array.isArray(body.galleryCaptions)
        ? body.galleryCaptions
            .slice(0, 6)
            .map((value) => cleanMultiline(value, 300))
        : [];

      while (galleryCaptions.length < galleryImageIds.length) {
        galleryCaptions.push("");
      }

      if (!title || !excerpt || !content) {
        return json(
          { ok: false, error: "Titre, résumé et contenu sont obligatoires." },
          400,
        );
      }

      if (!["draft", "published"].includes(status)) {
        return json({ ok: false, error: "Statut invalide." }, 400);
      }

      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json({ ok: false, error: "Date invalide." }, 400);
      }

      let slug = originalSlug;

      if (!slug) {
        const base = slugify(title) || "article";
        slug = base;
        let counter = 2;
        while (posts[slug]) {
          slug = `${base}-${counter}`;
          counter += 1;
        }
      }

      if (originalSlug && !posts[originalSlug]) {
        return json({ ok: false, error: "Article introuvable." }, 404);
      }

      const previous = posts[slug] || {};
      const now = new Date().toISOString();

      posts[slug] = {
        slug,
        title,
        category,
        date: date || now.slice(0, 10),
        excerpt,
        content,
        status,
        coverImageId,
        coverCaption,
        galleryImageIds,
        galleryCaptions,
        createdAt: previous.createdAt || now,
        updatedAt: now,
      };

      await this.ctx.storage.put("posts", posts);
      return json({ ok: true, post: posts[slug], posts: sortedPosts() });
    }

    if (request.method === "DELETE" && url.pathname === "/posts") {
      const body = await request.json();
      const slug = clean(body.slug, 100);

      if (!slug || !posts[slug]) {
        return json({ ok: false, error: "Article introuvable." }, 404);
      }

      const post = posts[slug];

      if (post.coverImageId) {
        await this.ctx.storage.delete(`image:${post.coverImageId}`);
      }

      for (const imageId of post.galleryImageIds || []) {
        await this.ctx.storage.delete(`image:${imageId}`);
      }

      delete posts[slug];
      await this.ctx.storage.put("posts", posts);
      return json({ ok: true, posts: sortedPosts() });
    }

    return json({ ok: false, error: "Route introuvable." }, 404);
  }
}


export class ReservationsStore extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const reservations =
      (await this.ctx.storage.get("reservations")) || {};

    const sorted = () =>
      Object.values(reservations).sort((a, b) => {
        const weekCompare = String(a.weekIso || "9999").localeCompare(
          String(b.weekIso || "9999"),
        );
        if (weekCompare !== 0) return weekCompare;
        return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      });

    if (request.method === "GET" && url.pathname === "/reservations") {
      return json({ ok: true, reservations: sorted() });
    }

    if (request.method === "POST" && url.pathname === "/reservations") {
      const body = await request.json();
      const incomingId = clean(body.id, 80);
      const id = incomingId || crypto.randomUUID();
      const previous = reservations[id] || {};
      const now = new Date().toISOString();

      const reservation = {
        id,
        kit: clean(body.kit || previous.kit, 120),
        week: clean(body.week || previous.week, 220),
        weekIso: clean(body.weekIso || previous.weekIso, 10),
        duration: clean(body.duration || previous.duration || "1", 10),
        formula: clean(body.formula || previous.formula, 120),
        priceSummary: clean(body.priceSummary || previous.priceSummary, 120),
        name: clean(body.name || previous.name, 120),
        email: clean(body.email || previous.email, 180),
        organisation: clean(body.organisation || previous.organisation, 180),
        childrenAge: clean(body.childrenAge || previous.childrenAge, 120),
        childrenNumber: clean(body.childrenNumber || previous.childrenNumber, 40),
        message: cleanMultiline(body.message ?? previous.message, 2500),
        status: clean(body.status || previous.status || "new", 30),
        adminNotes: cleanMultiline(body.adminNotes ?? previous.adminNotes, 3000),
        createdAt: previous.createdAt || now,
        updatedAt: now,
      };

      if (
        !["new", "pending", "confirmed", "paid", "completed", "cancelled"].includes(
          reservation.status,
        )
      ) {
        return json({ ok: false, error: "Statut invalide." }, 400);
      }

      if (reservation.weekIso && !/^\d{4}-\d{2}-\d{2}$/.test(reservation.weekIso)) {
        return json({ ok: false, error: "Date de début invalide." }, 400);
      }

      reservations[id] = reservation;
      await this.ctx.storage.put("reservations", reservations);

      return json({ ok: true, reservation, reservations: sorted() });
    }

    if (request.method === "DELETE" && url.pathname === "/reservations") {
      const body = await request.json();
      const id = clean(body.id, 80);

      if (!id || !reservations[id]) {
        return json({ ok: false, error: "Réservation introuvable." }, 404);
      }

      delete reservations[id];
      await this.ctx.storage.put("reservations", reservations);
      return json({ ok: true, reservations: sorted() });
    }

    return json({ ok: false, error: "Route introuvable." }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/turnstile-config") {
      if (!env.TURNSTILE_SITE_KEY) {
        return json({ ok: false, error: "Captcha non configuré." }, 503);
      }
      return json({ ok: true, siteKey: env.TURNSTILE_SITE_KEY });
    }

    if (url.pathname === "/api/availability") {
      if (request.method !== "GET") {
        return json({ ok: false, error: "Méthode non autorisée." }, 405);
      }
      return getAvailabilityStub(env).fetch(
        "https://availability.internal/availability",
      );
    }

    if (url.pathname === "/api/admin/availability") {
      if (!env.ADMIN_KEY) {
        return json(
          { ok: false, error: "L’accès administrateur n’est pas encore configuré." },
          503,
        );
      }

      const providedKey = request.headers.get("x-admin-key") || "";
      if (!safeEqual(providedKey, env.ADMIN_KEY)) {
        return json({ ok: false, error: "Mot de passe incorrect." }, 401);
      }

      const stub = getAvailabilityStub(env);

      if (request.method === "GET") {
        return stub.fetch("https://availability.internal/availability");
      }

      if (request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          return json({ ok: false, error: "Format de requête invalide." }, 415);
        }
        return stub.fetch(
          new Request("https://availability.internal/availability", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: await request.text(),
          }),
        );
      }

      return json({ ok: false, error: "Méthode non autorisée." }, 405);
    }

    if (url.pathname === "/api/blog") {
      if (request.method !== "GET") {
        return json({ ok: false, error: "Méthode non autorisée." }, 405);
      }
      const response = await getBlogStub(env).fetch(
        "https://blog.internal/posts",
      );
      const result = await response.json();
      const published = (result.posts || []).filter(
        (post) => post.status === "published",
      );
      return json({ ok: true, posts: published });
    }

    if (url.pathname.startsWith("/api/blog-image/")) {
      if (request.method !== "GET") {
        return json({ ok: false, error: "Méthode non autorisée." }, 405);
      }

      const imageId = decodeURIComponent(
        url.pathname.slice("/api/blog-image/".length),
      );

      return getBlogStub(env).fetch(
        "https://blog.internal/images/" + encodeURIComponent(imageId),
      );
    }

    if (url.pathname.startsWith("/api/blog/")) {
      if (request.method !== "GET") {
        return json({ ok: false, error: "Méthode non autorisée." }, 405);
      }
      const slug = decodeURIComponent(url.pathname.slice("/api/blog/".length));
      const response = await getBlogStub(env).fetch(
        "https://blog.internal/posts/" + encodeURIComponent(slug),
      );
      const result = await response.json();

      if (!response.ok || !result.post || result.post.status !== "published") {
        return json({ ok: false, error: "Article introuvable." }, 404);
      }

      return json({ ok: true, post: result.post });
    }

    if (url.pathname === "/api/admin/blog-image") {
      if (!env.ADMIN_KEY) {
        return json(
          { ok: false, error: "L’accès administrateur n’est pas encore configuré." },
          503,
        );
      }

      const providedKey = request.headers.get("x-admin-key") || "";
      if (!safeEqual(providedKey, env.ADMIN_KEY)) {
        return json({ ok: false, error: "Mot de passe incorrect." }, 401);
      }

      if (request.method !== "POST") {
        return json({ ok: false, error: "Méthode non autorisée." }, 405);
      }

      const contentType = request.headers.get("content-type") || "";

      return getBlogStub(env).fetch(
        new Request("https://blog.internal/images", {
          method: "POST",
          headers: { "content-type": contentType },
          body: await request.arrayBuffer(),
        }),
      );
    }

    if (url.pathname === "/api/admin/blog") {
      if (!env.ADMIN_KEY) {
        return json(
          { ok: false, error: "L’accès administrateur n’est pas encore configuré." },
          503,
        );
      }

      const providedKey = request.headers.get("x-admin-key") || "";
      if (!safeEqual(providedKey, env.ADMIN_KEY)) {
        return json({ ok: false, error: "Mot de passe incorrect." }, 401);
      }

      const stub = getBlogStub(env);

      if (request.method === "GET") {
        return stub.fetch("https://blog.internal/posts");
      }

      if (request.method === "POST" || request.method === "DELETE") {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          return json({ ok: false, error: "Format de requête invalide." }, 415);
        }

        return stub.fetch(
          new Request("https://blog.internal/posts", {
            method: request.method,
            headers: { "content-type": "application/json" },
            body: await request.text(),
          }),
        );
      }

      return json({ ok: false, error: "Méthode non autorisée." }, 405);
    }

    if (url.pathname === "/api/admin/reservations") {
      if (!env.ADMIN_KEY) {
        return json(
          { ok: false, error: "L’accès administrateur n’est pas encore configuré." },
          503,
        );
      }

      const providedKey = request.headers.get("x-admin-key") || "";
      if (!safeEqual(providedKey, env.ADMIN_KEY)) {
        return json({ ok: false, error: "Mot de passe incorrect." }, 401);
      }

      const stub = getReservationsStub(env);

      if (request.method === "GET") {
        return stub.fetch("https://reservations.internal/reservations");
      }

      if (request.method === "POST" || request.method === "DELETE") {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          return json({ ok: false, error: "Format de requête invalide." }, 415);
        }

        const payload = await request.json();

        if (request.method === "POST" && payload.weekIso) {
          const status = clean(payload.status, 30);
          const duration = Math.max(1, Math.min(4, Number(payload.duration) || 1));
          const start = new Date(payload.weekIso + "T12:00:00");

          if (!Number.isNaN(start.getTime())) {
            const availabilityStatus =
              status === "confirmed" || status === "paid" || status === "completed"
                ? "booked"
                : status === "cancelled"
                  ? "available"
                  : "pending";

            const availabilityStub = getAvailabilityStub(env);

            for (let index = 0; index < duration; index += 1) {
              const date = new Date(start);
              date.setDate(start.getDate() + index * 7);
              const iso = date.toISOString().slice(0, 10);

              await availabilityStub.fetch(
                new Request("https://availability.internal/availability", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ week: iso, status: availabilityStatus }),
                }),
              );
            }
          }
        }

        return stub.fetch(
          new Request("https://reservations.internal/reservations", {
            method: request.method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );
      }

      return json({ ok: false, error: "Méthode non autorisée." }, 405);
    }

    if (
      url.pathname.startsWith("/blog/") &&
      url.pathname !== "/blog/" &&
      !url.pathname.includes(".")
    ) {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/article-blog";
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    if (url.pathname !== "/api/reservation") {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "POST") {
      return json({ ok: false, error: "Méthode non autorisée." }, 405);
    }

    try {
      const contentType = request.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return json({ ok: false, error: "Format de requête invalide." }, 415);
      }

      const body = await request.json();

      if (clean(body.website, 200)) {
        return json({ ok: true });
      }

      if (!env.TURNSTILE_SECRET_KEY) {
        console.error("TURNSTILE_SECRET_KEY n'est pas configuré.");
        return json(
          { ok: false, error: "Le captcha n’est pas encore configuré." },
          503,
        );
      }

      const turnstileToken = clean(body.turnstileToken, 3000);
      if (!turnstileToken) {
        return json({ ok: false, error: "Merci de valider le captcha." }, 400);
      }

      const verificationResponse = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            secret: env.TURNSTILE_SECRET_KEY,
            response: turnstileToken,
          }),
        },
      );

      const verification = await verificationResponse.json();

      if (!verification.success) {
        return json(
          {
            ok: false,
            error:
              "La vérification anti-robot a échoué. Merci de réessayer.",
          },
          400,
        );
      }

      const data = {
        kit: clean(body.kit, 120),
        week: clean(body.week, 220),
        weekIso: clean(body.weekIso, 10),
        duration: clean(body.duration, 40),
        formula: clean(body.formula, 120),
        priceSummary: clean(body.priceSummary, 120),
        name: clean(body.name, 120),
        email: clean(body.email, 180),
        organisation: clean(body.organisation, 180),
        childrenAge: clean(body.childrenAge, 120),
        childrenNumber: clean(body.childrenNumber, 40),
        message: clean(body.message, 2500),
      };

      if (
        !data.kit ||
        !data.week ||
        !data.duration ||
        !data.formula ||
        !data.name ||
        !data.email ||
        !data.organisation
      ) {
        return json(
          {
            ok: false,
            error: "Merci de compléter tous les champs obligatoires.",
          },
          400,
        );
      }

      if (!isEmail(data.email)) {
        return json(
          { ok: false, error: "L’adresse e-mail indiquée n’est pas valide." },
          400,
        );
      }

      if (!env.BOOKING_TO) {
        console.error("BOOKING_TO n'est pas configuré.");
        return json(
          {
            ok: false,
            error: "Le service de réservation n’est pas encore configuré.",
          },
          503,
        );
      }

      const lines = [
        "Nouvelle demande de réservation — Rencontres avec le vivant",
        "",
        `Malle : ${data.kit}`,
        `Période souhaitée : ${data.week}`,
        `Durée : ${data.duration} semaine(s)`,
        `Formule : ${data.formula}`,
        `Tarif estimé : ${data.priceSummary || "Non calculé"}`,
        "",
        `Nom : ${data.name}`,
        `E-mail : ${data.email}`,
        `Structure : ${data.organisation}`,
        `Âge des enfants : ${data.childrenAge || "Non renseigné"}`,
        `Nombre d’enfants : ${data.childrenNumber || "Non renseigné"}`,
        "",
        "Précisions :",
        data.message || "Aucune précision.",
        "",
        `Demande envoyée depuis ${url.origin}/reserver-une-malle`,
      ];

      await env.EMAIL.send({
        to: env.BOOKING_TO,
        from: {
          email: "reservations@labodiwo.com",
          name: "Rencontres avec le vivant",
        },
        replyTo: {
          email: data.email,
          name: data.name,
        },
        subject: `Demande de réservation — ${data.week}`,
        text: lines.join("\n"),
      });

      const reservationResponse = await getReservationsStub(env).fetch(
        new Request("https://reservations.internal/reservations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...data,
            status: "new",
            adminNotes: "",
          }),
        }),
      );

      const reservationResult = await reservationResponse.json();

      if (data.weekIso) {
        const duration = Math.max(1, Math.min(4, Number(data.duration) || 1));
        const start = new Date(data.weekIso + "T12:00:00");

        if (!Number.isNaN(start.getTime())) {
          const availabilityStub = getAvailabilityStub(env);

          for (let index = 0; index < duration; index += 1) {
            const date = new Date(start);
            date.setDate(start.getDate() + index * 7);
            const iso = date.toISOString().slice(0, 10);

            await availabilityStub.fetch(
              new Request("https://availability.internal/availability", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ week: iso, status: "pending" }),
              }),
            );
          }
        }
      }

      return json({
        ok: true,
        reservationId: reservationResult.reservation?.id || "",
      });
    } catch (error) {
      console.error("Erreur réservation", error);
      return json(
        {
          ok: false,
          error:
            "La demande n’a pas pu être envoyée. Merci de réessayer dans quelques instants.",
        },
        500,
      );
    }
  },
};
