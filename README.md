# fitcol-api

Cloudflare Worker que actúa como proxy seguro entre [Fitcol](https://dan1102yt.github.io/Fitcol/) y la API de Anthropic.
La API key vive solo en los secrets del Worker; el frontend nunca la ve.

## Capas de seguridad

1. **CORS** — solo acepta peticiones con `Origin: https://dan1102yt.github.io`. Cualquier otro origen recibe `403`.
2. **Rate limiting** — 5 peticiones cada 10 segundos por IP (`CF-Connecting-IP`). Exceso → `429`.
3. **Validación de body** — `message` requerido, máximo 4000 caracteres. `image` opcional, debe ser data URL `data:image/*;base64,...` de máximo ~5MB.
4. **Llamada a Anthropic** — modelo `claude-haiku-4-5`, `max_tokens` 1000, system prompt con `cache_control: ephemeral` para prompt caching.
5. **Streaming SSE** — respuesta `text/event-stream` reenviada directo al cliente.
6. **Manejo global de errores** — cualquier excepción no atrapada devuelve `500` con CORS válido.

## Estructura

```
fitcol-api/
├── src/
│   └── index.ts        # Worker (TypeScript estricto)
├── wrangler.toml       # Config + binding de rate limiting
├── package.json
├── tsconfig.json
├── .dev.vars           # Solo dev local (gitignored)
├── .gitignore
└── README.md
```

## Despliegue paso a paso

### Requisitos
- Cuenta Cloudflare gratuita ([signup](https://dash.cloudflare.com/sign-up))
- Node.js 18+ instalado
- API key de Anthropic (`sk-ant-...`) de [console.anthropic.com](https://console.anthropic.com/)

### 1. Instalar Wrangler

```bash
npm install -g wrangler
```

### 2. Autenticarse contra Cloudflare

```bash
wrangler login
```

Abre el navegador para autorización OAuth.

### 3. Guardar la API key como secret (producción)

```bash
cd fitcol-api
wrangler secret put ANTHROPIC_API_KEY
```

Pega tu key `sk-ant-...` cuando lo pida. Solo Wrangler la verá; queda cifrada en Cloudflare.

### 4. Desplegar

```bash
wrangler deploy
```

Salida esperada:
```
Uploaded fitcol-api (X sec)
Published fitcol-api (X sec)
  https://fitcol-api.TU_USUARIO.workers.dev
```

Esa URL es tu endpoint público. Anótala — la necesitas en el frontend.

### 5. Probar localmente (opcional)

```bash
# Edita .dev.vars y pon tu key real
wrangler dev
```

Worker corre en `http://localhost:8787`. Como tu Origin local no es `https://dan1102yt.github.io`, vas a recibir `403` salvo que pruebes desde la app deployada o ajustes temporalmente `ALLOWED_ORIGIN` en `src/index.ts`.

## Cambios en el frontend (Fitcol)

En el código JavaScript del frontend hay que:

### 1. Reemplazar el endpoint

Antes:
```js
fetch("https://api.anthropic.com/v1/messages", {
  headers: { "x-api-key": apiKey, ... },
  body: JSON.stringify({ model: "...", messages: [...] })
});
```

Después:
```js
fetch("https://fitcol-api.TU_USUARIO.workers.dev/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "texto del usuario", image: "data:image/jpeg;base64,..." })
});
```

- `image` es opcional. Si no la mandas, omite el campo.
- Ya **no hace falta** la API key del usuario en el frontend.

### 2. Manejar la respuesta como stream SSE

El Worker reenvía el stream tal cual viene de Anthropic. Cada chunk SSE tiene el formato:

```
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"trozo "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"de texto"}}

event: message_stop
data: {"type":"message_stop"}
```

Snippet de cliente para consumirlo:

```js
async function streamChat(message, image, onChunk) {
  const res = await fetch("https://fitcol-api.TU_USUARIO.workers.dev/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, ...(image ? { image } : {}) })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Error desconocido" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE delimitado por líneas en blanco
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const block of parts) {
      // Cada bloque puede tener varias líneas "event:" y "data:"
      const dataLine = block.split("\n").find(l => l.startsWith("data: "));
      if (!dataLine) continue;
      const json = dataLine.slice(6).trim();
      if (!json || json === "[DONE]") continue;

      try {
        const parsed = JSON.parse(json);
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
          onChunk(parsed.delta.text);
        }
      } catch {
        // ignorar JSON parcial
      }
    }
  }
}

// Uso:
let fullText = "";
await streamChat("¿Cuántas calorías tiene una arepa con huevo?", null, chunk => {
  fullText += chunk;
  document.getElementById("output").textContent = fullText;
});
```

### 3. Eliminar el campo API key del perfil

Como el cliente ya no la necesita, puedes quitar del frontend:
- El input de API key en Perfil
- La validación `hasApiKey()` y el aviso de "configura tu API key"
- El estado `state.apiKey`

## Costos

- Cloudflare Workers Free: 100 000 requests/día. Sobra para uso personal.
- Anthropic Haiku 4.5: ~$1/M tokens input, ~$5/M tokens output. Una conversación normal cuesta fracciones de centavo. El prompt caching reduce el costo de reenviar el system prompt en cada turno.

## Mantenimiento

- **Cambiar API key**: `wrangler secret put ANTHROPIC_API_KEY`
- **Ver logs en vivo**: `wrangler tail`
- **Borrar el Worker**: `wrangler delete`
- **Cambiar dominio permitido**: edita `ALLOWED_ORIGIN` en `src/index.ts` y redeploy
