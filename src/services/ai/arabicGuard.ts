import { generateJson, type AiPart, type StructuredOptions } from "./gemini";
import { payloadArabicRatio } from "./validate";

/**
 * Arabic-output guard.
 *
 * The product is Arabic-only, so an English leak is not a cosmetic problem: it
 * breaks the RTL layout and is a strong hint that the model ignored the task
 * (usually because it did not understand the source pages). Rather than fail the
 * request, retry once with the constraint restated at the very end of the
 * prompt, where it has the most weight.
 */

/** Share of collected strings that must read as Arabic. */
export const ARABIC_PAYLOAD_FLOOR = 0.7;

export const ARABIC_STRICT_NOTICE = `

=== تنبيه إلزامي أخير ===
كل حقل نصي في ردّك يجب أن يكون بالعربية الفصحى. الردّ الذي يحتوي كلمات إنجليزية
سيُرفض ويُعاد توليده. أعد كتابة كل نص من إنجليزي إلى عربي مع الحفاظ على المعنى
الدقيق للمصطلح، ثم تحقق مرة أخرى أن كل حقل نصي عربي بالكامل.`;

export async function generateArabicJson<T>(
  parts: AiPart[],
  opts: StructuredOptions,
  /** Used only for the log line. */
  label: string
): Promise<T> {
  const first = await generateJson<T>(parts, opts);
  if (payloadArabicRatio(first) >= ARABIC_PAYLOAD_FLOOR) return first;

  console.warn(
    `[ai] ${label} came back at ${(payloadArabicRatio(first) * 100).toFixed(
      0
    )}% Arabic; retrying with a stricter instruction`
  );
  return generateJson<T>([...parts, { text: ARABIC_STRICT_NOTICE }], opts);
}
