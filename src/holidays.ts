const FIXED = new Set(['1-1', '2-16', '3-11', '5-1', '6-24', '7-6', '8-15', '11-1', '11-2', '12-24', '12-25', '12-26']);

// Anonymous Gregorian algorithm.
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return { month: Math.floor(n / 31), day: (n % 31) + 1 };
}

function isFirstSunday(year: number, month: number, day: number, target: number): boolean {
  return month === target && day <= 7 && new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0;
}

// Lithuanian public holidays, including Mother's and Father's Day.
export function isLithuanianHoliday(year: number, month: number, day: number): boolean {
  if (FIXED.has(`${month}-${day}`)) return true;
  if (isFirstSunday(year, month, day, 5) || isFirstSunday(year, month, day, 6)) return true;
  const easter = easterSunday(year);
  const sunday = Date.UTC(year, easter.month - 1, easter.day);
  const date = Date.UTC(year, month - 1, day);
  return date === sunday || date === sunday + 86_400_000;
}
