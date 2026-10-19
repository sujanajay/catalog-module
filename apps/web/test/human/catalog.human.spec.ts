// The full recorded gate needs an admin IAP session and the predeployed private cleanup job.
// REAL_DATA_DIR points at read-only delivery folders. No sign-in state is fabricated here.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type Locator } from "@playwright/test";
import sharp from "sharp";
import { cellUrls, readSheetTable } from "@catalog/core/catalog/ingest/links-sheet";
import { parseShotName } from "@catalog/core/catalog/naming";
import { buildZip } from "../../../../packages/core/test-fixtures/catalog/ingest-a/builders";
import { changeOnePixel, localFixture, sheetFixture, type RealShot } from "../../../worker/src/catalog-real-fixtures";
import { ADMIN_STATE } from "./auth-paths";

const execute=promisify(execFile),WAIT=24*60*60_000;
// Spec 07: no model or provider name in any page, API response or export.
const MODEL_NAMES=/birefnet|rmbg|bria|inspyre|ben_custom|esrgan|swinir|gemini|claude|qwen|llama|gpt-|openai\/|anthropic\/|google\//i;
/** Runs the predeployed catalog-test cleanup job for the batches this test created. */
async function cleanup(ids:Set<string>){
  if(!ids.size)return;
  const bash=process.platform==="win32"?path.join(process.env.LOCALAPPDATA!,"Programs/Git/bin/bash.exe"):"bash";
  const script=path.resolve(__dirname,"../../../../infra/catalog-test-cleanup.sh").replace(/\\/g,"/");
  await execute(bash,[script,...ids],{timeout:60*60_000,maxBuffer:1024*1024});
}
test("real wizard, downloadable JPEG links, identical delivery and changed/dropped shots",async({browser,baseURL},testInfo)=>{
  test.setTimeout(WAIT);
  const run=`human-${randomUUID()}`,out=testInfo.outputPath(run);
  await mkdir(out,{recursive:true});
  const fixture=await localFixture("anta",true,run);
  expect(fixture,"Anta is the documented fallback because no operator USPA footwear folder is configured.").not.toBeNull();
  const pasted=await sheetFixture("french-connection",false,run);expect(pasted,"Real Supabase image links are required.").not.toBeNull();
  const firstZip=path.join(out,"anta.zip");await writeFile(firstZip,buildZip(fixture!.shots.map(s=>({path:s.name,data:s.bytes}))));
  await writeFile(path.join(out,"source-manifest.json"),JSON.stringify({source:fixture!.source,files:fixture!.shots.map(s=>({deliveryName:s.name,sourceName:s.originalName})),pastedLinks:pasted!.urls},null,2));
  await writeFile(path.join(out,"source-note.txt"),"The operator USPA footwear set was unavailable. This run selected USPA in the UI and used the complete real Anta ZIP, the fallback explicitly allowed by spec 06. Genuine French Connection Supabase links from the supplied delivery sheets were pasted and read only. Tier 4 does not prescribe the brand of the pasted link list.");
  const context=await browser.newContext({baseURL,storageState:ADMIN_STATE,recordVideo:{dir:path.join(out,"videos")}});
  const page=await context.newPage(),ids=new Set<string>();
  // Observe the real create response so a failed wizard still has an exact cleanup list.
  page.on("response",async response=>{if(response.request().method()==="POST" && new URL(response.url()).pathname==="/api/catalog/batches" && response.ok()){const value=await response.json();if(typeof value.id==="string")ids.add(value.id);}});
  try {
    const first=await delivery(firstZip,"first");
    expect(first.changes.every(c=>c==="new")).toBe(true);
    expect(first.links.length).toBeGreaterThanOrEqual(3);
    for(const url of first.links.slice(0,3)){
      const response=await page.goto(url);expect(response?.status()).toBe(200);expect(response?.headers()["content-type"]?.split(";")[0]).toBe("image/jpeg");
      expect((await response!.body()).subarray(0,3)).toEqual(Buffer.from([255,216,255]));
    }
    const identical=await delivery(firstZip,"identical");
    expect(identical.changes.every(c=>c==="unchanged")).toBe(true);
    expect([...identical.generations.entries()].sort()).toEqual([...first.generations.entries()].sort());
    expect(identical.report.overwrites.every((o:{kind:string})=>o.kind==="unchanged")).toBe(true);

    const grouped=new Map<string,RealShot[]>();
    for(const shot of fixture!.shots){const key=parseShotName(shot.name).identifier;grouped.set(key,[...grouped.get(key)??[],shot]);}
    const groups=[...grouped.values()].filter(g=>g.length>=3);expect(groups.length).toBeGreaterThanOrEqual(2);
    const changed=groups[0]![0]!,removed=groups[1]!.at(-1)!;
    const changedName=changed.name.replace(/\.[^.]+$/,".png"),changedZip=path.join(out,"changed.zip");
    const changedBytes=await changeOnePixel(changed.bytes);
    await writeFile(changedZip,buildZip(await Promise.all(fixture!.shots.filter(s=>s!==removed).map(async s=>({path:s===changed?changedName:s.name,data:s===changed?changedBytes:s.bytes})))));
    const final=await delivery(changedZip,"changed");
    expect(final.changes).toContain("updated");expect(final.changes).toContain("shots_removed");expect(final.changes).toContain("unchanged");
    const removedUrls=final.report.removedLinks.map((r:{url?:string;publicUrl?:string})=>r.url??r.publicUrl);
    expect(removedUrls.length).toBeGreaterThan(0);
    const changes=final.report.overwrites.filter((o:{oldGeneration:unknown;newGeneration:unknown})=>o.oldGeneration!==null && o.newGeneration!==null);
    for(const [url,generation] of first.generations){
      if(removedUrls.includes(url)){
        await expect.poll(async()=>{const response=await context.request.get(url);return response.status();},{timeout:310_000,intervals:[10_000]}).toBe(404);
      } else {
        expect(final.generations.has(url)).toBe(true);
        const isChanged=changes.some((c:{oldGeneration:number;newGeneration:number})=>String(c.oldGeneration)===generation && String(c.newGeneration)===final.generations.get(url));
        if(isChanged)expect(final.generations.get(url)).not.toBe(generation);else expect(final.generations.get(url)).toBe(generation);
      }
    }
    const changedUrls=[...final.generations].filter(([url,g])=>first.generations.has(url)&&first.generations.get(url)!==g).map(([url])=>url);
    expect(changedUrls.length).toBeGreaterThan(0);
    for(const url of changedUrls){
      const downloaded=await context.request.get(url),expected=await downloaded.body();
      await expect.poll(async()=>{const response=await page.goto(url);return response?.status()===200 && (await response.body()).equals(expected);},{timeout:310_000,intervals:[10_000]}).toBe(true);
    }
    await writeFile(path.join(out,"completed.json"),JSON.stringify({ids:[...ids],first:first.links.length,unchanged:identical.links.length,changed:changedUrls,removed:removedUrls},null,2));
  } finally {
    // Closing saves the recorded video even when the assertion or cleanup fails.
    try {await cleanup(ids);}
    finally {await context.close();}
  }

  async function delivery(zip:string,label:string){
    await page.goto("/catalog");
    expect(new URL(page.url()).host.endsWith("accounts.google.com"),"Saved IAP session expired; run the existing human:login helper.").toBe(false);
    await page.getByRole("link",{name:"New batch",exact:true}).click();
    await page.getByLabel("Which brand?").selectOption({label:"USPA"});
    await page.getByLabel("Batch name (optional)").fill(`catalog-test ${run} ${label}`);
    await page.getByLabel("What kind of products?").selectOption("footwear");
    await page.getByLabel("Choose files",{exact:true}).setInputFiles(zip);
    await expect(page.getByText("Uploaded",{exact:false})).toBeVisible({timeout:10*60_000});
    await page.getByLabel("Or paste a link").fill(pasted!.urls.join("\n"));await page.getByLabel("Or paste a link").blur();
    await expect(page.getByText(/\d+ image links/)).toBeVisible({timeout:60_000});
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    await expect(page.getByLabel("By file name before the last _number",{exact:false})).toBeChecked({timeout:10*60_000});
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    await page.getByLabel(/^Noon/).check();await page.getByLabel(/^Styli/).check();
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    await expect(page.getByText("How we grouped your photos",{exact:true})).toBeVisible({timeout:10*60_000});
    if(label==="first")await expect(page.getByText(/\d+ products are new\./)).toBeVisible();
    await page.getByRole("button",{name:"Start processing",exact:true}).click();
    await expect(page).toHaveURL(/\/catalog\/[a-f0-9-]{36}$/);
    const id=new URL(page.url()).pathname.split("/").at(-1)!;ids.add(id);
    await expect(page.getByRole("status").filter({hasText:/Ready|need your attention/})).toBeVisible({timeout:WAIT-10*60_000});
    await page.getByRole("tab",{name:"Details",exact:true}).click();
    const verified=await page.getByText(/^Links verified: \d+ of \d+$/).textContent(),rechecked=await page.getByText(/^Independent re-check: \d+ of \d+ OK$/).textContent();
    const v=verified!.match(/(\d+) of (\d+)/)!,r=rechecked!.match(/(\d+) of (\d+)/)!;
    expect(Number(v[1])).toBeGreaterThan(0);expect(v[1]).toBe(v[2]);expect(r[1]).toBe(r[2]);expect(r[1]).toBe(v[1]);
    const reportResponse=await context.request.get(`/api/catalog/batches/${id}/export?format=report`);expect(reportResponse.ok()).toBe(true);const report=await reportResponse.json();
    const apiResponse=await context.request.get(`/api/catalog/batches/${id}`);expect(apiResponse.ok()).toBe(true);
    for(const text of [await page.content(),await apiResponse.text(),JSON.stringify(report)])expect(text).not.toMatch(MODEL_NAMES);
    await page.getByRole("tab",{name:"Links sheet",exact:true}).click();
    const waiting=page.waitForEvent("download");await page.getByRole("link",{name:"Download links sheet (Excel)",exact:true}).click();
    const file=path.join(out,`${label}.xlsx`);await(await waiting).saveAs(file);
    const sheet=await readSheetTable(await readFile(file),file),index=sheet.header.indexOf("change"),identifier=sheet.header.indexOf("identifier");expect(index).toBeGreaterThan(-1);
    const rows=sheet.rows.filter(row=>row[identifier]);const changes=rows.map(row=>row[index]),links=[...new Set(rows.flatMap(row=>row.flatMap(cellUrls)))];
    const generations=new Map<string,string>();for(const url of links){const response=await context.request.get(url);expect(response.status()).toBe(200);expect(response.headers()["content-type"]?.split(";")[0]).toBe("image/jpeg");generations.set(url,response.headers()["x-goog-generation"]!);}
    const filled=page.getByRole("link",{name:"Download filled product list",exact:true});
    if(await filled.count()){const next=page.waitForEvent("download");await filled.click();const destination=path.join(out,`${label}-filled.xlsx`);await(await next).saveAs(destination);const table=await readSheetTable(await readFile(destination),destination);expect(table.header).toContain("link_status");}
    await testInfo.attach(`${label} links sheet`,{path:file,contentType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
    return {changes,links,generations,report};
  }
});

// Steps 7 to 10 (spec 07). The dummy brand test_brand makes every batch is_test. Each product gets
// one deliberately small photo (under 500 px), so both always need attention whatever the judge says.
test("needs attention actions, Opptra SKU ids and the updated links sheet",async({browser,baseURL},testInfo)=>{
  test.setTimeout(WAIT);
  const run=`human-${randomUUID()}`,out=testInfo.outputPath(run);
  await mkdir(out,{recursive:true});
  const fixture=await localFixture("anta",false,run);
  expect(fixture,"The Anta delivery folder under REAL_DATA_DIR is required.").not.toBeNull();
  const [one,two]=fixture!.shots,ext=path.extname(one!.name);
  const small=(bytes:Buffer)=>sharp(bytes).resize(400,400,{fit:"inside"}).jpeg().toBuffer();
  const idA=`${run}-a`,idB=`${run}-b`,short=run.slice(-8).toUpperCase();
  const skus:Record<string,string>={[idA]:`CT${short}A`,[idB]:`CT${short}B`};
  const zip=path.join(out,"attention.zip");
  await writeFile(zip,buildZip([
    {path:`${idA}_1${ext}`,data:one!.bytes},{path:`${idA}_2${ext}`,data:two!.bytes},{path:`${idA}_3.jpg`,data:await small(one!.bytes)},
    {path:`${idB}_1.png`,data:await changeOnePixel(one!.bytes)},{path:`${idB}_2.png`,data:await changeOnePixel(two!.bytes)},{path:`${idB}_3.jpg`,data:await small(two!.bytes)},
  ]));
  const context=await browser.newContext({baseURL,storageState:ADMIN_STATE,recordVideo:{dir:path.join(out,"videos")}});
  const page=await context.newPage(),ids=new Set<string>();
  page.on("response",async response=>{if(response.request().method()==="POST" && new URL(response.url()).pathname==="/api/catalog/batches" && response.ok()){const value=await response.json();if(typeof value.id==="string")ids.add(value.id);}});
  try {
    await page.goto("/catalog");
    expect(new URL(page.url()).host.endsWith("accounts.google.com"),"Saved IAP session expired; run the existing human:login helper.").toBe(false);
    await page.getByRole("link",{name:"New batch",exact:true}).click();
    await page.getByLabel("Which brand?").selectOption("test_brand");
    await page.getByLabel("Batch name (optional)").fill(`catalog-test ${run} attention`);
    await page.getByLabel("What kind of products?").selectOption("footwear");
    await page.getByLabel("Choose files",{exact:true}).setInputFiles(zip);
    await expect(page.getByText("Uploaded",{exact:false})).toBeVisible({timeout:10*60_000});
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    await expect(page.getByLabel("By file name before the last _number",{exact:false})).toBeChecked({timeout:10*60_000});
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    await page.getByLabel(/^Noon/).check();await page.getByLabel(/^Styli/).check();
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    await expect(page.getByText("How we grouped your photos",{exact:true})).toBeVisible({timeout:10*60_000});
    await page.getByRole("button",{name:"Start processing",exact:true}).click();
    await expect(page).toHaveURL(/\/catalog\/[a-f0-9-]{36}$/);
    const batchUrl=new URL(page.url()).pathname,id=batchUrl.split("/").at(-1)!;ids.add(id);
    await expect(page.getByRole("status").filter({hasText:/need your attention/})).toBeVisible({timeout:WAIT-10*60_000});

    // Step 7: "Use as is" on the first photo; once the product has no undecided photo it resolves.
    const tab=page.getByRole("tab",{name:/^Needs attention \(\d+ products?\)$/});
    const before=Number((await tab.textContent())!.match(/\((\d+) products?\)/)![1]);
    expect(before).toBeGreaterThanOrEqual(2);
    await tab.click();
    const panel=page.getByRole("tabpanel",{name:/^Needs attention/});
    const cardA=panel.getByRole("article").filter({hasText:idA}),cardB=panel.getByRole("article").filter({hasText:idB});
    await keepAll(cardA);
    await expect(cardA.getByText("Resolved",{exact:true})).toBeVisible({timeout:5*60_000});
    await expect(cardA.getByText("Sheet updated.",{exact:true})).toBeVisible();
    await expect(page.getByRole("tab",{name:new RegExp(`^Needs attention \\(${before-1} products?\\)$`)})).toBeVisible({timeout:5*60_000});

    // Step 8: "Remove this photo" on the next product's first problem photo.
    const shown=(await cardB.getByText(/^Photo \d+ of \d+, made for .+$/).first().textContent())!.match(/^Photo (\d+) of \d+, made for (.+)$/)!;
    const removedN=Number(shown[1]),removedChannel=shown[2]!.trim();
    await cardB.getByRole("button",{name:"Remove this photo",exact:true,disabled:false}).first().click();
    const removedToast=page.getByText("Removed. The sheet cell is empty with a note.",{exact:true}),confirm=page.getByRole("button",{name:"Remove anyway",exact:true});
    await expect(removedToast.or(confirm).first()).toBeVisible();
    if(await confirm.isVisible())await confirm.click();
    await expect(removedToast.last()).toBeVisible();
    // Any other photo the judge flagged on this product is kept, so the product can publish.
    await keepAll(cardB);
    const attention=await context.request.get(`/api/catalog/batches/${id}/attention`);expect(attention.ok()).toBe(true);
    for(const text of [await page.content(),await attention.text()])expect(text).not.toMatch(MODEL_NAMES);

    // Step 9: add the two Opptra SKU ids from a two-column csv.
    await page.getByRole("tab",{name:"Links sheet",exact:true}).click();
    await page.getByRole("button",{name:"Add SKU ids",exact:true}).click();
    const dialog=page.getByRole("dialog");
    await expect(dialog.getByText("Add Opptra SKU ids",{exact:true})).toBeVisible();
    const csv=`identifier,opptra_sku_id\r\n${idA},${skus[idA]}\r\n${idB},${skus[idB]}\r\n`;
    await dialog.locator('input[type="file"]').setInputFiles({name:"sku-map.csv",mimeType:"text/csv",buffer:Buffer.from(csv)});
    await dialog.getByRole("button",{name:"Apply",exact:true}).click();
    await expect(page.getByText("2 ids added. New links sheet ready.",{exact:true})).toBeVisible({timeout:2*60_000});

    // Step 10: the new links sheet (after finalize) carries both ids and the removed cell's note.
    let attempt=0,latest:LinksSheet|null=null;
    await expect.poll(async()=>{
      const sheet=await downloadLinks(batchUrl,`links-${++attempt}`);latest=sheet;
      const col=sheet.names.indexOf("opptra_sku_ids"),idCol=sheet.names.indexOf("identifier");
      return [idA,idB].every(key=>sheet.rows.some(row=>row[idCol]===key && (row[col]??"").split(";").includes(skus[key]!)));
    },{timeout:15*60_000,intervals:[15_000]}).toBe(true);
    const {names,rows}=latest!,row=rows.find(r=>r[names.indexOf("identifier")]===idB)!;
    const cell=names.indexOf(`${removedChannel} Image ${removedN}`);
    expect(cell,`links sheet column "${removedChannel} Image ${removedN}"`).toBeGreaterThan(-1);
    expect(row[cell]).toBe("");
    expect(row[names.indexOf("notes")]).toContain(`img ${removedN}`);
    await writeFile(path.join(out,"completed.json"),JSON.stringify({ids:[...ids],skus,removed:{identifier:idB,n:removedN,channel:removedChannel}},null,2));
  } finally {
    try {await cleanup(ids);}
    finally {await context.close();}
  }

  /** Clicks every enabled "Use as is" on the card, one photo at a time, each with its toast. */
  async function keepAll(card:Locator){
    const keep=card.getByRole("button",{name:"Use as is",exact:true,disabled:false});
    for(let left=await keep.count();left>0;left--){
      await keep.first().click();
      await expect(page.getByText("Kept in the sheet",{exact:true}).last()).toBeVisible();
      await expect(keep).toHaveCount(left-1);
    }
  }

  /** Downloads the batch's current links sheet and flattens its two header rows into column names. */
  async function downloadLinks(batchUrl:string,label:string):Promise<LinksSheet>{
    await page.goto(batchUrl);
    await page.getByRole("tab",{name:"Links sheet",exact:true}).click();
    const waiting=page.waitForEvent("download");await page.getByRole("link",{name:"Download links sheet (Excel)",exact:true}).click();
    const file=path.join(out,`${label}.xlsx`);await(await waiting).saveAs(file);
    const sheet=await readSheetTable(await readFile(file),file),sub=sheet.rows[0]??[];
    const names=sheet.header.map((top,i)=>sub[i] && sub[i]!==top?`${top} ${sub[i]}`:top);
    await testInfo.attach(`${label} links sheet`,{path:file,contentType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
    return {names,rows:sheet.rows.slice(1)};
  }
});
type LinksSheet={names:string[];rows:string[][]};
