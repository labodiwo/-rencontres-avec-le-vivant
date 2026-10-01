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

const getAvailabilityStub = (env) => {
  const id = env.AVAILABILITY.idFromName("calendar");
  return env.AVAILABILITY.get(id);
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

      if (status === "available") {
        delete availability[week];
      } else {
        availability[week] = status;
      }

      await this.ctx.storage.put("availability", availability);

      return json({ ok: true, availability });
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

      return json({
        ok: true,
        siteKey: env.TURNSTILE_SITE_KEY,
      });
    }

    if (url.pathname === "/api/availability") {
      if (request.method !== "GET") {
        return json({ ok: false, error: "Méthode non autorisée." }, 405);
      }

      const stub = getAvailabilityStub(env);
      return stub.fetch("https://availability.internal/availability");
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

        const body = await request.text();

        return stub.fetch(
          new Request("https://availability.internal/availability", {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body,
          }),
        );
      }

      return json({ ok: false, error: "Méthode non autorisée." }, 405);
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
        return json(
          { ok: false, error: "Merci de valider le captcha." },
          400,
        );
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
        week: clean(body.week, 160),
        formula: clean(body.formula, 120),
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
        `Semaine souhaitée : ${data.week}`,
        `Formule : ${data.formula}`,
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

      return json({ ok: true });
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
