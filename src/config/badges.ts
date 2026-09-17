export interface BadgeText {
  en: string;
  ar: string;
}

export interface BadgeDef {
  id: string;
  icon: string;
  title: BadgeText;
  description: BadgeText;
}

export interface EarnedBadge extends BadgeDef {
  earned: true;
}

export interface LockedBadge extends BadgeDef {
  earned: false;
}

export const BADGES: BadgeDef[] = [
  {
    id: "first_video",
    icon: "🎬",
    title: { en: "Movie Night", ar: "ليلة سينما" },
    description: { en: "Watch your first lesson", ar: "شاهد أول درس لك" },
  },
  {
    id: "video_5",
    icon: "🎥",
    title: { en: "Binge Watcher", ar: "متفرج محترف" },
    description: { en: "Watch 5 different lessons", ar: "شاهد 5 دروس مختلفة" },
  },
  {
    id: "video_10",
    icon: "📺",
    title: { en: "Marathoner", ar: "عدّاء الماراثون" },
    description: { en: "Watch 10 different lessons", ar: "شاهد 10 دروس مختلفة" },
  },
  {
    id: "streak_3",
    icon: "🔥",
    title: { en: "On Fire", ar: "مشتعل" },
    description: { en: "Keep a 3-day streak", ar: "حافظ على سلسلة 3 أيام" },
  },
  {
    id: "streak_7",
    icon: "🌠",
    title: { en: "Unstoppable", ar: "لا يُوقف" },
    description: { en: "Keep a 7-day streak", ar: "حافظ على سلسلة 7 أيام" },
  },
  {
    id: "points_100",
    icon: "⭐",
    title: { en: "100 Club", ar: "نادي الـ 100" },
    description: { en: "Earn 100 total points", ar: "احصد 100 نقطة إجمالية" },
  },
  {
    id: "points_250",
    icon: "💎",
    title: { en: "Diamond Hands", ar: "يد نادرة" },
    description: { en: "Earn 250 total points", ar: "احصد 250 نقطة إجمالية" },
  },
  {
    id: "quiz_perfect",
    icon: "🎯",
    title: { en: "Bullseye", ar: "خدّ بالهدف" },
    description: { en: "Score 100% on a quiz", ar: "احصل على 100% في اختبار" },
  },
  {
    id: "quiz_runner",
    icon: "🧠",
    title: { en: "Quiz Runner", ar: "بطل الاختبارات" },
    description: { en: "Complete 5 quiz attempts", ar: "أنهِ 5 محاولات اختبار" },
  },
  {
    id: "exam_90",
    icon: "🏅",
    title: { en: "Excellence", ar: "امتياز" },
    description: { en: "Score 90%+ on an exam", ar: "احصل على 90% فأكثر في امتحان" },
  },
  {
    id: "homework_50",
    icon: "📚",
    title: { en: "Hard Worker", ar: "مجدّ" },
    description: { en: "Earn 50 homework points", ar: "احصد 50 نقطة واجبات" },
  },
];

export const LEVEL_STEP = 100;

export function levelFromPoints(earned: number) {
  const level = Math.floor(earned / LEVEL_STEP) + 1;
  const pointsIntoLevel = earned % LEVEL_STEP;
  const pointsForNext = LEVEL_STEP;
  const progressPercent = Math.min(100, Math.round((pointsIntoLevel / LEVEL_STEP) * 100));
  return { level, pointsIntoLevel, pointsForNext, progressPercent };
}