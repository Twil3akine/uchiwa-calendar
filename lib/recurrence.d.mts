export type RecurrenceRule = { freq: "weekly"; until: string | null; count: number | null };
export function normalizeRecurrence(value: unknown, startDate: string): RecurrenceRule | null;
export function expandRecurrence(startDate: string, rule: RecurrenceRule | null): string[];
