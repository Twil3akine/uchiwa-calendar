export type CalendarInfo = { id: string; name: string };
export type Member = { id: string; name: string; color: string };
import type { RecurrenceRule } from "./recurrence.mjs";
export type CalendarEvent = { id: string; seriesId?: string; seriesStartDate?: string; memberId: string; title: string; startDate: string; endDate: string; version: number; recurrence?: RecurrenceRule | null };
export type CalendarData = { calendar: CalendarInfo; members: Member[]; events: CalendarEvent[]; me: Member | null };
export type ApiError = { error: string };
