export type CalendarInfo = { id: string; name: string; viewKeyRequired: boolean };
export type Member = { id: string; name: string; color: string };
export type CalendarEvent = { id: string; memberId: string; title: string; startDate: string; endDate: string; version: number };
export type CalendarData = { calendar: CalendarInfo; members: Member[]; events: CalendarEvent[]; me: Member | null };
export type ApiError = { error: string };
