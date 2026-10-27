export const MEMBER_COLORS = [
  "#2563eb",
  "#db2777",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#4f46e5",
] as const;

export type MemberColor = (typeof MEMBER_COLORS)[number];

export const MEMBER_COLOR_NAMES: Record<MemberColor, string> = {
  "#2563eb": "青",
  "#db2777": "ピンク",
  "#059669": "緑",
  "#d97706": "オレンジ",
  "#7c3aed": "紫",
  "#0891b2": "水色",
  "#dc2626": "赤",
  "#4f46e5": "藍色",
};
