import { test, expect } from "@playwright/test";
import path from "node:path";
test("local import, draw, undo, autosave, backup and reopening without upload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const uploads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/uploads")) uploads.push(r.url());
  });
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(path.resolve("work/fixtures/moving.mp4"));
  await expect(page.getByText("Exact frame ready")).toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue("moving");
  const canvas = page.getByLabel("Video masking canvas");
  const bounds = (await canvas.boundingBox())!;
  const scale = Math.min(bounds.width / 160, bounds.height / 96),
    left = bounds.x + (bounds.width - 160 * scale) / 2,
    top = bounds.y + (bounds.height - 96 * scale) / 2;
  await page.mouse.move(left + 30 * scale, top + 24 * scale);
  await page.mouse.down();
  await page.mouse.move(left + 90 * scale, top + 68 * scale, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByLabel("Undo")).toBeEnabled();
  await page.getByLabel("Next frame").click();
  await expect(page.getByText("FRAME 0001")).toBeVisible();
  await page.getByLabel("Feather", { exact: true }).fill("2");
  await expect(page.getByText("Saved on this device")).toBeVisible();
  const revision = await page.evaluate(async () => {
    const r = indexedDB.open("rototools");
    return new Promise<number>((resolve, reject) => {
      r.onsuccess = () => {
        const tx = r.result.transaction("projects");
        const q = tx.objectStore("projects").getAll();
        q.onsuccess = () => resolve(q.result[0].revision);
      };
      r.onerror = () => reject(r.error);
    });
  });
  expect(revision).toBeGreaterThan(1);
  await page.getByRole("button", { name: /^Export/ }).click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download portable project", exact: true })
    .click();
  const downloaded = await download;
  expect(downloaded.suggestedFilename()).toContain(".rototools.zip");
  await page.getByLabel("Close dialog").click();
  await page.reload();
  await expect(page.getByLabel("Project name")).toHaveValue("moving");
  await expect(page.getByText("Exact frame ready")).toBeVisible();
  expect(uploads).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "work/editor-desktop.png", fullPage: true });
});
test("mobile layout, accessible controls and second-pointer cancellation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(path.resolve("work/fixtures/silent.mp4"));
  await expect(page.getByText("Exact frame ready")).toHaveText(
    "Exact frame ready",
  );
  const canvas = page.getByLabel("Video masking canvas"),
    box = (await canvas.boundingBox())!;
  const x = box.width / 2,
    y = box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const first = { id: 1, x: box.x + x - 30, y: box.y + y - 20 },
    second = { id: 2, x: box.x + x + 30, y: box.y + y + 20 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [first],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [first, second],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
  await expect(page.getByRole("button", { name: /^Export/ })).toBeVisible();
  await expect(page.getByLabel("Undo")).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "work/editor-mobile.png", fullPage: true });
});
test("connected backend prepares and renders a real frontend mask", async ({
  page,
}) => {
  const caps = await (await page.request.get("/api/capabilities")).json();
  expect(caps.workerReady).toBe(true);
  expect(caps.exports.formats).toContain("mp4");
  expect(caps.model.ready).toBe(false);
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(path.resolve("work/fixtures/moving.mp4"));
  await expect(page.getByText("Exact frame ready")).toBeVisible();
  const box = (await page.getByLabel("Video masking canvas").boundingBox())!,
    scale = Math.min(box.width / 160, box.height / 96),
    left = box.x + (box.width - 160 * scale) / 2,
    top = box.y + (box.height - 96 * scale) / 2;
  await page.mouse.move(left + 20 * scale, top + 10 * scale);
  await page.mouse.down();
  await page.mouse.move(left + 100 * scale, top + 75 * scale);
  await page.mouse.up();
  await page.getByRole("button", { name: /^Export/ }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Render online & download" }).click();
  const output = await download;
  await output.saveAs("work/browser-export.mp4");
  expect(output.suggestedFilename()).toMatch(/\.mp4$/);
  await expect(page.getByText(/Export ready from revision/)).toBeVisible();
});

test("unsupported local decoder uses real online frames and reopens its saved project", async ({
  page,
}) => {
  await page.addInitScript(() => {
    VideoDecoder.isConfigSupported = async (config) => ({
      supported: false,
      config,
    });
  });
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(path.resolve("work/fixtures/moving.mp4"));
  await expect(page.getByText(/This browser cannot decode/)).toBeVisible();
  await page
    .getByRole("button", { name: "Prepare online", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Upload & prepare online", exact: true })
    .click();
  await expect(page.getByText("Online preparation complete.")).toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue("moving.mp4");
  await expect(page.getByText("Exact frame ready")).toBeVisible();
  await expect(page.getByText("Saved on this device")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Exact frame ready")).toBeVisible();
  await expect(page.getByLabel("Project name")).toHaveValue("moving.mp4");
});
