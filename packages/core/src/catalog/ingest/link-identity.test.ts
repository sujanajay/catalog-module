import { describe, expect, it } from "vitest";
import { linkIdentity } from "./link-identity";

describe("linkIdentity: two links are one file only when they differ by signing alone", () => {
  it("keeps every parameter that may name the file", () => {
    for (const url of ["https://h/img?id=1", "https://drive.google.com/uc?export=download&id=AAA", "https://h/a.jpg?v=2", "https://h/a.jpg?st=1&se=2", "https://h/a.jpg?expires=9"]) expect(linkIdentity(url)).toBe(url);
    expect(linkIdentity("https://h/img?id=1")).not.toBe(linkIdentity("https://h/img?id=2"));
  });
  it("drops signing parameters and the fragment", () => {
    const plain = "https://h/a.jpg";
    for (const signed of ["?token=x", "?X-Amz-Signature=1&X-Amz-Date=2", "?X-Goog-Signature=1", "?sig=1&se=2&sp=r&sv=3", "?Signature=1&Expires=2&AWSAccessKeyId=3", "#top"]) expect(linkIdentity(plain + signed)).toBe(plain);
    expect(linkIdentity("https://h/img?id=1&token=x")).toBe("https://h/img?id=1");
  });
  it("leaves text that is not a link as it is", () => {
    expect(linkIdentity("not a link")).toBe("not a link");
  });
});
