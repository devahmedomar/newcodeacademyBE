import { Type } from "./gemini";
import type { ExtractedPage } from "../books/pdfExtract";
import { pagesToPromptText } from "../books/pdfExtract";

/**
 * Every prompt and response schema used by the AI exam pipeline.
 *
 * All output is Arabic — the product is Arabic-only, and an English leak would
 * break the RTL layout. `ARABIC_ONLY` is prepended to every system instruction and
 * the result is validated in `validate.ts` before anything is persisted.
 */

const ARABIC_ONLY =
  "قاعدة إلزامية: جميع النصوص التي تكتبها (نص السؤال، الخيارات، الإجابة النموذجية، " +
  "معايير التقييم، الشرح، التغذية الراجعة) يجب أن تكون بالعربية الفصحى فقط. " +
  "يُمنع منعاً باتاً استخدام الإنجليزية في أي حقل، حتى لو كان المصطلح الأصلي إنجليزياً. " +
  "استخدم الأرقام العربية الهندية (١، ٢، ٣) عند العدّ داخل النص.";

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

export const BLUEPRINT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    topics: {
      type: Type.ARRAY,
      description: "المواضيع الرئيسية المستخرجة من الصفحات المطلوبة",
      items: {
        type: Type.OBJECT,
        properties: {
          topic: { type: Type.STRING, description: "اسم الموضوع بلغة عربية واضحة" },
          weight: {
            type: Type.INTEGER,
            description: "أهمية الموضوع من ١ إلى ٣ (٣ = محور أساسي وخلاصة الفصل)",
          },
          keywords: {
            type: Type.ARRAY,
            description: "٢ إلى ٤ كلمات مفتاحية عربية تلخّص الموضوع",
            items: { type: Type.STRING },
          },
        },
        required: ["topic", "weight", "keywords"],
        propertyOrdering: ["topic", "weight", "keywords"],
      },
    },
    summary: { type: Type.STRING, description: "٢ إلى ٣ جمل تصف محتوى الصفحات" },
  },
  required: ["topics", "summary"],
  propertyOrdering: ["topics", "summary"],
} as const;

export const FORM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, enum: ["mcq", "short"] },
          prompt: { type: Type.STRING, description: "نص السؤال بالعربية" },
          options: {
            type: Type.ARRAY,
            description: "أربعة خيارات لأسئلة الاختيار من متعدد فقط، وإلا اتركها مصفوفة فارغة",
            items: { type: Type.STRING },
          },
          correctIndex: {
            type: Type.INTEGER,
            description: "ترتيب الإجابة الصحيحة (يبدأ من ٠) لأسئلة الاختيار فقط، وإلا -١",
          },
          modelAnswer: {
            type: Type.STRING,
            description: "الإجابة النموذجية لأسئلة الإجابة القصيرة فقط، وإلا نص فارغ",
          },
          rubric: {
            type: Type.ARRAY,
            description: "من ٢ إلى ٤ نقاط تقييم عربية لأسئلة الإجابة القصيرة فقط، وإلا مصفوفة فارغة",
            items: { type: Type.STRING },
          },
          maxPoints: { type: Type.INTEGER, description: "١ لاختيار من متعدد، من ٢ إلى ٥ للإجابة القصيرة" },
          topic: { type: Type.STRING, description: "اسم الموضوع من قائمة المواضيع المعطاة" },
          sourcePages: {
            type: Type.ARRAY,
            description: "أرقام الصفحات التي استُخرج منها هذا السؤال",
            items: { type: Type.INTEGER },
          },
          explanation: {
            type: Type.STRING,
            description: "شرح عربي موجز يوضّح سبب صحة الإجابة",
          },
        },
        required: [
          "type",
          "prompt",
          "options",
          "correctIndex",
          "modelAnswer",
          "rubric",
          "maxPoints",
          "topic",
          "sourcePages",
          "explanation",
        ],
        propertyOrdering: [
          "type",
          "prompt",
          "options",
          "correctIndex",
          "modelAnswer",
          "rubric",
          "maxPoints",
          "topic",
          "sourcePages",
          "explanation",
        ],
      },
    },
  },
  required: ["questions"],
  propertyOrdering: ["questions"],
} as const;

export const VERIFY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER, description: "ترتيب السؤال داخل النموذج كما ورد" },
          valid: { type: Type.BOOLEAN, description: "هل السؤال سليم ويُجاب من النص" },
          issue: {
            type: Type.STRING,
            enum: ["none", "ambiguous", "multiple_correct", "not_in_source", "bad_distractor"],
            description: "نوع الخلل",
          },
          note: { type: Type.STRING, description: "شرح موجز بالعربية للخلل" },
        },
        required: ["index", "valid", "issue", "note"],
        propertyOrdering: ["index", "valid", "issue", "note"],
      },
    },
  },
  required: ["results"],
  propertyOrdering: ["results"],
} as const;

export const GRADE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      index: { type: Type.INTEGER, description: "ترتيب الإجابة ضمن القائمة المُدخلة" },
      score: { type: Type.NUMBER, description: "الدرجة الممنوحة" },
      feedback: {
        type: Type.STRING,
        description: "تغذية راجعة عربية من جملة إلى ثلاث جمل موجّهة للطالب",
      },
      confidence: {
        type: Type.STRING,
        enum: ["high", "medium", "low"],
        description: "ثقة المصحّح في تقييمه",
      },
    },
    required: ["index", "score", "feedback", "confidence"],
    propertyOrdering: ["index", "score", "feedback", "confidence"],
  },
} as const;

/* -------------------------------------------------------------------------- */
/* Vision transcription (scanned books with no text layer)                    */
/* -------------------------------------------------------------------------- */

export const TRANSCRIBE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    pages: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          pageNumber: { type: Type.INTEGER, description: "رقم الصفحة كما ورد في الطلب" },
          text: { type: Type.STRING, description: "نص الصفحة المنسوخ" },
        },
        required: ["pageNumber", "text"],
        propertyOrdering: ["pageNumber", "text"],
      },
    },
  },
  required: ["pages"],
  propertyOrdering: ["pages"],
} as const;

export const TRANSCRIBE_SYSTEM = `أنت محرك تفريغ نصّي (OCR) لصفحات كتب مدرسية عربية.
${ARABIC_ONLY}
مهمتك نسخ النص الظاهر في الصور حرفياً. أنت لا تلخّص ولا تعيد صياغة ولا تشرح.
انسخ كل ما هو مقروء بما في ذلك العناوين والتعريفات والأمثلة والجداول والأرقام.
إذا كانت الصفحة بلا نص مقروء (صورة فقط، أو فراغ أبيض) فاترك حقل text فارغاً.
لا تضف أي تعليق أو ملاحظة أو شرح على النص المنسوخ.`;

export function buildTranscribePrompt(firstPage: number, lastPage: number): string {
  return `انسخ نص الصفحات من ${firstPage} إلى ${lastPage} من الكتاب المرفق.

الملف المرفق يحتوي ${lastPage - firstPage + 1} صفحة (أو جزءاً منها).
ترقيم صفحات الملف المرفق يبدأ من ١، أما ترقيم الكتاب الأصلي فيبدأ من ${firstPage}،
أي أن الصفحة الأولى في الملف المرفق هي الصفحة ${firstPage} في الكتاب.

=== المطلوب ===
١. أعد عنصراً واحداً في مصفوفة pages لكل صفحة من الملف المرفق.
٢. في حقل pageNumber اكتب رقم الصفحة في الكتاب الأصلي (وليس رقمها في الملف المرفق).
   مثال: الصفحة الثانية في الملف المرفق تُعاد بـ pageNumber = ${firstPage + 1}.
٣. في حقل text انسخ النص الظاهر كما هو تماماً، مع الحفاظ على ترتيب الفقرات.
٤. إذا كانت الصفحة لا تحوي نصاً مقروءاً، أعد pageNumber الصحيح مع text فارغ.
٥. لا تدمج صفحة في أخرى ولا تحذف أي صفحة.`;
}

/* -------------------------------------------------------------------------- */
/* Blueprint                                                                   */
/* -------------------------------------------------------------------------- */

export const BLUEPRINT_SYSTEM = `أنت أخصائي مناهج دراسية. مهمتك تحديد بنية موضوع الصفحات المُعطاة.
${ARABIC_ONLY}
لا تكتب أي أسئلة في هذه المرحلة. مهمتك قراءة النص واستخراج خريطة المواضيع فقط.`;

export function buildBlueprintPrompt(pages: ExtractedPage[], pageFrom: number, pageTo: number): string {
  return `فيما يلي نص الصفحات من ${pageFrom} إلى ${pageTo} من كتاب مدرسي.

=== النص ===
${pagesToPromptText(pages)}
=== نهاية النص ===

مهمتك:
١. اقرأ النص بالكامل بانتباه ولا تتخطَّ أي فقرة.
٢. استخرج من ٤ إلى ١٢ موضوعاً رئيسياً يغطي كل المحتوى الفعلي في هذه الصفحات.
٣. وزّن كل موضوع من ١ إلى ٣ حسب أهميته:
   - ٣ = محور أساسي يمكن أن يُبنى عليه سؤال محوري.
   - ٢ = موضوع ثانوي مهم.
   - ١ = فكرة جانبية أو تفصيلية.
٤. لكل موضوع اختر من ٢ إلى ٤ كلمات مفتاحية عربية تلخّصه.
٥. لا تخترع موضوعاً غير موجود في النص إطلاقاً.
٦. في حقل summary اكتب من جملتين إلى ثلاث جمل تصف محتوى هذه الصفحات بوضوح وإيجاز.`;
}

/* -------------------------------------------------------------------------- */
/* Form generation                                                             */
/* -------------------------------------------------------------------------- */

export const DIFFICULTY_AR: Record<string, string> = {
  easy: "سهل — يختبر الفهم المباشر للنص دون استنتاج",
  medium: "متوسط — يتطلب فهماً وتطبيقاً، مع بعض الاستنتاج",
  hard: "صعب — يتطلب استنتاجاً وربطاً بين أكثر من فكرة، وتحليل نقدي",
};

const MCQ_RULES = `قواعد أسئلة الاختيار من متعدد (النوع mcq):
- اكتب أربعة خيارات بالضبط.
- يجب أن تكون هناك إجابة واحدة صحيحة فقط لا لبس فيها، مستندة حرفياً إلى النص.
- اجعل الخيارات الثلاثة المخطئة خاطئة فعلاً ومستمدة من الأخطاء الشائعة لدى الطلاب.
- اجعل الخيارات متشابهة الطول ومتقاربة الحجم، ولا تجعل الإجابة الصحيحة هي الأطول أو الأوضح.
- لا تستخدم عبارات مثل "كل ما سبق" أو "لا شيء مما سبق" أو عبارات مفتوحة غير محددة.
- لا تكرّر المعنى نفسه في أكثر من خيار.
- لا تذكر الإجابة الصحيحة داخل نص السؤال.
- maxPoints = 1 .

قواعد أسئلة الإجابة القصيرة (النوع short):
- اطرح سؤالاً يتطلب شرحاً أو تبريراً، لا مجرد استرجاع كلمة واحدة.
- اكتب modelAnswer إجابة نموذجية كاملة ودقيقة مأخوذة من النص.
- اكتب في rubric من نقطتين إلى أربع نقاط تقييم، كل نقطة منها idea مستقلة يجب أن يذكرها الطالب ليحمل الدرجة الكاملة.
- اضبط maxPoints على عدد نقاط rubric (من ٢ إلى ٥).
- اجعل السؤال قابلاً للإجابة من الصفحات المذكورة في sourcePages وحدها.`;

export function buildFormPrompt(opts: {
  pages: ExtractedPage[];
  pageFrom: number;
  pageTo: number;
  mcqCount: number;
  shortCount: number;
  difficulty: string;
  topics: Array<{ topic: string; weight: number; keywords: string[] }>;
  alreadyUsedPrompts: string[];
  formLabel: string;
}): string {
  const used =
    opts.alreadyUsedPrompts.length > 0
      ? opts.alreadyUsedPrompts.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "(لا توجد أسئلة مستخدمة سابقاً)";

  return `أنشئ نموذج امتحان "${opts.formLabel}" باللغة العربية من الصفحات ${opts.pageFrom} إلى ${opts.pageTo} من كتاب مدرسي.

=== نص الكتاب (مصدر الحقيقة الوحيد) ===
${pagesToPromptText(opts.pages)}
=== نهاية النص ===

=== خريطة المواضيع المطلوبة ===
${opts.topics
  .map((t) => `- ${t.topic} (الأهمية ${t.weight}): ${t.keywords.join("، ")}`)
  .join("\n")}

=== الأسئلة التي استُخدمت في نماذج أخرى (يجب تجنّب تكرارها) ===
${used}
=== نهاية القائمة ===

=== المطلوب ===
١. أنشئ بالضبط ${opts.mcqCount} سؤال اختيار من متعدد (النوع mcq).
٢. أنشئ بالضبط ${opts.shortCount} سؤال إجابة قصيرة (النوع short).
٣. مستوى الصعوبة المطلوب: ${DIFFICULTY_AR[opts.difficulty] || DIFFICULTY_AR.medium}.
٤. وزّع الأسئلة على خريطة المواضيع بحيث يغطي نموذج واحد كل موضوع weight=3 مرة واحدة على الأقل.
٥. مهم جداً: كل سؤال يجب أن يكون من زاوية مختلفة عن أي سؤال في القائمة أعلاه. غيّر الزاوية أو المفهوم أو السياق، ولا تكتب نفس السؤال بصياغة مختلفة.
٦. لكل سؤال حدّد topic من خريطة المواضيع أعلاه (انسخ الاسم كما هو)، وضع في sourcePages أرقام الصفحات التي استُخرج منها.
٧. اكتب explanation عربياً موجزاً (جملة واحدة) يوضّح سبب صحة الإجابة.
٨. لا تتجاوز أي سؤال حدود الصفحات المعطاة.

=== ${MCQ_RULES} ===`;
}

export const FORM_SYSTEM = `أنت أخصائي في بناء الاختبارات المدرسية. مهمتك صياغة أسئلة دقيقة、公正 مستندة إلى نص الكتاب.
${ARABIC_ONLY}`;

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

export const VERIFY_SYSTEM = `أنت مراجع دقيق لأسئلة الامتحانات. مهمتك اكتشاف الأسئلة المعطوبة فقط، لا إعادة صياغتها.
${ARABIC_ONLY}`;

export function buildVerifyPrompt(
  formJson: string,
  pages: ExtractedPage[],
  pageFrom: number,
  pageTo: number
): string {
  return `راجع نموذج الامتحان التالي مقابل النص الأصلي، وحدّد الأسئلة المعطوبة.

=== نموذج الامتحان (JSON) ===
${formJson}
=== نهاية النموذج ===

=== النص الأصلي (الصفحات ${pageFrom} إلى ${pageTo}) ===
${pagesToPromptText(pages)}
=== نهاية النص ===

راجع كل سؤال على حدة، وبخاصة أسئلة mcq، وقيّم ما يلي:
- ambiguous: السؤال غامض أو يحتمل أكثر من قراءة واحدة.
- multiple_correct: أكثر من خيار واحد صحيح فعلاً حسب النص.
- not_in_source: الإجابة لا وجود لها في النص المقدم.
- bad_distractor: خيار مخطأ موجود في النص بحجة أنه خاطئ، أو الخيارات غير متجانسة.
- none: السؤال سليم.

اجعل index هو ترتيب السؤال داخل المصفوفة questions كما ورد أعلاه (يبدأ من ٠).
${ARABIC_ONLY}`;
}

/* -------------------------------------------------------------------------- */
/* Repair                                                                      */
/* -------------------------------------------------------------------------- */

export const REPAIR_SYSTEM = `أنت أخصائي في بناء الاختبارات المدرسية. مهمتك إعادة صياغة سؤال معطوب واحد فقط ليصبح صحيحاً وعادلاً ومستنداً إلى نص الكتاب.
${ARABIC_ONLY}`;

export const REPAIR_ISSUE_AR: Record<string, string> = {
  ambiguous: "السؤال غامض أو يحتمل أكثر من قراءة واحدة",
  multiple_correct: "أكثر من خيار واحد صحيح فعلاً حسب النص",
  not_in_source: "الإجابة لا وجود لها في النص المقدم",
  bad_distractor: "أحد الخيارات المخطئة موجود في النص بحجة أنه خاطئ، أو الخيارات غير متجانسة",
  none: "خلل غير محدد",
};

export function buildRepairPrompt(opts: {
  pages: ExtractedPage[];
  pageFrom: number;
  pageTo: number;
  difficulty: string;
  /** The question being replaced, as the model originally wrote it. */
  broken: unknown;
  issue: string;
  note: string;
  /** Every prompt already used anywhere in this exam set. */
  alreadyUsedPrompts: string[];
}): string {
  const used =
    opts.alreadyUsedPrompts.length > 0
      ? opts.alreadyUsedPrompts.map((q, i) => `${i + 1}. ${q}`).join("\n")
      : "(لا توجد أسئلة أخرى)";

  return `أعد صياغة سؤال واحد فقط، لتخل محل سؤال معطوب في امتحان، انطلاقاً من نص الكتاب.

=== نص الكتاب (مصدر الحقيقة الوحيد) ===
${pagesToPromptText(opts.pages)}
=== نهاية النص ===

=== السؤال المعطوب ===
${JSON.stringify(opts.broken, null, 2)}

=== سبب الرفض ===
النوع: ${REPAIR_ISSUE_AR[opts.issue] || REPAIR_ISSUE_AR.none}
ملاحظة المراجع: ${opts.note || "(لا توجد)"}

=== أسئلة مستخدمة في الامتحان (يجب ألا تكررها) ===
${used}
=== نهاية القائمة ===

=== المطلوب ===
١. أعِد بناء السؤال من الصفر إن لزم الأمر، مع تغيير الزاوية عن السؤال المعطوب وعن القائمة أعلاه.
٢. حافظ على نوع السؤال (mcq أو short) وعلى عدد درجاته المطلوب.
٣. اجعل الإجابة مستندة حرفياً إلى النص أعلاه، وقابلة للتحقق منه.
٤. مستوى الصعوبة المطلوب: ${DIFFICULTY_AR[opts.difficulty] || DIFFICULTY_AR.medium}.
٥. ضع في sourcePages الصفحات التي استُخرج منها السؤال الجديد، وكلها ضمن النطاق المعطى.
٦. أعد مصفوفة questions تحتوي سؤالاً واحداً فقط.
٧. لا تشرح سبب اختيارك ولا تعلّق على السؤال القديم.

=== ${MCQ_RULES} ===`;
}

/* -------------------------------------------------------------------------- */
/* Grading                                                                     */
/* -------------------------------------------------------------------------- */

export const GRADE_SYSTEM = `أنت مصحّح امتحانات منصف. مهمتك تقييم إجابات الطلاب بدقة ورحمة.
${ARABIC_ONLY}`;

export interface GradingItem {
  index: number;
  prompt: string;
  modelAnswer: string;
  rubric: string[];
  maxPoints: number;
  studentAnswer: string;
}

export function buildGradePrompt(items: GradingItem[]): string {
  const rendered = items
    .map(
      (it) => `### إجابة رقم ${it.index}
السؤال: ${it.prompt}
الإجابة النموذجية: ${it.modelAnswer}
معايير التقييم (${it.maxPoints} درجات):
${it.rubric.map((r, i) => `  ${i + 1}. ${r}`).join("\n")}
إجابة الطالب: ${it.studentAnswer || "(لم يجب الطالب)"}
`
    )
    .join("\n");

  return `قيّم إجابات الطلاب التالية مقابل الإجابات النموذجية ومعايير التقييم.

${rendered}
=== قواعد التصحيح ===
١. امنح درجة جزئية: أي نقطة في rubric يغطيها الطالب = درجة واحدة.
٢. لا تُخصم أي درجة على اختلاف الصياغة أو الأخطاء الإملائية الطفيفة أو استخدام مرادف.
٣. إذا كانت إجابة الطالب خارج نطاق الصفحات المطلوب الإجابة عنها، أعطِ صفراً.
٤. score يجب أن يكون رقماً بين ٠ و maxPoints بدون استثناء.
٥. feedback: من جملة إلى ثلاث جمل عربية موجّهة للطالب مباشرة، توضّح ما أصابه وما نقص منه. كن مشجّعاً وصريحاً، ولا تكتب عبارات عامة.
٦. confidence = "low" إذا كان التقييم غامضاً أو الإجابة غير مفهومة أو مخالفة للنص.
٧. أعد النتيجة بنفس ترتيب الإدخال: كل إجابة تعيد رقمها (index) كما ورد أعلاه.`;
}
