/** The feed deliberately accepts only public calendar data and never depends on server APIs. */
export type IcalFeedEvent = {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  updatedAt: string;
  memberName: string;
};

export type IcalFeedInput = { calendarName: string; events: IcalFeedEvent[] };

function cleanText(value: string) {
  // Normalize all newline forms before removing other C0/C1 controls.
  return value.replace(/\r\n|\r|\n/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, (char) => char === "\n" ? "\n" : "");
}

export function escapeIcalText(value: string) {
  return cleanText(value).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Fold a content line to RFC 5545's 75 octets, counting UTF-8 bytes. */
export function foldIcalLine(line: string) {
  const output: string[] = [];
  let part = "";
  let bytes = 0;
  for (const character of line) {
    const width = new TextEncoder().encode(character).byteLength;
    if (bytes + width > 75) {
      output.push(part);
      part = ` ${character}`;
      bytes = 1 + width;
    } else {
      part += character;
      bytes += width;
    }
  }
  output.push(part);
  return output.join("\r\n");
}

function dateNextDay(date: string) {
  if (date === "9999-12-31") return "99991231";
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10).replaceAll("-", "");
}

function stamp(updatedAt: string) {
  // SQLite CURRENT_TIMESTAMP has no zone suffix; its values are UTC by definition.
  const utc = /(?:Z|[+-]\d\d:\d\d)$/i.test(updatedAt) ? updatedAt : `${updatedAt.replace(" ", "T")}Z`;
  const parsed = new Date(utc);
  if (Number.isNaN(parsed.valueOf())) throw new Error("Invalid event updatedAt");
  return parsed.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function property(name: string, value: string) {
  return foldIcalLine(`${name}:${value}`);
}

export function generateIcalFeed({ calendarName, events }: IcalFeedInput) {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//uchiwa-calendar//iCalendar Feed//JA",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    property("X-WR-CALNAME", escapeIcalText(calendarName)),
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      property("UID", `${event.id}@uchiwa-calendar`),
      property("DTSTAMP", stamp(event.updatedAt)),
      property("DTSTART;VALUE=DATE", event.startDate.replaceAll("-", "")),
      property("DTEND;VALUE=DATE", dateNextDay(event.endDate)),
      property("SUMMARY", escapeIcalText(event.title)),
      property("DESCRIPTION", escapeIcalText(event.memberName)),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
