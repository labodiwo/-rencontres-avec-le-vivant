import { DurableObject } from "cloudflare:workers";

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
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

const isPhone = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw || !/^[+0-9().\s-]+$/.test(raw)) return false;

  const compact = raw.replace(/[().\s-]/g, "");

  // France métropolitaine :
  // 06 12 34 56 78, 01 23 45 67 89, +33 6 12 34 56 78 ou 0033 6 12 34 56 78.
  return (
    /^0[1-9]\d{8}$/.test(compact) ||
    /^\+33[1-9]\d{8}$/.test(compact) ||
    /^0033[1-9]\d{8}$/.test(compact)
  );
};

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

const getSecurityStub = (env) => {
  const id = env.SECURITY.idFromName("admin-security");
  return env.SECURITY.get(id);
};

const adminClientId = async (request) => {
  const source =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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

    if (request.method === "POST" && url.pathname === "/claim") {
      const body = await request.json();
      const weeks = Array.isArray(body.weeks)
        ? [...new Set(body.weeks.map((week) => clean(week, 10)))].slice(0, 4)
        : [];

      if (
        !weeks.length ||
        weeks.some((week) => !/^\d{4}-\d{2}-\d{2}$/.test(week))
      ) {
        return json({ ok: false, error: "Période invalide." }, 400);
      }

      const unavailableWeeks = weeks.filter(
        (week) => availability[week] === "pending" || availability[week] === "booked",
      );

      if (unavailableWeeks.length) {
        return json(
          {
            ok: false,
            error: "Cette période vient d’être réservée ou fait déjà l’objet d’une demande.",
            unavailableWeeks,
          },
          409,
        );
      }

      weeks.forEach((week) => {
        availability[week] = "pending";
      });

      await this.ctx.storage.put("availability", availability);
      return json({ ok: true, availability, weeks });
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const body = await request.json();
      const weeks = Array.isArray(body.weeks)
        ? [...new Set(body.weeks.map((week) => clean(week, 10)))].slice(0, 4)
        : [];

      weeks.forEach((week) => {
        if (availability[week] === "pending") {
          delete availability[week];
        }
      });

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


export class SecurityStore extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return json({ ok: false }, 405);
    }

    const body = await request.json();
    const clientId = clean(body.clientId, 64);
    const action = clean(body.action, 20);

    if (!/^[a-f0-9]{64}$/.test(clientId)) {
      return json({ ok: false }, 400);
    }

    const key = `admin-auth:${clientId}`;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const blockMs = 15 * 60 * 1000;
    const maxFailures = 5;
    const record = (await this.ctx.storage.get(key)) || {
      failures: [],
      blockedUntil: 0,
      lastFailureAt: 0,
    };

    record.failures = (record.failures || []).filter(
      (timestamp) => Number(timestamp) > now - windowMs,
    );

    if (action === "check") {
      const blocked = Number(record.blockedUntil || 0) > now;
      if (!blocked && record.blockedUntil) {
        record.blockedUntil = 0;
        await this.ctx.storage.put(key, record);
      }
      return json({
        ok: true,
        blocked,
        retryAfter: blocked
          ? Math.max(1, Math.ceil((record.blockedUntil - now) / 1000))
          : 0,
      });
    }

    if (action === "success") {
      await this.ctx.storage.delete(key);
      return json({ ok: true, blocked: false, retryAfter: 0 });
    }

    if (action === "failure") {
      // Un formulaire de connexion peut déclencher plusieurs requêtes presque
      // simultanément : on ne compte qu'un échec par seconde.
      if (now - Number(record.lastFailureAt || 0) > 1000) {
        record.failures.push(now);
        record.lastFailureAt = now;
      }

      if (record.failures.length >= maxFailures) {
        record.blockedUntil = now + blockMs;
      }

      await this.ctx.storage.put(key, record);
      const blocked = Number(record.blockedUntil || 0) > now;

      return json({
        ok: true,
        blocked,
        retryAfter: blocked
          ? Math.max(1, Math.ceil((record.blockedUntil - now) / 1000))
          : 0,
      });
    }

    return json({ ok: false }, 400);
  }
}

export class ReservationsStore extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const reservations =
      (await this.ctx.storage.get("reservations")) || {};

    // Les données personnelles ne sont pas conservées indéfiniment dans
    // l'outil de gestion actif. Les demandes non abouties sont supprimées
    // après un an. Les dossiers clients sont supprimés trois ans après la fin
    // de la location, même si leur statut n'a pas été repassé à "completed".
    // Les éventuels documents comptables sont archivés séparément.
    const oneYearCutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const threeYearsMs = 3 * 365 * 24 * 60 * 60 * 1000;
    let removedExpiredReservations = false;

    Object.entries(reservations).forEach(([id, reservation]) => {
      const referenceDate = Date.parse(
        reservation.updatedAt || reservation.createdAt || "",
      );

      const expiredUnsuccessful =
        ["new", "cancelled"].includes(reservation.status) &&
        Number.isFinite(referenceDate) &&
        referenceDate < oneYearCutoff;

      let clientRelationshipEndedAt = NaN;
      if (
        ["confirmed", "paid", "completed"].includes(reservation.status) &&
        /^\d{4}-\d{2}-\d{2}$/.test(reservation.weekIso || "")
      ) {
        const duration = Math.max(
          1,
          Math.min(4, Number(reservation.duration) || 1),
        );
        const start = new Date(reservation.weekIso + "T12:00:00Z");
        if (Number.isFinite(start.getTime())) {
          clientRelationshipEndedAt =
            start.getTime() + duration * 7 * 24 * 60 * 60 * 1000;
        }
      }

      // Fallback pour les anciennes fiches sans date de location exploitable.
      if (
        !Number.isFinite(clientRelationshipEndedAt) &&
        ["confirmed", "paid", "completed"].includes(reservation.status)
      ) {
        clientRelationshipEndedAt = referenceDate;
      }

      const expiredClient =
        Number.isFinite(clientRelationshipEndedAt) &&
        clientRelationshipEndedAt < Date.now() - threeYearsMs;

      if (expiredUnsuccessful || expiredClient) {
        delete reservations[id];
        removedExpiredReservations = true;
      }
    });
    if (removedExpiredReservations) {
      await this.ctx.storage.put("reservations", reservations);
    }

    let migratedLegacyStatuses = false;
    Object.values(reservations).forEach((reservation) => {
      if (reservation.status === "pending") {
        reservation.status = "new";
        migratedLegacyStatuses = true;
      }
    });

    if (migratedLegacyStatuses) {
      await this.ctx.storage.put("reservations", reservations);
    }

    const sorted = () =>
      Object.values(reservations).sort((a, b) => {
        const weekCompare = String(a.weekIso || "9999").localeCompare(
          String(b.weekIso || "9999"),
        );
        if (weekCompare !== 0) return weekCompare;
        return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      });

    if (request.method === "POST" && url.pathname === "/pedagogical-access") {
      const body = await request.json();
      const id = clean(body.id, 80);
      const action = clean(body.action, 20);
      const reservation = reservations[id];
      if (!reservation) return json({ ok: false, error: "Réservation introuvable." }, 404);
      if (action === "revoke") {
        delete reservation.pedagogicalAccess;
        await this.ctx.storage.put("reservations", reservations);
        return json({ ok: true });
      }
      if (action !== "create" || !["confirmed", "paid"].includes(reservation.status)) {
        return json({ ok: false, error: "Confirmez d’abord la réservation." }, 400);
      }
      if (!reservation.weekIso) {
        return json({ ok: false, error: "Enregistrez d’abord la date de début de location." }, 400);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(reservation.weekIso)) {
        return json({ ok: false, error: "Dates de location manquantes." }, 400);
      }
      const duration = Number(reservation.duration);
      if (![1, 2, 4].includes(duration)) {
        return json({ ok: false, error: "Durée invalide." }, 400);
      }
      const start = new Date(reservation.weekIso + "T00:00:00Z");
      if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0,10) !== reservation.weekIso || start.getUTCDay() !== 1) {
        return json({ ok: false, error: "Date de début invalide." }, 400);
      }
      // Vendredi de la dernière semaine + trois jours, à 23 h 59 UTC.
      const expiresAt = new Date(start.getTime() + ((duration - 1) * 7 + 8) * 86400000 - 1000).toISOString();
      if (Date.parse(expiresAt) <= Date.now()) return json({ ok: false, error: "La période d’accès est déjà terminée." }, 400);
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
      const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const tokenHash = Array.from(new Uint8Array(hashBytes), b => b.toString(16).padStart(2, "0")).join("");
      reservation.pedagogicalAccess = { tokenHash, expiresAt, createdAt: new Date().toISOString() };
      await this.ctx.storage.put("reservations", reservations);
      return json({ ok: true, token, expiresAt });
    }

    if (request.method === "POST" && url.pathname === "/verify-pedagogical-access") {
      const { token } = await request.json();
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return json({ ok: false }, 403);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      const valid = Object.values(reservations).some(r =>
        r.pedagogicalAccess?.tokenHash === hash &&
        Date.parse(r.pedagogicalAccess.expiresAt) > Date.now() &&
        ["confirmed", "paid", "completed"].includes(r.status)
      );
      return json({ ok: valid }, valid ? 200 : 403);
    }

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
        pedagogicalAccess: previous.pedagogicalAccess || null,
        id,
        kit: clean(body.kit || previous.kit, 120),
        week: clean(body.week || previous.week, 220),
        weekIso: clean(body.weekIso || previous.weekIso, 10),
        duration: clean(body.duration || previous.duration || "1", 10),
        formula: clean(body.formula || previous.formula, 120),
        priceSummary: clean(body.priceSummary || previous.priceSummary, 120),
        name: clean(body.name || previous.name, 120),
        email: clean(body.email || previous.email, 180),
        phone: clean(body.phone ?? previous.phone, 30),
        organisation: clean(body.organisation || previous.organisation, 180),
        childrenAge: clean(body.childrenAge || previous.childrenAge, 120),
        childrenNumber: clean(body.childrenNumber || previous.childrenNumber, 40),
        message: cleanMultiline(body.message ?? previous.message, 2500),
        status: clean(body.status || previous.status || "new", 30),
        adminNotes: cleanMultiline(body.adminNotes ?? previous.adminNotes, 3000),
        conditionsAccepted:
          typeof body.conditionsAccepted === "boolean"
            ? body.conditionsAccepted
            : Boolean(previous.conditionsAccepted),
        conditionsAcceptedAt:
          body.conditionsAccepted === true
            ? (previous.conditionsAcceptedAt || now)
            : (previous.conditionsAcceptedAt || ""),
        conditionsVersion: clean(
          body.conditionsVersion || previous.conditionsVersion,
          40,
        ),
        createdAt: previous.createdAt || now,
        updatedAt: now,
      };

      if (
        !["new", "confirmed", "paid", "completed", "cancelled"].includes(
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

    if (url.pathname.startsWith("/api/admin/")) {
      if (!env.ADMIN_KEY) {
        return json(
          { ok: false, error: "L’accès administrateur n’est pas encore configuré." },
          503,
        );
      }

      const clientId = await adminClientId(request);
      const securityStub = getSecurityStub(env);
      const checkResponse = await securityStub.fetch(
        new Request("https://security.internal/admin-auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId, action: "check" }),
        }),
      );
      const check = await checkResponse.json();

      if (check.blocked) {
        return json(
          {
            ok: false,
            error:
              "Trop de tentatives de connexion. Réessayez dans quelques minutes.",
          },
          429,
          { "retry-after": String(check.retryAfter || 900) },
        );
      }

      const providedKey = request.headers.get("x-admin-key") || "";
      if (!safeEqual(providedKey, env.ADMIN_KEY)) {
        const failureResponse = await securityStub.fetch(
          new Request("https://security.internal/admin-auth", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ clientId, action: "failure" }),
          }),
        );
        const failure = await failureResponse.json();

        if (failure.blocked) {
          return json(
            {
              ok: false,
              error:
                "Trop de tentatives de connexion. Réessayez dans quelques minutes.",
            },
            429,
            { "retry-after": String(failure.retryAfter || 900) },
          );
        }

        return json(
          {
            ok: false,
            error: "Erreur de mot de passe. Vérifiez votre saisie et réessayez.",
          },
          401,
        );
      }

      await securityStub.fetch(
        new Request("https://security.internal/admin-auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId, action: "success" }),
        }),
      );
    }

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

    if (url.pathname === "/api/admin/pedagogical-access") {
      if (!env.ADMIN_KEY || !safeEqual(request.headers.get("x-admin-key") || "", env.ADMIN_KEY)) {
        return json({ ok: false, error: "Accès administrateur refusé." }, 401);
      }
      if (request.method !== "POST" || !(request.headers.get("content-type") || "").includes("application/json")) {
        return json({ ok: false, error: "Méthode ou format invalide." }, 405);
      }
      const body = await request.json();
      const response = await getReservationsStub(env).fetch(new Request("https://reservations.internal/pedagogical-access", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      }));
      const data = await response.json();
      if (data.token) data.link = url.origin + "/acces-pedagogique?cle=" + data.token;
      delete data.token;
      return json(data, response.status);
    }

    if (url.pathname === "/acces-pedagogique") {
      const token = url.searchParams.get("cle") || "";
      const previewDemoAccess =
        env.PREVIEW_MODE === "true" && token === "demo-preview";

      let valid = previewDemoAccess;

      if (!previewDemoAccess) {
        const response = await getReservationsStub(env).fetch(
          new Request("https://reservations.internal/verify-pedagogical-access", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
          }),
        );
        valid = response.ok;
      }

      if (!valid) {
        return new Response(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="referrer" content="no-referrer">
  <title>Lien expiré ou invalide · Rencontres avec le vivant</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f7f4ee;color:#293025;font:18px/1.7 Georgia,serif}
    main{width:min(640px,90%);margin:12vh auto;padding:36px;background:#FFFDF8;border:1px solid #e2ded4;border-radius:12px}
    h1{color:#5F6B50;font-weight:400;line-height:1.15}
    a{color:#5F6B50;font-weight:700}
    .eyebrow{font:700 .72rem Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#74785e}
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Rencontres avec le vivant · Les oiseaux</p>
    <h1>Lien expiré ou invalide</h1>
    <p>Ce lien est invalide, a expiré ou a été désactivé. Contactez Rencontres avec le vivant si votre location est toujours en cours.</p>
    <p><a href="/">Retour à l’accueil</a></p>
  </main>
</body>
</html>`, {
          status: 403,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store, private",
            "referrer-policy": "no-referrer",
            "x-robots-tag": "noindex, nofollow, noarchive",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "content-security-policy": "frame-ancestors 'none'",
          },
        });
      }

      return new Response(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="referrer" content="no-referrer">
  <title>Préparer la malle Les oiseaux · Espace pédagogique privé</title>
  <style>
    *{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{margin:0;background:#EFE6D8;color:#2C2A25;font-family:Georgia,"Times New Roman",serif}
    body.private-protected{-webkit-user-select:none;user-select:none}
    a,button,summary{-webkit-user-select:none;user-select:none}
    a{color:inherit}
    .hero{padding:54px 6% 48px;background:#5F6B50;color:#fffdf8}
    .hero-inner{max-width:980px;margin:auto}
    .eyebrow{margin:0 0 10px;font:700 .72rem Arial,Helvetica,sans-serif;letter-spacing:.11em;text-transform:uppercase;color:#74785e}
    .hero .eyebrow{color:rgba(255,255,255,.72)}
    .hero h1{max-width:760px;margin:0 0 18px;font-size:clamp(2.7rem,6vw,5rem);font-weight:500;line-height:.98}
    .hero p:last-child{max-width:720px;margin:0;font-size:1.06rem;line-height:1.65;color:rgba(255,255,255,.9)}
    .private-badge{display:inline-flex;margin-top:22px;padding:8px 11px;border:1px solid rgba(255,255,255,.35);border-radius:999px;font:700 .72rem Arial,sans-serif}
    .nav-wrap{position:sticky;top:0;z-index:10;background:#FFFDF8;border-bottom:1px solid #e3dfd5}
    .nav{max-width:1080px;margin:auto;padding:10px 5%;display:flex;gap:8px;overflow-x:auto;scrollbar-width:thin}
    .nav a{background:#E7D8C8;border:1px solid #D7C7B8;flex:0 0 auto;padding:9px 12px;border-radius:999px;text-decoration:none;background:#f0eee7;color:#4c533d;font:700 .76rem Arial,sans-serif}
    section,.accordion-section{scroll-margin-top:76px}
    .section{padding:64px 6%}
    .accordion-section{
      display:block;
      width:min(1100px,88%);
      margin:16px auto;
      padding:0;
      border:1px solid #dfdcd2;
      border-radius:12px;
      overflow:hidden;
      background:#FFFDF8;
      box-shadow:0 6px 20px rgba(50,50,35,.035);
    }
    .accordion-section.alt{background:#EFE6D8}
    .accordion-section > summary{
      list-style:none;
      cursor:pointer;
      margin:0;
      padding:24px 28px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:20px;
      color:#34382e;
      font-size:clamp(1.25rem,2vw,1.65rem);
      font-weight:600;
    }
    .accordion-section > summary::-webkit-details-marker{display:none}
    .accordion-icon{
      flex:0 0 auto;
      width:34px;
      height:34px;
      border-radius:50%;
      display:grid;
      place-items:center;
      background:#7d8957;
      color:#fff;
      font:700 1.25rem/1 Arial,sans-serif;
      transition:transform .2s ease;
    }
    .accordion-section[open] .accordion-icon{transform:rotate(45deg)}
    .accordion-content{
      padding:6px 28px 34px;
      border-top:1px solid #e7e3da;
    }
    .accordion-content > .inner{max-width:none;margin:0}
    .section.alt{background:#eeece5}
    .inner{max-width:980px;margin:auto}
    .heading{max-width:720px;margin-bottom:32px}
    .heading h2{margin:0 0 14px;font-size:clamp(2rem,4vw,3rem);font-weight:500;line-height:1.08}
    .heading p{margin:0;line-height:1.7;color:#55584e}
    .welcome{display:grid;grid-template-columns:1.1fr .9fr;gap:28px;align-items:start}
    .guide-note{
      margin:0 0 24px;
      padding:18px 20px;
      border:1px solid #d8ddc8;
      border-radius:9px;
      background:#edf0e6;
    }
    .guide-note strong{
      display:block;
      margin-bottom:7px;
      color:#4f593f;
      font-family:Arial,Helvetica,sans-serif;
    }
    .guide-note p{
      margin:0;
      color:#575b50;
      font:.88rem/1.6 Arial,Helvetica,sans-serif;
    }
    .usage-note{background:#EED9CE;border-color:#C9957F;
      margin:0 0 24px;
      padding:18px 20px;
      border:1px solid #d8c9b8;
      border-radius:9px;
      background:#f6f0e8;
    }
    .usage-note strong{
      display:block;
      margin-bottom:7px;
      color:#6a5744;
      font-family:Arial,Helvetica,sans-serif;
    }
    .usage-note p{
      margin:0;
      color:#5d554d;
      font:.88rem/1.6 Arial,Helvetica,sans-serif;
    }
    .welcome-card,.info-card,.material-card,.activity-card{background:#FFFDF8;border:1px solid #dfdcd2;border-radius:10px}
    .welcome-card{padding:28px}
    .welcome-card h3{margin:0 0 12px;font-size:1.35rem}
    .welcome-card p{margin:0 0 14px;line-height:1.65}
    .welcome-card p:last-child{margin-bottom:0}
    .quick-list{display:grid;gap:10px;margin:0;padding:0;list-style:none}
    .quick-list li{padding:13px 14px;background:#D4DDC8;border-radius:7px;font:700 .86rem/1.45 Arial,sans-serif}
    .warning{padding:22px 24px;border:1px solid #d4ae72;border-radius:10px;background:#fff3df}
    .warning strong{display:block;margin-bottom:8px;color:#77511d;font-family:Arial,sans-serif}
    .warning p{margin:0;line-height:1.6}
    .three-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
    .info-card{padding:22px}
    .info-card h3{margin:0 0 10px;font-size:1.2rem}
    .info-card p{margin:0;color:#575a51;font: .9rem/1.65 Arial,sans-serif}
    .rule-box{margin-top:24px;padding:24px;background:#D4DDC8;border-radius:10px}
    .rule-box h3{margin:0 0 12px;font-size:1.35rem}
    .rule-box ul{margin:0;padding-left:20px}
    .rule-box li{margin:8px 0;line-height:1.55}
    .legal-note{margin-top:18px;padding:16px 18px;border-left:4px solid #B77B66;background:#FFFDF8;color:#5b5d54;font:.82rem/1.6 Arial,sans-serif}
    .legal-note a{color:#5F6B50;font-weight:700}
    .check-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
    .check-item{padding:16px 18px;background:#FFFDF8;border:1px solid #dfdcd2;border-radius:8px}
    .check-item strong{display:block;margin-bottom:5px}
    .check-item span{color:#61645a;font:.86rem/1.5 Arial,sans-serif}
    .optional{margin-top:20px;padding:18px;border-radius:8px;background:#EFE6D8}
    .optional h3{margin:0 0 8px;font-size:1.08rem}
    .optional p{margin:0;color:#5e6158;font:.88rem/1.6 Arial,sans-serif}
    .materials{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
    .material-card{padding:0;overflow:hidden}
    .material-card img{display:block;width:100%;height:140px;object-fit:cover;background:#efede6}
    .material-card .card-body{padding:20px}
    .material-card h3{margin:0 0 8px;font-size:1.08rem}
    .material-card p{margin:0;color:#5d6056;font:.86rem/1.55 Arial,sans-serif}
    .activities{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
    .activity-card{padding:0;overflow:hidden}
    .activity-card img{display:block;width:100%;height:170px;object-fit:cover;background:#efede6}
    .activity-card .card-body{padding:22px}
    .activity-card span{display:inline-block;margin-bottom:10px;color:#B77B66;font:700 .7rem Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase}
    .activity-card h3{margin:0 0 9px;font-size:1.18rem}
    .activity-card p{margin:0;color:#5d6056;font:.88rem/1.6 Arial,sans-serif}
    .activity-card small{display:block;margin-top:12px;color:#777a70;font:.76rem/1.5 Arial,sans-serif}
    .tools-heading{max-width:720px;margin:42px 0 22px}
    .tools-heading h3{margin:0 0 10px;font-size:1.5rem;font-weight:500}
    .tools-heading p:last-child{margin:0;color:#5d6056;font:.9rem/1.6 Arial,sans-serif}
    .tools-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
    .tool-card{padding:20px;background:#EFE6D8;border:1px solid #dfdcd2;border-radius:9px}
    .tool-card h4{margin:0 0 8px;font-size:1.08rem}
    .tool-card p{margin:0;color:#5d6056;font:.86rem/1.55 Arial,sans-serif}
    .path{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
    .path article{text-align:center;padding:22px 18px;background:#FFFDF8;border-radius:9px}
    .path strong{display:block;margin-bottom:9px;color:#5F6B50}
    .path p{margin:0;font:.88rem/1.55 Arial,sans-serif;color:#5e6158}
    .outdoor{display:grid;grid-template-columns:1fr 1fr;gap:24px}
    .observe{padding:24px;background:#FFFDF8;border-radius:10px}
    .observe h3{margin-top:0}
    .observe ul{margin:0;padding-left:20px}
    .observe li{margin:8px 0}
    .resource-layout{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:22px;align-items:start;max-width:1480px;margin:0 auto}
    .resource-layout > main{min-width:0}
    .resource-rail{position:sticky;top:118px;margin:18px 22px 28px 0;padding:20px 18px;background:#E7D8C8;border:1px solid #dfdcd2;border-radius:12px}
    .resource-rail .eyebrow{margin-bottom:7px}
    .resource-rail h2{margin:0 0 8px;font-size:1.35rem;font-weight:500;line-height:1.15}
    .resource-intro{margin:0 0 16px;color:#66695f;font:.82rem/1.5 Arial,sans-serif}
    .resource-list{display:grid;gap:10px}
    .resource-card{display:block;padding:13px 14px;background:#FFF8F1;border:1px solid #e2dfd7;border-radius:8px;color:#292b23;text-decoration:none}
    .resource-card:hover{border-color:#B77B66;background:#fff}
    .resource-type{display:block;margin-bottom:5px;color:#A96651;font:700 .65rem Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase}
    .resource-card strong{display:block;margin-bottom:5px;font-size:.96rem;line-height:1.25}
    .resource-card small{display:block;color:#696c62;font:.76rem/1.45 Arial,sans-serif}
    .resource-groups{display:grid;gap:9px}
    .resource-group{border:1px solid #D8C8B8;border-radius:8px;background:#FFF9F2;overflow:hidden}
    .resource-group summary{cursor:pointer;list-style:none;padding:12px 13px;font:700 .78rem Arial,sans-serif;color:#4f5741}
    .resource-group summary::-webkit-details-marker{display:none}
    .resource-group summary::after{content:"+";float:right;color:#A96F5E;font-size:1rem}
    .resource-group[open] summary::after{content:"–"}
    .resource-group .resource-list{padding:0 9px 10px}
    .resource-group .resource-card{margin-top:8px}
    .resource-empty{padding:0 13px 13px;color:#777a70;font:.74rem/1.45 Arial,sans-serif}
    .footer-note{padding:30px 6%;background:#5F6B50;color:#fffdf8;text-align:center}
    .footer-note p{max-width:760px;margin:0 auto;line-height:1.65}
    @media(max-width:850px){
      .resource-layout{display:block}
      .resource-rail{position:static;width:min(1100px,88%);margin:18px auto 38px}
      .resource-list{grid-template-columns:repeat(2,minmax(0,1fr))}
    }
    @media(max-width:800px){
      .welcome,.outdoor{grid-template-columns:1fr}
      .three-grid,.materials{grid-template-columns:repeat(2,1fr)}
      .resource-list{grid-template-columns:1fr}
    }
    @media(max-width:600px){
      .hero{padding:42px 24px}
      .section{padding:48px 24px}
      .three-grid,.materials,.activities,.tools-grid,.path,.check-grid{grid-template-columns:1fr}
      .activity-card img{height:150px}
      .material-card img{height:130px}
      .nav{padding-left:20px;padding-right:20px}
      .accordion-section{
        width:100%;
        margin:0;
        border-left:0;
        border-right:0;
        border-radius:0;
        box-shadow:none;
      }
      .accordion-section > summary{padding:22px 24px}
      .accordion-content{padding:0 24px 48px}
    }
  </style>
</head>
<body class="private-protected">
  <header class="hero">
    <div class="hero-inner">
      <p class="eyebrow">Rencontres avec le vivant · Espace pédagogique privé</p>
      <h1>Préparer votre rencontre avec les oiseaux</h1>
      <p>
        Cet espace vous accompagne avant l’arrivée de la malle. Il n’est pas nécessaire
        de tout lire ni de tout faire : découvrez le matériel, choisissez les propositions
        qui correspondent à votre groupe et gardez de la place pour les observations des enfants.
      </p>
      <span class="private-badge">Accès privé valide</span>
    </div>
  </header>

  <div class="nav-wrap">
    <nav class="nav" aria-label="Navigation de l’espace pédagogique">
      <a href="#commencer">Commencer</a>
      <a href="#securite">Âge & sécurité</a>
      <a href="#oiseaux">Réglementation oiseaux</a>
      <a href="#prevoir">À prévoir</a>
      <a href="#malle">Dans la malle</a>
      <a href="#activites">Animations</a>
      <a href="#dehors">Observer dehors</a>
    </nav>
  </div>

  <div class="resource-layout">
  <main>
    <section class="section" id="commencer">
      <div class="inner">
        <div class="heading">
          <p class="eyebrow">Avant de commencer</p>
          <h2>Un outil à adapter, pas un programme à suivre</h2>
          <p>
            La malle a été conçue pour pouvoir être utilisée par une équipe qui n’est pas
            spécialiste des oiseaux ou de l’éducation à l’environnement. Les fiches sont des
            points de départ : vous pouvez raccourcir, prolonger, déplacer ou laisser de côté
            une proposition selon votre groupe.
          </p>
        </div>
        <div class="guide-note">
          <strong>Le livret complet sera dans la malle</strong>
          <p>
            Cet espace en ligne vous permet de découvrir et de préparer les animations avant la remise de la malle.
            Le livret pédagogique complet, avec l’ensemble des contenus et des fiches, sera également fourni en version papier dans la malle.
          </p>
        </div>

        <div class="usage-note">
          <strong>Usage réservé à votre location</strong>
          <p>
            Les activités découvertes avec la malle peuvent bien sûr être reprises et adaptées par votre équipe dans votre structure après la location.
            En revanche, les fiches, supports visuels et outils pédagogiques originaux présentés dans cet espace ne doivent pas être diffusés publiquement, copiés ou partagés tels quels sans autorisation préalable.
          </p>
        </div>

        <div class="welcome">
          <div class="welcome-card">
            <h3>La posture proposée</h3>
            <p>Prendre le temps d’écouter, de regarder et de laisser les enfants manipuler.</p>
            <p>Une question inattendue, une peur, une observation ou un détour peuvent devenir une partie intéressante de la séance.</p>
            <p><strong>Observez les enfants autant que les oiseaux.</strong></p>
          </div>
          <ul class="quick-list">
            <li>Public principal : 3–5 ans</li>
            <li>Activités modulables et utilisables séparément</li>
            <li>Jeu libre possible avec une partie du matériel</li>
            <li>Prolongements dehors encouragés</li>
          </ul>
        </div>
      </div>
    </section>

    <details class="accordion-section section alt" id="securite">
      <summary>
        <span>Âge & sécurité</span>
        <span class="accordion-icon" aria-hidden="true">+</span>
      </summary>
      <div class="accordion-content">
      <div class="inner">
        <div class="heading">
          <p class="eyebrow">Âge & sécurité</p>
          <h2>À lire avant toute utilisation</h2>
        </div>
        <div class="warning">
          <strong>La malle ne convient pas aux enfants de moins de 3 ans.</strong>
          <p>
            Certains éléments comportent de petites pièces. L’utilisation se fait toujours
            sous la surveillance d’un adulte. L’équipe reste responsable de l’encadrement,
            de l’organisation de l’espace et de l’adaptation des propositions au groupe accueilli.
          </p>
        </div>
        <div class="three-grid" style="margin-top:18px">
          <article class="info-card">
            <h3>Avant la séance</h3>
            <p>Repérez le matériel utilisé, prévoyez un espace stable et retirez les éléments qui ne seront pas nécessaires.</p>
          </article>
          <article class="info-card">
            <h3>Pendant la séance</h3>
            <p>Présentez le matériel progressivement et restez attentif aux manipulations, en particulier avec les petites pièces.</p>
          </article>
          <article class="info-card">
            <h3>Dehors</h3>
            <p>Les règles habituelles de votre structure continuent de s’appliquer : encadrement, lieu, météo, déplacements et sécurité du groupe.</p>
          </article>
        </div>
      </div>
    
      </div>
    </details>

    <details class="accordion-section section" id="oiseaux">
      <summary>
        <span>Réglementation oiseaux</span>
        <span class="accordion-icon" aria-hidden="true">+</span>
      </summary>
      <div class="accordion-content">
      <div class="inner">
        <div class="heading">
          <p class="eyebrow">Respect du vivant</p>
          <h2>Observer les oiseaux sans les prélever ni les déranger</h2>
          <p>
            La réglementation varie selon les espèces. Pour les oiseaux bénéficiant d’un statut
            de protection, la loi protège notamment les individus, leurs œufs, leurs nids et,
            selon les cas, leurs sites de reproduction et aires de repos.
          </p>
        </div>

        <div class="rule-box">
          <h3>La règle pédagogique la plus simple</h3>
          <ul>
            <li>On observe sans capturer.</li>
            <li>On ne touche pas aux nids ni aux œufs trouvés dehors.</li>
            <li>On ne prélève pas un nid pour le rapporter dans la structure.</li>
            <li>On ne déplace pas un oiseau pour mieux l’observer.</li>
            <li>On garde ses distances avec un nid occupé et on s’éloigne si notre présence semble perturber les oiseaux.</li>
            <li>On privilégie les photographies, reproductions, figurines, sons et observations à distance.</li>
          </ul>
        </div>

        <div class="legal-note">
          <strong>Repère réglementaire :</strong> le Code de l’environnement (art. L411-1)
          et l’arrêté du 29 octobre 2009 relatif aux oiseaux protégés encadrent notamment
          la destruction ou l’enlèvement des œufs et nids, la capture ou l’enlèvement
          d’oiseaux et certaines perturbations intentionnelles.
          <br>
          <a href="https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033035411/" target="_blank" rel="noopener noreferrer">Code de l’environnement · L411-1</a>
          ·
          <a href="https://www.legifrance.gouv.fr/loda/article_lc/LEGIARTI000054806424" target="_blank" rel="noopener noreferrer">Arrêté du 29 octobre 2009 · article 3</a>
        </div>
      </div>
    
      </div>
    </details>

    <details class="accordion-section section alt" id="prevoir">
      <summary>
        <span>À prévoir dans votre structure</span>
        <span class="accordion-icon" aria-hidden="true">+</span>
      </summary>
      <div class="accordion-content">
      <div class="inner">
        <div class="heading">
          <p class="eyebrow">À préparer dans votre structure</p>
          <h2>Ce qui n’est pas fourni avec la malle</h2>
          <p>
            La majorité du matériel pédagogique est déjà réunie dans la malle.
            Quelques éléments courants restent à prévoir selon les activités choisies.
          </p>
        </div>

        <div class="check-grid">
          <div class="check-item">
            <strong>Argile</strong>
            <span>À prévoir pour l’animation « Les oiseaux sont passés par ici… ».</span>
          </div>
          <div class="check-item">
            <strong>Protections pour les enfants</strong>
            <span>Blouses, tabliers ou protections équivalentes à prévoir de manière générale pour les activités salissantes.</span>
          </div>
          <div class="check-item">
            <strong>Papier pour la peinture</strong>
            <span>À prévoir pour « Les oiseaux sont passés par ici… » et « Comme des oiseaux ».</span>
          </div>
          <div class="check-item">
            <strong>Pinceaux</strong>
            <span>À prévoir pour les activités de peinture, notamment « Les oiseaux sont passés par ici… » et « Comme des oiseaux ».</span>
          </div>
          <div class="check-item">
            <strong>Peinture</strong>
            <span>À prévoir pour « Les oiseaux sont passés par ici… » et « Comme des oiseaux ».</span>
          </div>
          <div class="check-item">
            <strong>Téléphone ou appareil photo</strong>
            <span>Utile pour photographier des observations, garder une trace d’une découverte ou prolonger certaines propositions dehors.</span>
          </div>
        </div>

        <div class="optional">
          <h3>À vérifier sur chaque fiche</h3>
          <p>
            Chaque proposition précisera clairement ce qui se trouve dans la malle,
            ce que votre structure doit prévoir et ce qui reste facultatif. Cette liste
            générale pourra donc être affinée activité par activité.
          </p>
        </div>
      </div>
    
      </div>
    </details>

    <details class="accordion-section section" id="malle">
      <summary>
        <span>Dans la malle</span>
        <span class="accordion-icon" aria-hidden="true">+</span>
      </summary>
      <div class="accordion-content">
      <div class="inner">
        <div class="heading">
          <p class="eyebrow">Découvrir la malle</p>
          <h2>Les grandes familles de matériel</h2>
          <p>Vous pourrez choisir de sortir seulement une partie de la malle selon votre séance.</p>
        </div>
        <div class="materials">
          <article class="material-card">
            <img src="/images/mini-monde-oiseaux.png" alt="Mini-monde de la malle Les oiseaux" loading="lazy">
            <div class="card-body"><h3>Mini-monde</h3><p>Habitats, figurines, éléments de décor et objets pour jouer, raconter et observer.</p></div>
          </article>
          <article class="material-card">
            <img src="/images/P1110660.JPG" alt="Œufs utilisés dans la malle pédagogique" loading="lazy">
            <div class="card-body"><h3>Œufs & nids</h3><p>Reproductions et supports de manipulation pour comparer, associer et questionner.</p></div>
          </article>
          <article class="material-card">
            <img src="/images/Cartes-oiseaux.png" alt="Cartes pédagogiques de la malle Les oiseaux" loading="lazy">
            <div class="card-body"><h3>Cartes & supports</h3><p>Cartes pédagogiques, supports d’observation et ressources à utiliser dans plusieurs animations.</p></div>
          </article>
          <article class="material-card">
            <img src="/images/Livres-oiseaux.png" alt="Albums et livres sur les oiseaux présents dans la malle" loading="lazy">
            <div class="card-body"><h3>Livres & images</h3><p>Albums, imagiers et supports visuels pour introduire ou prolonger les découvertes.</p></div>
          </article>
        </div>
      </div>
    
      </div>
    </details>

    <details class="accordion-section section alt" id="activites">
      <summary>
        <span>Animations</span>
        <span class="accordion-icon" aria-hidden="true">+</span>
      </summary>
      <div class="accordion-content">
      <div class="inner">
        <div class="heading">
          <p class="eyebrow">Préparer les animations</p>
          <h2>Quelques portes d’entrée</h2>
          <p>
            Les fiches détaillées seront ajoutées ici progressivement. Vous pourrez choisir
            une activité isolée ou construire un petit parcours sur plusieurs jours.
          </p>
        </div>
        <div class="activities">
          <article class="activity-card">
            <img src="/images/mini-monde-oiseaux.png" alt="Mini-monde utilisé pour l’animation Dans le monde des oiseaux" loading="lazy">
            <div class="card-body">
            <span>Animation 1</span>
            <h3>Dans le monde des oiseaux</h3>
            <p>Entrer dans l’univers des oiseaux par le jeu et l’imaginaire, manipuler le mini-monde et laisser les enfants inventer librement.</p>
            <small>Mini-monde · album ou histoire · exploration libre · prolongement dehors.</small>
            </div>
          </article>
          <article class="activity-card">
            <span>Animation 2</span>
            <h3>À l’écoute des oiseaux… et du monde qui nous entoure</h3>
            <p>Prendre le temps d’écouter, repérer d’où vient un son et découvrir quelques cris et chants d’oiseaux.</p>
            <small>Écoute · direction du son · près/loin · prolongement dehors.</small>
          </article>
          <article class="activity-card">
            <img src="/images/Cartes-oiseaux.png" alt="Supports d’observation utilisés autour des indices laissés par les oiseaux" loading="lazy">
            <div class="card-body">
            <span>Animation 3</span>
            <h3>Les oiseaux sont passés par ici…</h3>
            <p>Découvrir les indices de présence laissés par les oiseaux, explorer les matières naturelles et créer ses propres traces.</p>
            <small>Boîte d’indices · argile · peinture à la terre · recherche d’indices dehors.</small>
            </div>
          </article>
          <article class="activity-card">
            <img src="/images/Livres-oiseaux.png" alt="Livres et supports utilisés pour introduire les mouvements des oiseaux" loading="lazy">
            <div class="card-body">
            <span>Animation 4</span>
            <h3>Comme des oiseaux</h3>
            <p>Observer différentes manières de se déplacer chez les oiseaux et les expérimenter avec son corps.</p>
            <small>Conte en mouvement · cartes de déplacement · peinture du mouvement · observation dehors.</small>
            </div>
          </article>
          <article class="activity-card">
            <span>Animation 5</span>
            <h3>Balade avec les oiseaux</h3>
            <p>Faire de la balade elle-même une expérience : marcher lentement, écouter, suivre du regard, chercher des indices et garder une trace.</p>
            <small>Animation principalement extérieure · sans matériel spécifique de la malle.</small>
          </article>
        </div>

        <div class="tools-heading">
          <p class="eyebrow">Les autres outils de la malle</p>
          <h3>À utiliser librement pour compléter vos animations</h3>
          <p>
            Ces outils ne constituent pas des animations supplémentaires : ils peuvent soutenir une séance,
            enrichir le jeu libre ou vous aider à créer votre propre proposition.
          </p>
        </div>

        <div class="tools-grid">
          <article class="tool-card">
            <h4>Le mini-monde</h4>
            <p>Un espace de jeu et d’imaginaire ouvert, à installer et enrichir avec quelques éléments de l’environnement.</p>
          </article>
          <article class="tool-card">
            <h4>L’œuf, l’oiseau et son nid</h4>
            <p>Un jeu d’association pour observer, comparer et découvrir la diversité des œufs et des lieux de nidification.</p>
          </article>
          <article class="tool-card">
            <h4>La boîte des indices photos</h4>
            <p>Des photographies d’indices de présence pour observer, questionner et mener de petites enquêtes.</p>
          </article>
          <article class="tool-card">
            <h4>Les cartes de déplacement des oiseaux</h4>
            <p>Des cartes à intégrer dans des jeux connus ou à utiliser pour inventer vos propres propositions motrices.</p>
          </article>
          <article class="tool-card">
            <h4>L’exposition photos à compléter</h4>
            <p>Des photographies à exposer pendant la semaine et à enrichir avec les observations et créations des enfants.</p>
          </article>
          <article class="tool-card">
            <h4>Les cartes des ressentis</h4>
            <p>Un support facultatif pour aider les enfants à exprimer un ressenti, une émotion ou une impression en fin d’activité.</p>
          </article>
          <article class="tool-card">
            <h4>L’application Merlin Bird</h4>
            <p>Un outil complémentaire pour accompagner certaines écoutes et observations lorsque vous souhaitez aller plus loin.</p>
          </article>
        </div>
      </div>
    
      </div>
    </details>

    <details class="accordion-section section" id="dehors">
      <summary>
        <span>Observer dehors</span>
        <span class="accordion-icon" aria-hidden="true">+</span>
      </summary>
      <div class="accordion-content">
      <div class="inner">
        <div class="heading">
          <p class="eyebrow">Je poursuis dehors</p>
          <h2>Observer sans devoir tout connaître</h2>
          <p>
            Il n’est pas nécessaire de savoir nommer chaque espèce. L’objectif est d’aider
            les enfants à remarquer quelque chose qu’ils n’avaient peut-être pas vu ou entendu auparavant.
          </p>
        </div>
        <div class="outdoor">
          <div class="observe">
            <h3>On peut chercher…</h3>
            <ul>
              <li>un son proche ou lointain ;</li>
              <li>un oiseau posé, qui marche, saute ou vole ;</li>
              <li>une trace au sol ;</li>
              <li>un endroit où un oiseau pourrait se cacher ou se reposer ;</li>
              <li>un comportement qui intrigue les enfants.</li>
            </ul>
          </div>
          <div class="observe">
            <h3>Quelques questions possibles</h3>
            <ul>
              <li>Qu’est-ce que tu as remarqué ?</li>
              <li>Qu’est-ce qui t’a surpris ?</li>
              <li>Qu’est-ce que tu entends ?</li>
              <li>Comment l’oiseau se déplace-t-il ?</li>
              <li>Qu’aimerais-tu regarder encore ?</li>
            </ul>
          </div>
        </div>

        <div class="path" style="margin-top:26px">
          <article><strong>Je découvre</strong><p>Une histoire, une image, un objet ou une première observation.</p></article>
          <article><strong>J’expérimente</strong><p>Je manipule, j’écoute, je bouge, je compare ou je crée.</p></article>
          <article><strong>Je poursuis dehors</strong><p>Je retrouve dans l’environnement réel une question née avec la malle.</p></article>
        </div>
      </div>
    
      </div>
    </details>
  </main>

    <aside class="resource-rail" aria-labelledby="resource-title">
      <p class="eyebrow">Pour aller plus loin</p>
      <h2 id="resource-title">Pour nourrir sa curiosité</h2>
      <p class="resource-intro">Une petite bibliothèque à explorer selon vos envies. Elle pourra s’enrichir au fil du temps.</p>

      <div class="resource-groups">
        <details class="resource-group" open>
          <summary>À écouter</summary>
          <div class="resource-list">
            <a class="resource-card" href="https://podcasts.apple.com/la/podcast/gold-les-oiseaux-de-proximit%C3%A9-un-%C3%A9pisode-culte-de/id294060079?i=1000801920001" target="_blank" rel="noopener noreferrer">
              <span class="resource-type">France Inter</span>
              <strong>Les oiseaux de proximité</strong>
              <small>Un épisode de La Terre au carré consacré aux oiseaux que l’on peut rencontrer près de chez soi.</small>
            </a>
          </div>
        </details>

        <details class="resource-group">
          <summary>À lire</summary>
          <div class="resource-list">
            <a class="resource-card" href="https://www.huffingtonpost.fr/life/video/dans-sur-le-front-sur-france-5-hugo-clement-mene-l-enquete-sur-les-oiseaux_197133.html" target="_blank" rel="noopener noreferrer">
              <span class="resource-type">Le HuffPost</span>
              <strong>Où sont passés nos oiseaux ?</strong>
              <small>Bruit, bâtiments, pesticides, agriculture… un point de départ pour réfléchir aux pressions qui touchent les oiseaux.</small>
            </a>
          </div>
        </details>

        <details class="resource-group">
          <summary>À explorer</summary>
          <div class="resource-list">
            <a class="resource-card" href="https://www.lpo.fr/s-engager-a-nos-cotes/sciences-participatives/observatoire-oiseaux-des-jardins" target="_blank" rel="noopener noreferrer">
              <span class="resource-type">LPO</span>
              <strong>Observatoire Oiseaux des jardins</strong>
              <small>Observer, apprendre à reconnaître et participer à un programme de sciences participatives.</small>
            </a>
          </div>
        </details>

        <details class="resource-group" open>
          <summary>À utiliser sur le terrain</summary>
          <div class="resource-list">
            <a class="resource-card" href="https://www.lpo.fr/decouvrir-la-nature/sur-le-web/applis" target="_blank" rel="noopener noreferrer">
              <span class="resource-type">Application · LPO</span>
              <strong>OisApp</strong>
              <small>Pour découvrir et identifier les oiseaux de France métropolitaine. Certaines fonctions automatiques sont proposées avec abonnement.</small>
            </a>

            <a class="resource-card" href="https://merlin.allaboutbirds.org/" target="_blank" rel="noopener noreferrer">
              <span class="resource-type">Application · Cornell Lab</span>
              <strong>Merlin Bird ID</strong>
              <small>Très pratique pour accompagner une écoute ou une observation et tenter d’identifier un oiseau à partir du son, d’une photo ou de quelques critères.</small>
            </a>
          </div>
        </details>

        <details class="resource-group">
          <summary>À regarder</summary>
          <div class="resource-empty">D’autres vidéos et documentaires pourront être ajoutés ici progressivement.</div>
        </details>

        <details class="resource-group">
          <summary>Avec les enfants</summary>
          <div class="resource-empty">Albums, prolongements et ressources pédagogiques pourront venir compléter cette rubrique.</div>
        </details>
      </div>
    </aside>
  </div>

  <footer class="footer-note">
    <p>
      Cet espace accompagne la malle « Les oiseaux ». Le lien est personnel à votre location
      et expire automatiquement après la période prévue.
    </p>
  </footer>

  <script>
    (() => {
      const copyBlockedMessage = "Les supports de cet espace ne sont pas destinés à être copiés ou diffusés tels quels.";

      document.addEventListener("contextmenu", (event) => {
        event.preventDefault();
      });

      document.addEventListener("copy", (event) => {
        event.preventDefault();
      });

      document.addEventListener("cut", (event) => {
        event.preventDefault();
      });

      document.addEventListener("keydown", (event) => {
        const modifier = event.ctrlKey || event.metaKey;
        if (!modifier) return;

        const key = event.key.toLowerCase();
        if (["c", "x", "a", "s", "p"].includes(key)) {
          event.preventDefault();
        }
      });
    })();
  </script>
</body>
</html>`, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store, private",
          "referrer-policy": "no-referrer",
          "x-robots-tag": "noindex, nofollow, noarchive",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "content-security-policy": "frame-ancestors 'none'",
        },
      });
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
        let reservationForCalendar = payload;

        if (request.method === "DELETE" && payload.id) {
          const currentResponse = await stub.fetch(
            "https://reservations.internal/reservations",
          );
          const currentResult = await currentResponse.json();
          reservationForCalendar =
            (currentResult.reservations || []).find(
              (item) => item.id === payload.id,
            ) || payload;
        }

        if (reservationForCalendar.weekIso) {
          const status =
            request.method === "DELETE"
              ? "cancelled"
              : clean(reservationForCalendar.status, 30);
          const duration = Math.max(
            1,
            Math.min(4, Number(reservationForCalendar.duration) || 1),
          );
          const start = new Date(
            reservationForCalendar.weekIso + "T12:00:00",
          );

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

    if (url.pathname === "/api/contact") {
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
          return json(
            { ok: false, error: "La vérification anti-robot n’est pas configurée." },
            503,
          );
        }

        const turnstileToken = clean(body.turnstileToken, 3000);
        if (!turnstileToken) {
          return json({ ok: false, error: "Merci de valider la vérification anti-robot." }, 400);
        }

        const verificationResponse = await fetch(
          "https://challenges.cloudflare.com/turnstile/v0/siteverify",
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              secret: env.TURNSTILE_SECRET_KEY,
              response: turnstileToken,
            }),
          },
        );

        const verification = await verificationResponse.json();

        if (!verification.success) {
          return json(
            { ok: false, error: "La vérification anti-robot a échoué. Merci de réessayer." },
            400,
          );
        }

        const data = {
          name: clean(body.name, 120),
          email: clean(body.email, 180),
          organisation: clean(body.organisation, 180),
          age: clean(body.age, 120),
          subject: clean(body.subject, 160),
          message: cleanMultiline(body.message, 5000),
        };

        if (!data.name || !data.email || !data.message) {
          return json(
            { ok: false, error: "Merci de compléter les champs obligatoires." },
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
          return json(
            { ok: false, error: "Le service de contact n’est pas encore configuré." },
            503,
          );
        }

        const lines = [
          "Nouveau message — Rencontres avec le vivant",
          "",
          `Nom : ${data.name}`,
          `E-mail : ${data.email}`,
          `Structure : ${data.organisation || "Non renseignée"}`,
          `Âge des enfants : ${data.age || "Non renseigné"}`,
          `Sujet : ${data.subject || "Autre"}`,
          "",
          "Message :",
          data.message,
          "",
          `Message envoyé depuis ${url.origin}/contact`,
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
          subject: `Contact — ${data.subject || "Nouveau message"}`,
          text: lines.join("\n"),
        });

        return json({ ok: true });
      } catch (error) {
        console.error("Erreur contact", error);
        return json(
          {
            ok: false,
            error: "Le message n’a pas pu être envoyé. Merci de réessayer dans quelques instants.",
          },
          500,
        );
      }
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

    if (
      url.pathname === "/gestion-disponibilites" ||
      url.pathname === "/gestion-disponibilites/"
    ) {
      const assetResponse = await env.ASSETS.fetch(request);
      const headers = new Headers(assetResponse.headers);
      headers.set("cache-control", "no-store, private");
      headers.set("referrer-policy", "no-referrer");
      headers.set("x-content-type-options", "nosniff");
      headers.set("x-frame-options", "DENY");
      headers.set("content-security-policy", "frame-ancestors 'none'");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
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
        phone: clean(body.phone, 30),
        organisation: clean(body.organisation, 180),
        childrenAge: clean(body.childrenAge, 120),
        childrenNumber: clean(body.childrenNumber, 40),
        message: clean(body.message, 2500),
        conditionsAccepted: body.conditionsAccepted === true,
        conditionsVersion: clean(body.conditionsVersion, 40),
      };

      if (
        !data.kit ||
        !data.week ||
        !data.weekIso ||
        !data.duration ||
        !data.formula ||
        !data.name ||
        !data.email ||
        !data.phone ||
        !data.organisation ||
        !data.conditionsAccepted ||
        !data.conditionsVersion
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

      if (!isPhone(data.phone)) {
        return json(
          {
            ok: false,
            error:
              "Le numéro de téléphone indiqué n’est pas valide. Exemple : 06 12 34 56 78 ou +33 6 12 34 56 78.",
          },
          400,
        );
      }

      if (env.PREVIEW_MODE === "true") {
        return json({ ok: true, preview: true });
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

      if (!/^\d{4}-\d{2}-\d{2}$/.test(data.weekIso)) {
        return json({ ok: false, error: "La période sélectionnée est invalide." }, 400);
      }

      const duration = Math.max(1, Math.min(4, Number(data.duration) || 1));
      const start = new Date(data.weekIso + "T12:00:00");

      if (Number.isNaN(start.getTime())) {
        return json({ ok: false, error: "La période sélectionnée est invalide." }, 400);
      }

      const requestedWeeks = [];
      for (let index = 0; index < duration; index += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + index * 7);
        requestedWeeks.push(date.toISOString().slice(0, 10));
      }

      const availabilityStub = getAvailabilityStub(env);
      const claimResponse = await availabilityStub.fetch(
        new Request("https://availability.internal/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ weeks: requestedWeeks }),
        }),
      );
      const claimResult = await claimResponse.json();

      if (!claimResponse.ok || !claimResult.ok) {
        return json(
          {
            ok: false,
            error:
              claimResult.error ||
              "Cette période n’est plus disponible. Merci d’en choisir une autre.",
          },
          claimResponse.status === 409 ? 409 : 400,
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
        `Conditions de location : acceptées (version ${data.conditionsVersion})`,
        "",
        `Nom : ${data.name}`,
        `E-mail : ${data.email}`,
        `Téléphone : ${data.phone}`,
        `Structure : ${data.organisation}`,
        `Âge des enfants : ${data.childrenAge || "Non renseigné"}`,
        `Nombre d’enfants : ${data.childrenNumber || "Non renseigné"}`,
        "",
        "Précisions :",
        data.message || "Aucune précision.",
        "",
        `Demande envoyée depuis ${url.origin}/reserver-une-malle`,
      ];

      try {
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
      } catch (error) {
        await availabilityStub.fetch(
          new Request("https://availability.internal/release", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ weeks: requestedWeeks }),
          }),
        );
        throw error;
      }

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
      if (!reservationResponse.ok || !reservationResult.ok) {
        console.error("Impossible d'enregistrer la demande de réservation.");
        return json({ ok: false, error: "La demande n’a pas pu être enregistrée. Merci de nous contacter." }, 500);
      }

      // Accusé de réception au demandeur, distinct de la confirmation de location.
      // Une erreur d'envoi ne doit pas annuler la demande déjà enregistrée.
      try {
        const confirmationLines = [
          `Bonjour ${data.name},`,
          "",
          "Nous avons bien reçu votre demande de réservation pour la malle pédagogique « Les oiseaux ».",
          "",
          "Récapitulatif de votre demande :",
          `Malle : ${data.kit}`,
          `Période souhaitée : ${data.week}`,
          `Durée : ${data.duration} semaine(s)`,
          `Formule : ${data.formula}`,
          `Tarif estimé : ${data.priceSummary || "À confirmer"}`,
          "",
          "Votre demande est en cours de traitement. Nous reviendrons vers vous pour confirmer la disponibilité de la malle et les modalités de location.",
          "",
          "Attention : cet e-mail confirme uniquement la réception de votre demande. Il ne constitue pas une confirmation de réservation.",
          "",
          "À bientôt,",
          "Rencontres avec le vivant",
          "https://labodiwo.com",
          "",
          "Ceci est un e-mail automatique, merci de ne pas y répondre.",
          "Pour toute question concernant votre demande de réservation, contactez-nous via le formulaire : https://labodiwo.com/contact",
        ];
        await env.EMAIL.send({
          to: data.email,
          from: {
            email: "reservations@labodiwo.com",
            name: "Rencontres avec le vivant",
          },
          subject: "Nous avons bien reçu votre demande de réservation",
          text: confirmationLines.join("\n"),
        });
      } catch (error) {
        console.error("Accusé de réception client non envoyé", error);
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
