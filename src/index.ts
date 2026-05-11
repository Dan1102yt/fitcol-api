// =====================================================
// Fitcol API Proxy — Cloudflare Worker
// Proxy seguro entre dan1102yt.github.io/Fitcol y la API de Anthropic.
// La API key vive solo en secrets del Worker; el cliente nunca la ve.
// =====================================================

interface Env {
  ANTHROPIC_API_KEY: string;
  RATE_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

interface RequestBody {
  message?: unknown;
  image?: unknown;
  contexto_usuario?: unknown;
}

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type AnthropicUserContent = string | Array<AnthropicTextBlock | AnthropicImageBlock>;

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  stream: boolean;
  system: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
  }>;
  messages: Array<{ role: "user" | "assistant"; content: AnthropicUserContent }>;
}

// -----------------------------------------------------
// Constantes
// -----------------------------------------------------
const ALLOWED_ORIGIN = "https://dan1102yt.github.io";
const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 1000;
const MAX_MESSAGE_CHARS = 4000;
const MAX_IMAGE_CHARS = 6_700_000;
const MAX_CONTEXT_CHARS = 20_000;

const SYSTEM_PROMPT = `Eres el asistente de Fitcol, una app de fitness para usuarios colombianos.
Ayudas con nutrición, ejercicio y análisis de alimentos.
Responde siempre en español, de forma concisa y motivadora.
Cuando analices imágenes de comida, identifica los alimentos, estima calorías
aproximadas y da recomendaciones nutricionales simples.`;

// -----------------------------------------------------
// Helpers de respuesta
// -----------------------------------------------------
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" }
  });
}

// -----------------------------------------------------
// Worker entrypoint
// -----------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // CAPA 1: Validación de origen (CORS)
      const origin = request.headers.get("Origin");

      if (request.method === "OPTIONS") {
        if (origin !== ALLOWED_ORIGIN) {
          return jsonResponse({ error: "Forbidden" }, 403);
        }
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      if (origin !== ALLOWED_ORIGIN) {
        return jsonResponse({ error: "Forbidden" }, 403);
      }

      // Solo POST /chat
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/chat") {
        return jsonResponse({ error: "Not Found" }, 404);
      }

      // CAPA 2: Rate limiting por IP
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return jsonResponse(
          { error: "Demasiadas peticiones. Espera unos segundos." },
          429
        );
      }

      // CAPA 3: Validación del body
      let body: RequestBody;
      try {
        body = (await request.json()) as RequestBody;
      } catch {
        return jsonResponse({ error: "JSON inválido en el body." }, 400);
      }

      if (typeof body.message !== "string") {
        return jsonResponse(
          { error: "El campo 'message' es requerido y debe ser string." },
          400
        );
      }
      if (body.message.length === 0) {
        return jsonResponse({ error: "El campo 'message' no puede estar vacío." }, 400);
      }
      if (body.message.length > MAX_MESSAGE_CHARS) {
        return jsonResponse(
          { error: `El mensaje supera el límite de ${MAX_MESSAGE_CHARS} caracteres.` },
          400
        );
      }

      let contextBlock: string | null = null;
      if (body.contexto_usuario !== undefined && body.contexto_usuario !== null && body.contexto_usuario !== "") {
        let serialized: string;
        try {
          serialized = typeof body.contexto_usuario === "string"
            ? body.contexto_usuario
            : JSON.stringify(body.contexto_usuario);
        } catch {
          return jsonResponse({ error: "contexto_usuario no serializable." }, 400);
        }
        if (serialized.length > MAX_CONTEXT_CHARS) {
          return jsonResponse({ error: `contexto_usuario supera ${MAX_CONTEXT_CHARS} caracteres.` }, 400);
        }
        contextBlock = serialized;
      }

      let imageDataUrl: string | null = null;
      if (body.image !== undefined && body.image !== null && body.image !== "") {
        if (typeof body.image !== "string") {
          return jsonResponse(
            { error: "El campo 'image' debe ser un string base64 (data URL)." },
            400
          );
        }
        if (!body.image.startsWith("data:image/")) {
          return jsonResponse(
            { error: "La imagen debe ser un data URL que empiece con 'data:image/'." },
            400
          );
        }
        if (body.image.length > MAX_IMAGE_CHARS) {
          return jsonResponse(
            { error: "La imagen supera el tamaño máximo (~5MB)." },
            400
          );
        }
        imageDataUrl = body.image;
      }

      // CAPA 4: Construcción del request a Anthropic
      const userMessage: string = body.message;
      let userContent: AnthropicUserContent;

      if (imageDataUrl !== null) {
        const match = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (match === null) {
          return jsonResponse({ error: "Formato de imagen inválido." }, 400);
        }
        const mediaType: string = match[1];
        const base64: string = match[2];
        userContent = [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 }
          },
          { type: "text", text: userMessage }
        ];
      } else {
        userContent = userMessage;
      }

      // Construir el system prompt: base + (opcional) contexto del usuario
      const systemBlocks: AnthropicRequestBody["system"] = [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
      ];
      if (contextBlock !== null) {
        systemBlocks.push({
          type: "text",
          text: `Contexto del usuario:\n\n${contextBlock}\n\nUsa este contexto para personalizar tus respuestas con números reales (peso máximo, evolución, etc.). Si el usuario pregunta sobre un ejercicio o métrica que no aparece en el contexto, dilo claramente.`
        });
      }

      const anthropicBody: AnthropicRequestBody = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        system: systemBlocks,
        messages: [{ role: "user", content: userContent }]
      };

      const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(anthropicBody)
      });

      if (anthropicResp.status !== 200) {
        const errBody = await anthropicResp.text();
        console.error("Anthropic error:", anthropicResp.status, errBody);
        return jsonResponse(
          { error: "Error del servicio de IA. Intenta de nuevo." },
          502
        );
      }

      // CAPA 5: Streaming de respuesta (SSE)
      return new Response(anthropicResp.body, {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    } catch (err) {
      // CAPA 6: Manejo global de errores
      console.error("Unexpected error:", err);
      return jsonResponse({ error: "Error interno del servidor." }, 500);
    }
  }
};
