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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

      // Champ anti-spam invisible : s'il est rempli, on ignore silencieusement.
      if (clean(body.website, 200)) {
        return json({ ok: true });
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
          { ok: false, error: "Merci de compléter tous les champs obligatoires." },
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
          { ok: false, error: "Le service de réservation n’est pas encore configuré." },
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
