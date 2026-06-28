import { Router, type IRouter } from "express";
import { z } from "zod/v4";

const router: IRouter = Router();

export interface PublicHoliday {
  date: string;
  name: string;
}

function easterMonday(year: number): string {
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
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const sunday = new Date(Date.UTC(year, month - 1, day));
  const monday = new Date(sunday.getTime() + 86400000);
  return monday.toISOString().slice(0, 10);
}

export function getCzechPublicHolidays(year: number): PublicHoliday[] {
  const fixed: PublicHoliday[] = [
    { date: `${year}-01-01`, name: "Nový rok / Den obnovy samostatného českého státu" },
    { date: `${year}-05-01`, name: "Svátek práce" },
    { date: `${year}-05-08`, name: "Den vítězství" },
    { date: `${year}-07-05`, name: "Den slovanských věrozvěstů Cyrila a Metoděje" },
    { date: `${year}-07-06`, name: "Den upálení mistra Jana Husa" },
    { date: `${year}-09-28`, name: "Den české státnosti" },
    { date: `${year}-10-28`, name: "Den vzniku samostatného československého státu" },
    { date: `${year}-11-17`, name: "Den boje za svobodu a demokracii" },
    { date: `${year}-12-24`, name: "Štědrý den" },
    { date: `${year}-12-25`, name: "1. svátek vánoční" },
    { date: `${year}-12-26`, name: "2. svátek vánoční" },
  ];

  const em = easterMonday(year);
  const easter = new Date(em + "T00:00:00Z");
  const goodFriday = new Date(easter.getTime() - 3 * 86400000);

  const holidays: PublicHoliday[] = [
    { date: goodFriday.toISOString().slice(0, 10), name: "Velký pátek" },
    { date: em, name: "Velikonoční pondělí" },
    ...fixed,
  ];

  return holidays.sort((a, b) => a.date.localeCompare(b.date));
}

const QuerySchema = z.object({
  year: z.coerce.number().int().optional(),
});

router.get("/public-holidays", async (req, res): Promise<void> => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const year = parsed.data.year ?? new Date().getFullYear();
  res.json(getCzechPublicHolidays(year));
});

export default router;
