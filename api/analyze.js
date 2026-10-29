/**
 * BhojAI meal photo analyzer.
 * Vercel: default export. This app's server route calls handleAnalyze().
 * The key is read only on the server — never send it to the browser.
 */

const GEMINI_MODEL = "gemini-3.8-flash";
const GROK_MODEL = "grok-4.7";
const MAX_IMAGE_CHARS = 1_800_000;

const SYSTEM = `You are an expert in Bangladeshi food and portion sizes (bati, plate, piece, chamoch). Identify every food in the photo and estimate portion and nutrition. Return ONLY valid JSON.

Use exactly this shape:
{"items":[{"name_bn":"","name_en":"","portion":"","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0}],"total_calories":0,"confidence":"low|medium|high"}

Rules:
- name_bn is Bengali script. name_en is English.
- portion is Bengali and uses bati, plate, piece, or chamoch when they fit, for example "১ বাটি", "২ পিস", "১ চামচ".
- calories is kcal for that portion. protein_g, carbs_g, and fat_g are grams.
- total_calories equals the sum of item calories.
- confidence is only low, medium, or high.
- If the photo is not food, or food cannot be identified, return ONLY {"error":"ছবিতে খাবার দেখা যাচ্ছে না। একটি খাবারের ছবি তুলুন।"}
- When a schema requires every field, use that same error string, an empty items array, total_calories 0, and confidence "low". When the photo is food, set error to null.
- No markdown and no prose.`;

const USER_TEXT =
  "Look at this meal photo. List every food you can see, with a Bangladeshi portion and nutrition. If it is not food, use the error field.";

const NOT_FOOD = "ছবিতে খাবার দেখা যাচ্ছে না। একটি খাবারের ছবি তুলুন।";
const TRY_AGAIN = "এখন বিশ্লেষণ করা যায়নি। একটু পরে আবার চেষ্টা করুন।";
const BAD_IMAGE = "ছবিটা ঠিকমতো পৌঁছায়নি। আবার চেষ্টা করুন।";
const TOO_BIG = "ছবিটা একটু বড় হয়ে গেছে। আরেকটু দূরে সরে তুলুন।";
const UNAVAILABLE = "বিশ্লেষণের সেবা এখন পাওয়া যাচ্ছে না। একটু পরে চেষ্টা করুন।";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export class AnalyzeError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.name = "AnalyzeError";
    /** @type {number} */
    this.status = status;
    /** @type {string} */
    this.publicMessage = message;
  }
}

/**
 * @param {unknown} body
 * @param {number} status
 * @returns {Response}
 */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * @param {string} url
 * @param {RequestInit} options
 * @returns {Promise<any>}
 */
async function postJson(url, options) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(28_000),
    });
    if (response.ok) return response.json();
    lastStatus = response.status;
    const detail = (await response.text()).slice(0, 280);
    console.error("[bhojai] upstream", response.status, detail);
    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    break;
  }
  throw new AnalyzeError(lastStatus === 429 ? "একটু ধীরে। কিছুক্ষণ পর আবার চেষ্টা করুন।" : TRY_AGAIN, 502);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const digits = "০১২৩৪৫৬৭৮৯";
  const ascii = String(value ?? "").replace(/[০-৯]/g, (digit) => String(digits.indexOf(digit)));
  const parsed = Number(ascii.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {number} value
 * @param {number} max
 */
function clamp(value, max) {
  return Math.min(max, Math.max(0, value));
}

/**
 * @param {string} text
 */
function parseModelJson(text) {
  let source = text.trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) source = fenced[1].trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AnalyzeError(TRY_AGAIN, 502);
  source = source.slice(start, end + 1);
  try {
    return JSON.parse(source);
  } catch {
    return JSON.parse(source.replace(/,\s*([}\]])/g, "$1"));
  }
}

/**
 * @typedef {{
 *   name_bn?: unknown,
 *   name_en?: unknown,
 *   name?: unknown,
 *   portion?: unknown,
 *   calories?: unknown,
 *   kcal?: unknown,
 *   protein_g?: unknown,
 *   protein?: unknown,
 *   carbs_g?: unknown,
 *   carbs?: unknown,
 *   fat_g?: unknown,
 *   fat?: unknown,
 * }} RawItem
 */

/**
 * @param {any} data
 */
function normalizeResult(data) {
  if (!data || typeof data !== "object") throw new AnalyzeError(TRY_AGAIN, 502);
  if (typeof data.error === "string" && data.error.trim()) {
    const message = data.error.trim().slice(0, 180);
    throw new AnalyzeError(/[\u0980-\u09FF]/.test(message) ? message : NOT_FOOD, 422);
  }
  if (!Array.isArray(data.items)) throw new AnalyzeError(NOT_FOOD, 422);

  const items = /** @type {unknown[]} */ (data.items)
    .filter((item) => item && typeof item === "object")
    .slice(0, 8)
    .map((item) => {
      const row = /** @type {RawItem} */ (item);
      const calories = Math.round(clamp(toNumber(row.calories ?? row.kcal), 5000));
      return {
        name_bn: String(row.name_bn || row.name || "খাবার").trim().slice(0, 80) || "খাবার",
        name_en: String(row.name_en || row.name || "Food").trim().slice(0, 80) || "Food",
        portion: String(row.portion || "১ পরিবেশন").trim().slice(0, 80) || "১ পরিবেশন",
        calories,
        protein_g: Math.round(clamp(toNumber(row.protein_g ?? row.protein), 400) * 10) / 10,
        carbs_g: Math.round(clamp(toNumber(row.carbs_g ?? row.carbs), 400) * 10) / 10,
        fat_g: Math.round(clamp(toNumber(row.fat_g ?? row.fat), 400) * 10) / 10,
      };
    });

  if (items.length === 0) throw new AnalyzeError(NOT_FOOD, 422);
  const confidence = ["low", "medium", "high"].includes(data.confidence)
    ? data.confidence
    : "medium";
  return {
    items,
    total_calories: items.reduce((sum, item) => sum + item.calories, 0),
    confidence,
  };
}

/**
 * @param {string} mimeType
 * @param {string} base64
 */
async function callGemini(mimeType, base64) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AnalyzeError(UNAVAILABLE, 503);
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [
          {
            role: "user",
            parts: [
              { text: USER_TEXT },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
    },
  );
  const parts = /** @type {Array<{ thought?: boolean, text?: unknown }>} */ (
    data?.candidates?.[0]?.content?.parts ?? []
  );
  const text = parts
    .filter((part) => part && !part.thought && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim();
  if (!text) throw new AnalyzeError(NOT_FOOD, 422);
  return text;
}

const FOOD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    error: { type: ["string", "null"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name_bn: { type: "string" },
          name_en: { type: "string" },
          portion: { type: "string" },
          calories: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
        },
        required: ["name_bn", "name_en", "portion", "calories", "protein_g", "carbs_g", "fat_g"],
      },
    },
    total_calories: { type: "number" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["error", "items", "total_calories", "confidence"],
};

/**
 * @param {any} data
 * @returns {string}
 */
function responseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  const output = Array.isArray(data?.output) ? data.output : [];
  /** @type {string[]} */
  const chunks = [];
  for (const item of output) {
    const content = item && typeof item === "object" ? item.content : null;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

/**
 * @param {string} mimeType
 * @param {string} base64
 */
async function callGrok(mimeType, base64) {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new AnalyzeError(UNAVAILABLE, 503);
  const data = await postJson("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      instructions: SYSTEM,
      max_output_tokens: 1200,
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "bhojai_meal",
          strict: true,
          schema: FOOD_SCHEMA,
        },
      },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: USER_TEXT },
            {
              type: "input_image",
              image_url: `data:\( {mimeType};base64, \){base64}`,
            },
          ],
        },
      ],
    }),
  });
  const text = responseText(data);
  if (!text) throw new AnalyzeError(TRY_AGAIN, 502);
  return text;
}

/**
 * @param {unknown} body
 */
export async function analyzeFoodPhoto(body) {
  const record = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
  const mimeType = typeof record.mimeType === "string" ? record.mimeType.toLowerCase() : "";
  if (!ALLOWED_MIME.has(mimeType)) throw new AnalyzeError(BAD_IMAGE, 400);

  let image = typeof record.image === "string" ? record.image.trim() : "";
  const comma = image.indexOf(",");
  if (image.startsWith("data:") && comma !== -1) image = image.slice(comma + 1);
  image = image.replace(/\s/g, "");
  if (image.length < 80) throw new AnalyzeError(BAD_IMAGE, 400);
  if (image.length > MAX_IMAGE_CHARS) throw new AnalyzeError(TOO_BIG, 413);

  const text = process.env.GEMINI_API_KEY
    ? await callGemini(mimeType, image)
    : await callGrok(mimeType, image);

  try {
    return normalizeResult(parseModelJson(text));
  } catch (error) {
    if (error instanceof AnalyzeError) throw error;
    throw new AnalyzeError(TRY_AGAIN, 502);
  }
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleAnalyze(request) {
  if (request.method !== "POST") {
    return json({ error: "এই ঠিকানায় শুধু ছবি পাঠানো যায়।" }, 405);
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 2_000_000) return json({ error: TOO_BIG }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: BAD_IMAGE }, 400);
  }

  try {
    return json(await analyzeFoodPhoto(body), 200);
  } catch (error) {
    const status = error instanceof AnalyzeError ? error.status : 500;
    const message = error instanceof AnalyzeError ? error.publicMessage : TRY_AGAIN;
    if (!(error instanceof AnalyzeError)) console.error("[bhojai]", error);
    return json({ error: message }, status);
  }
}

/**
 * Vercel Node.js serverless entry. Same behavior as handleAnalyze.
 * @param {import("node:http").IncomingMessage & { body?: unknown }} req
 * @param {import("node:http").ServerResponse & { status?: (code: number) => { json: (body: unknown) => void } }} res
 */
export default async function handler(req, res) {
  /**
   * @param {number} status
   * @param {unknown} body
   */
  const send = (status, body) => {
    if (typeof res.status === "function") {
      res.status(status).json(body);
      return;
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };

  if (req.method !== "POST") {
    send(405, { error: "এই ঠিকানায় শুধু ছবি পাঠানো যায়।" });
    return;
  }

  try {
    const body = await readNodeJson(req);
    send(200, await analyzeFoodPhoto(body));
  } catch (error) {
    const status = error instanceof AnalyzeError ? error.status : error instanceof SyntaxError ? 400 : 500;
    const message =
      error instanceof AnalyzeError ? error.publicMessage : error instanceof SyntaxError ? BAD_IMAGE : TRY_AGAIN;
    if (!(error instanceof AnalyzeError) && !(error instanceof SyntaxError)) console.error("[bhojai]", error);
    send(status, { error: message });
  }
}

/**
 * @param {import("node:http").IncomingMessage & { body?: unknown }} req
 * @returns {Promise<unknown>}
 */
function readNodeJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === "string") return Promise.resolve(JSON.parse(req.body || "{}"));
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
