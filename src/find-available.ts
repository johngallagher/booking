import { chromium } from "playwright";
import { getAllSlots, type AvailableCourt } from "./index";
import { getPlannedTennisSlots, type PlannedTennisSlot } from "./get-calendar-slots";

function courtFitsWithinPlannedSlot(court: AvailableCourt, planned: PlannedTennisSlot[]): boolean {
  return planned.some(
    (p) =>
      court.date === p.date &&
      court.startTime >= p.startTime &&
      court.endTime <= p.endTime
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const [availableCourts, plannedSlots] = await Promise.all([
    getAllSlots(page),
    getPlannedTennisSlots(),
  ]);

  await browser.close();

  const bookable = availableCourts.filter((court) =>
    courtFitsWithinPlannedSlot(court, plannedSlots)
  );

  console.log(`\n${bookable.length} court(s) available within your planned-in tennis slots:\n`);
  console.log(JSON.stringify(bookable, null, 2));
}

main().catch(console.error);
