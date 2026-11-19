import { describe, expect, test } from "bun:test";
import { Slots } from "./slots";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Slots", () => {
  test("runs at most `size` tasks at once, the rest in arrival order", async () => {
    const slots = new Slots(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    let running = 0;
    let most = 0;
    const runs = gates.map((gate, i) =>
      slots.use(async () => {
        started.push(i);
        most = Math.max(most, ++running);
        await gate.promise;
        running--;
        return i;
      }),
    );
    await Bun.sleep(5);
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve();
    await Bun.sleep(5);
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) gate.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(most).toBe(2);
  });

  test("a task that throws frees its slot", async () => {
    const slots = new Slots(1);
    await expect(slots.use(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await slots.use(async () => "next")).toBe("next");
  });
});
