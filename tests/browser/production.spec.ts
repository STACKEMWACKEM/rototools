import { test, expect } from "@playwright/test";
import path from "node:path";
test("production PWA reopens local media and edits offline", async ({
  page,
}) => {
  test.skip(
    !process.env.PRODUCTION_URL,
    "Set PRODUCTION_URL to a built API origin.",
  );
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));
  await page.goto(process.env.PRODUCTION_URL!);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(path.resolve("work/fixtures/moving.mp4"));
  await expect(page.getByText("Exact frame ready")).toBeVisible();
  await expect(page.getByText("Saved on this device")).toBeVisible();
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(
    true,
  );
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByLabel("Project name")).toHaveValue("moving");
  await expect(page.getByText("Exact frame ready")).toBeVisible();
  await page.getByRole("button", { name: /Ellipse$/ }).click();
  const box = (await page.getByLabel("Video masking canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7);
  await page.mouse.up();
  await expect(page.getByLabel("Undo")).toBeEnabled();
  await expect(page.getByText("Saved on this device")).toBeVisible();
  expect(failures).toEqual([]);
});
test("backup restores source and edits, and quota errors preserve prior revision", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(path.resolve("work/fixtures/moving.mp4"));
  await expect(page.getByText("Exact frame ready")).toBeVisible();
  await expect(page.getByText("Saved on this device")).toBeVisible();
  const originalId = await page.evaluate(async () => {
    const { list } = (await import(
      "/src/storage.ts" as string
    )) as typeof import("../../frontend/src/storage");
    return (await list())[0].id;
  });
  await page.getByRole("button", { name: /^Export/ }).click();
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download portable project" }).click();
  const download = await event;
  await download.saveAs("work/browser-backup.zip");
  await page.getByLabel("Close dialog").click();
  await page
    .locator("input[type=file]")
    .nth(1)
    .setInputFiles(path.resolve("work/browser-backup.zip"));
  await expect(page.getByText("Exact frame ready")).toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue("moving");
  await expect(page.getByText("Saved on this device")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("rototools-last")))
    .not.toBe(originalId);
  await page.evaluate(async (id) => {
    const { list, getAsset, remove } = (await import(
      "/src/storage.ts" as string
    )) as typeof import("../../frontend/src/storage");
    const projects = await list();
    const original = projects.find((p) => p.id === id)!;
    const restoredId = localStorage.getItem("rototools-last");
    const restored = projects.find((p) => p.id === restoredId)!;
    if (original.source!.id === restored.source!.id)
      throw new Error("Restored source aliases the original project");
    await remove(id);
    if (!(await getAsset(restored.source!.id)))
      throw new Error("Deleting original removed restored source");
  }, originalId);
  await page.reload();
  await expect(page.getByText("Exact frame ready")).toBeVisible();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
      if (this.name === "projects")
        throw new DOMException(
          "Injected quota exhaustion",
          "QuotaExceededError",
        );
      return original.call(this, value, key);
    };
  });
  await page.getByLabel("Project name").fill("Unsaved quota failure");
  await expect(page.getByText("Save failed — export a backup")).toBeVisible();
});
