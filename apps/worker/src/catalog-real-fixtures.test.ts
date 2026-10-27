import { expect, test } from "vitest";
import sharp from "sharp";
import { changeOnePixel, pastedLines } from "./catalog-real-fixtures";
import { parsePastedLinks, urlListItems } from "@catalog/core/catalog/ingest/url-list";
import { productPrefix, normalizeKey } from "@catalog/core/catalog/naming";
import { createHash } from "node:crypto";
import { prepare, renderAllChannels } from "@catalog/core/catalog/render";

test("the overwrite fixture changes exactly one decoded colour component and leaves the original bytes untouched",async()=>{
  const original=await sharp({create:{width:17,height:13,channels:3,background:{r:80,g:120,b:160}}}).jpeg().toBuffer();
  const before=Buffer.from(original),decoded=await sharp(original).removeAlpha().toColourspace("srgb").raw().toBuffer();
  const edited=await changeOnePixel(original),after=await sharp(edited).raw().toBuffer();
  expect(original).toEqual(before);
  expect((await sharp(edited).metadata()).format).toBe("png");
  const differences=[...after.keys()].filter(index=>after[index]!==decoded[index]);
  expect(differences).toEqual([(6*17+8)*3]);
  expect(Math.abs(after[differences[0]!]!-decoded[differences[0]!]!)).toBe(1);
});

test("a genuine one-pixel source change can encode to the same JPEG, so source identity cannot be inferred from output CRC",async()=>{
  const raw=Buffer.alloc(800*800*4);
  for(let y=200;y<600;y++)for(let x=200;x<600;x++){const index=(y*800+x)*4;raw[index]=80;raw[index+1]=120;raw[index+2]=160;raw[index+3]=255;}
  const original=await sharp(raw,{raw:{width:800,height:800,channels:4}}).png().toBuffer();
  const edited=await changeOnePixel(original);
  expect(createHash("sha256").update(edited).digest("hex")).not.toBe(createHash("sha256").update(original).digest("hex"));
  const render=async(bytes:Buffer)=>{
    const prepared=await prepare(bytes,"source.png",async()=>{throw new Error("No conversion is expected.");});
    expect(prepared.alphaSource).not.toBeNull();
    return (await renderAllChannels(prepared,{alpha:prepared.alphaSource!,width:800,height:800,model:"alpha_source",ms:0,source:"alpha_source",target:null,sentLongSide:null},["noon"],{shotNumber:1,productType:"apparel_flat",identifier:"proof",publicObjectPath:"catalog-test/proof/proof/noon/proof_1.jpg"})).noon;
  };
  const before=await render(original),after=await render(edited);
  expect(before.compliance.ok).toBe(true);expect(after.compliance.ok).toBe(true);
  expect(after.jpeg).toEqual(before.jpeg);
});

test("two independent real runs use disjoint public prefixes while reading the exact original URLs",()=>{
  const urls=["https://photos.supabase.co/storage/v1/object/public/shoes/ABC_1.jpg","https://photos.supabase.co/storage/v1/object/public/shoes/ABC_2.jpg"];
  const collect=(run:string)=>urlListItems(parsePastedLinks(pastedLines(urls,run).join("\n")),"upload");
  const first=collect("run-one"),second=collect("run-two");
  expect(first.map(s=>s.identifier)).toEqual(["run-one-ABC","run-one-ABC"]);
  expect(first.map(s=>s.n)).toEqual([1,2]);
  expect(first.map(s=>s.bytes.kind==="url"?s.bytes.url:null)).toEqual(urls);
  expect(second.map(s=>s.bytes.kind==="url"?s.bytes.url:null)).toEqual(urls);
  const left=productPrefix("anta",normalizeKey(first[0]!.identifier),true),right=productPrefix("anta",normalizeKey(second[0]!.identifier),true);
  expect(left).not.toBe(right);expect(left.startsWith(right)||right.startsWith(left)).toBe(false);
});
