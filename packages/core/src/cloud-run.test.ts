import { describe, expect, it } from "vitest";
import { cloudRunAudience } from "./cloud-run";

const SERVICE = "https://catalog-matting-gpu-qtoctgoxqa-as.a.run.app";

describe("cloudRunAudience", () => {
  it("turns a tag URL into the service URL", () => {
    expect(cloudRunAudience("https://candidate---catalog-matting-gpu-qtoctgoxqa-as.a.run.app")).toBe(SERVICE);
    expect(cloudRunAudience("https://preview-e60d5fa---catalog-worker-847405579637.asia-south1.run.app")).toBe("https://catalog-worker-847405579637.asia-south1.run.app");
  });
  it("leaves an untagged service URL as it is", () => {
    expect(cloudRunAudience(SERVICE)).toBe(SERVICE);
    expect(cloudRunAudience("https://catalog-worker-847405579637.asia-south1.run.app")).toBe("https://catalog-worker-847405579637.asia-south1.run.app");
  });
  it("drops the path, query and trailing slash of a run.app URL", () => {
    expect(cloudRunAudience(`${SERVICE}/`)).toBe(SERVICE);
    expect(cloudRunAudience("https://candidate---catalog-matting-gpu-qtoctgoxqa-as.a.run.app/upscale?model=x&scale=2")).toBe(SERVICE);
  });
  it("returns any other URL unchanged", () => {
    for (const url of ["https://gpu.example", "https://a---b.example.com/x", "http://localhost:8081", "not a url"]) expect(cloudRunAudience(url)).toBe(url);
  });
});
