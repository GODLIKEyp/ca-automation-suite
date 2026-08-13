import { GoogleGenAI } from "@google/genai";

/**
 * Lazily-resolved singleton GoogleGenAI client.
 * Throws if GEMINI_API_KEY is missing.
 */
let cachedClient: GoogleGenAI | null = null;

export function getGenaiClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY env var is not set. Add it to .env (see .env.example)."
    );
  }
  cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

/**
 * Resolve an image-like payload (URL or base64) into the {data, mimeType}
 * shape that the @google/genai `inlineData` part expects.
 */
export async function resolveImagePart(input: {
  imageUrl?: string;
  base64Data?: string;
  filename?: string;
  fallbackMimeType?: string;
}): Promise<{ data: string; mimeType: string }> {
  if (input.base64Data) {
    const mimeMatch = input.base64Data.match(/^data:([^;]+);base64,/);
    const stripped = input.base64Data.replace(/^data:[^;]+;base64,/, "");
    return {
      data: stripped,
      mimeType: mimeMatch ? mimeMatch[1] : input.fallbackMimeType ?? "image/png",
    };
  }
  if (!input.imageUrl) {
    throw new Error("resolveImagePart: either imageUrl or base64Data is required.");
  }
  const res = await fetch(input.imageUrl);
  if (!res.ok) {
    throw new Error(
      `resolveImagePart: failed to fetch imageUrl (${res.status} ${res.statusText})`
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType =
    res.headers.get("content-type") ?? input.fallbackMimeType ?? "image/jpeg";
  return { data: buffer.toString("base64"), mimeType };
}

/**
 * Best-effort string extraction from a Gemini response.
 * Handles SDK shape variations across minor versions.
 */
export function extractResponseText(response: any): string {
  if (!response) return "";
  if (typeof response.text === "string") return response.text;
  const parts = response.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map((p: any) => p.text ?? "").join("");
  }
  return "";
}
