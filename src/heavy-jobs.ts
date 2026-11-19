import { Slots } from "./slots";

/**
 * The machine-driven jobs that each hold tens of MiB at their caps: an
 * export page and one source's ingest. They take turns, so their peaks
 * never add up; the rest wait in arrival order.
 */
export const heavyJobs = new Slots(1);
