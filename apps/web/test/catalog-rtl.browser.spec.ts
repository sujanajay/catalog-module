import { expect, test, type Page } from "@playwright/test";

// UX1 acceptance (UX design system section 15): "RTL screenshot test passes on today's pages". Each of today's pages,
// on the intake harness (test/catalog-intake.server.ts), is opened, switched to dir="rtl", photographed (attached to
// the report and kept in test-results) and checked: the layout mirrors by itself (logo on the right, the user menu on
// the left, headings start on the right, back arrows turned round), nothing scrolls sideways at desktop or phone
// width, and no element is still aligned to a physical side. Also: the 2 px focus ring and the Arabic font.
// Run: pnpm --filter @catalog/web exec playwright test --config test/catalog-intake.config.ts catalog-rtl

type Box = { x: number; y: number; width: number; height: number };

async function asUser(page: Page, role: "admin" | "operator") {
  expect((await page.request.post("/harness/user", { data: { role } })).ok()).toBe(true);
}

test.beforeEach(async ({ page }) => {
  // The Next.js dev overlay (a test-only artefact of next dev) would sit in the screenshots.
  await page.addInitScript(() => {
    const hide = () => document.head.insertAdjacentHTML("beforeend", "<style>nextjs-portal{display:none!important}</style>");
    if (document.head) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
  expect((await page.request.post("/harness/settle")).ok()).toBe(true);
});
test.afterEach(async ({ page }) => asUser(page, "operator"));

/** Today's pages: Home (batch list), New batch, a batch, a brand, a product, Settings and Ops (both admin only). */
async function pages(page: Page): Promise<{ name: string; url: string; admin?: boolean }[]> {
  const created = await page.request.post("/api/catalog/batches", { data: { brandSlug: "test_brand", productType: "auto", name: "catalog-test rtl" } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return [
    { name: "home", url: "/catalog" },
    { name: "new-batch", url: "/catalog/new" },
    { name: "batch", url: `/catalog/${id}` },
    { name: "brand", url: "/catalog/brands/test_brand" },
    { name: "product", url: "/catalog/products/test_brand/RTL-SAMPLE-1" },
    { name: "settings", url: "/catalog/settings", admin: true },
    { name: "ops", url: "/catalog/ops", admin: true },
  ];
}

const box = async (page: Page, selector: string): Promise<Box> => {
  const b = await page.locator(selector).first().boundingBox();
  expect(b, selector).not.toBeNull();
  return b!;
};

test("today's pages mirror cleanly right to left", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  for (const p of await pages(page)) {
    await test.step(p.name, async () => {
      await asUser(page, p.admin ? "admin" : "operator");
      await page.setViewportSize({ width: 1280, height: 900 });
      const res = await page.goto(p.url);
      expect(res?.status(), `${p.url} answers`).toBeLessThan(400);
      await expect(page.locator("main h1").first()).toBeVisible();
      const ltrLogo = await box(page, ".top .logo");
      const ltrUser = await box(page, ".top .ub");
      expect(ltrLogo.x).toBeLessThan(ltrUser.x);

      await page.evaluate(() => { document.documentElement.dir = "rtl"; });
      // The top bar mirrors: the logo starts at the right, the user menu sits at the left.
      const logo = await box(page, ".top .logo");
      const user = await box(page, ".top .ub");
      expect(logo.x, "logo moves to the right").toBeGreaterThan(user.x);
      const width = await page.evaluate(() => document.documentElement.clientWidth);
      expect(Math.abs(width - (logo.x + logo.width) - ltrLogo.x), "logo mirrors its left-to-right place").toBeLessThan(2);
      // The heading's text starts at the right edge of the page column.
      const heading = await page.locator("main h1").first().evaluate((h) => {
        const range = document.createRange();
        range.selectNodeContents(h);
        const text = range.getBoundingClientRect();
        const main = h.closest("main")!;
        const style = getComputedStyle(main);
        const right = main.getBoundingClientRect().right - parseFloat(style.paddingRight);
        return { textRight: text.right, columnRight: right };
      });
      expect(Math.abs(heading.textRight - heading.columnRight), "the heading starts on the right").toBeLessThan(2);
      // Nothing is pinned to a physical side (next dev's own overlay element is not the app), and back arrows turn round.
      const physical = await page.evaluate(() => [...document.querySelectorAll("body *:not(nextjs-portal)")].filter((el) => {
        const s = getComputedStyle(el);
        return s.textAlign === "left" || s.textAlign === "right" || s.float === "left" || s.float === "right";
      }).map((el) => `${el.tagName.toLowerCase()}.${el.className}`));
      expect(physical, "elements aligned to a physical side").toEqual([]);
      for (const transform of await page.locator(".mirror").evaluateAll((els) => els.map((el) => getComputedStyle(el).transform))) {
        expect(transform).toBe("matrix(-1, 0, 0, 1, 0, 0)");
      }
      // Times, codes and links keep their own order ("5 Nov 2026", not "Nov 2026 5").
      const flipped = await page.locator("main time, main .mono, main code").evaluateAll((els) => els.filter((el) => {
        const text = el.firstChild;
        if (!text || text.nodeType !== Node.TEXT_NODE || (text.textContent ?? "").trim().length < 2) return false;
        const at = (i: number) => { const r = document.createRange(); r.setStart(text, i); r.setEnd(text, i + 1); return r.getBoundingClientRect(); };
        const first = at(0), last = at(text.textContent!.length - 1);
        return Math.abs(first.top - last.top) < 2 && first.left > last.left;
      }).map((el) => el.textContent));
      expect(flipped, "times and codes read left to right").toEqual([]);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(wide, "no sideways scroll at 1280 px").toBeLessThanOrEqual(0);
      const shot = await page.screenshot({ fullPage: true, path: testInfo.outputPath(`rtl-${p.name}-1280.png`) });
      await testInfo.attach(`rtl-${p.name}-1280`, { body: shot, contentType: "image/png" });

      // Phone width (section 12): one column, no sideways scroll.
      await page.setViewportSize({ width: 360, height: 780 });
      const narrow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(narrow, "no sideways scroll at 360 px").toBeLessThanOrEqual(0);
      const phone = await page.screenshot({ fullPage: true, path: testInfo.outputPath(`rtl-${p.name}-360.png`) });
      await testInfo.attach(`rtl-${p.name}-360`, { body: phone, contentType: "image/png" });
    });
  }
});

test("the focus ring is 2 px in the focus colour, and Arabic text uses IBM Plex Sans Arabic", async ({ page }) => {
  await page.goto("/catalog");
  await expect(page.locator("main h1").first()).toBeVisible();
  const focus = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--focus").trim());
  // A link in the page column (outside the navy top bar, which has its own lighter ring).
  const link = page.locator("main a").first();
  await link.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const ring = await link.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
  });
  expect(ring.style).toBe("solid");
  expect(ring.width).toBe("2px");
  const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  expect(ring.color).toBe(rgb(focus));

  // An Arabic content line, as a channel preview would show it.
  const arabic = await page.evaluate(async () => {
    const p = document.createElement("p");
    p.lang = "ar";
    p.dir = "rtl";
    p.textContent = "قميص بولو أزرق من القطن";
    document.querySelector("main")!.append(p);
    await document.fonts.ready;
    const faces = [...document.fonts].filter((f) => /Plex.Sans.Arabic/i.test(f.family));
    await Promise.all(faces.map((f) => f.load().catch(() => null)));
    await document.fonts.ready;
    const s = getComputedStyle(p);
    return { family: s.fontFamily, lineHeight: parseFloat(s.lineHeight) / parseFloat(s.fontSize), loaded: faces.some((f) => f.status === "loaded") };
  });
  expect(arabic.family).toMatch(/Plex.Sans.Arabic/i);
  expect(arabic.loaded, "the Arabic face is available").toBe(true);
  expect(arabic.lineHeight).toBeCloseTo(1.7, 1);
});
