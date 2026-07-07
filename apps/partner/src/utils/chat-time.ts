const TIME_SEPARATOR_GAP_MS = 5 * 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function shouldShowChatTime(
  previousTimestamp: number | null,
  timestamp: number,
): boolean {
  return previousTimestamp === null || timestamp - previousTimestamp >= TIME_SEPARATOR_GAP_MS;
}

export function formatChatTime(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp);
  const clock = formatClock(date);
  if (isSameDay(date, now)) {
    return clock;
  }
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${monthDay} ${clock}`;
  }
  return `${date.getFullYear()}年${monthDay} ${clock}`;
}
