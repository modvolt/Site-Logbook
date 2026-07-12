export function calculateSessionDurationSeconds(startedAt: Date, endedAt: Date, breakSeconds = 0): number {
  const elapsed = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
  return Math.max(0, elapsed - Math.max(0, breakSeconds));
}

export function secondsToRoundedHours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}

export function hoursToSeconds(hours: number): number {
  return Math.round(hours * 3600);
}

export function reviewThresholdSeconds(): number {
  const configured = Number(process.env.WORK_SESSION_REVIEW_HOURS);
  const hours = Number.isFinite(configured) && configured > 0 ? configured : 12;
  return Math.round(hours * 3600);
}
