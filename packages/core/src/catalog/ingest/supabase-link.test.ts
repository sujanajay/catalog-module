// M1-F1-R4: which pasted cell is a Supabase folder link. A Supabase photo link (with a space in its
// name, or with no file ending) must stay an image link exactly as before the folder paste existed.
import { describe, expect, it } from "vitest";
import { detectPastedText } from "./detect";
import { canonicalFolderUrl, isSupabaseFolderCell, parseSupabaseFolderLink, supabaseFolderLinks, withoutSupabaseFolders } from "./supabase-link";

const ORIGIN = "https://projref.supabase.co";
const FOLDER = `${ORIGIN}/storage/v1/object/public/softlines/anta`;
const SPACED_PHOTO = `${ORIGIN}/storage/v1/object/public/softlines/anta/My Photo 1.jpg`;
const ON = { supabaseFolders: true };

describe("Supabase folder cells (review #1)", () => {
  it("a Supabase photo link with a space in its name is an image link, never a folder", () => {
    expect(isSupabaseFolderCell(SPACED_PHOTO)).toBe(false);
    expect(supabaseFolderLinks(SPACED_PHOTO)).toEqual([]);
    // Switched on or off, the paste is read exactly as it is with the folder paste off (as on main).
    expect(detectPastedText(SPACED_PHOTO, ON)).toEqual(detectPastedText(SPACED_PHOTO));
    expect(detectPastedText(SPACED_PHOTO)?.kind).toBe("url_list");
    expect(detectPastedText(`ABC1\t${SPACED_PHOTO}\nhttps://img.example.com/ABC2_1.jpg`, ON)?.kind).toBe("url_list");
  });

  it("with the folder paste off, even a folder link is read as an image link (today's behaviour)", () => {
    expect(detectPastedText(FOLDER)).toEqual({ kind: "url_list", ids: [FOLDER] });
    expect(detectPastedText(FOLDER, ON)).toEqual({ kind: "supabase_folder", ids: [FOLDER] });
  });

  it("a link to a bucket with no folder, or to a photo, is not a folder link", () => {
    expect(parseSupabaseFolderLink(`${ORIGIN}/storage/v1/object/public/softlines`)).toBeNull();
    expect(parseSupabaseFolderLink(`${ORIGIN}/storage/v1/object/public/softlines/`)).toBeNull();
    expect(parseSupabaseFolderLink(`${FOLDER}/A_1.JPEG`)).toBeNull();
    expect(parseSupabaseFolderLink(`${FOLDER}/bad%E0`)).toBeNull();
    expect(parseSupabaseFolderLink(`text before ${FOLDER}`)).toBeNull();
  });

  it("every spelling of one folder has one canonical link, with no token kept", () => {
    const spellings = [FOLDER, `${FOLDER}/`, `${FOLDER}?x=1`, `${ORIGIN}/storage/v1/object/sign/softlines/anta?token=abc.def`, `  ${FOLDER}  `];
    expect(new Set(spellings.map((s) => canonicalFolderUrl(parseSupabaseFolderLink(s)!)))).toEqual(new Set([FOLDER]));
    expect(canonicalFolderUrl(parseSupabaseFolderLink(`${ORIGIN}/storage/v1/object/public/softlines/My%20Brand/AW26`)!)).toBe(`${ORIGIN}/storage/v1/object/public/softlines/My%20Brand/AW26`);
  });

  it("reads every folder link in a text, and leaves the image links beside them in place", () => {
    const other = `${ORIGIN}/storage/v1/object/public/softlines/uspa`;
    const text = `${FOLDER}\nhttps://img.example.com/ABC2_1.jpg\n${other}/\n${FOLDER}?again=1\nABC3\thttps://img.example.com/ABC3_1.jpg`;
    expect(supabaseFolderLinks(text)).toEqual([FOLDER, other]);
    expect(withoutSupabaseFolders(text)).toBe("\nhttps://img.example.com/ABC2_1.jpg\n\n\nABC3\thttps://img.example.com/ABC3_1.jpg");
  });
});
