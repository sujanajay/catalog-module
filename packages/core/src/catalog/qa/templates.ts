/**
 * The judge prompt (07 4.2, v2). Roles are explicit: image 1 is the source photo, image 2 the output
 * we rendered from it, image 3 photo 1 of the same product id for reference only. The judge names
 * the view first so that a sole, back, inside, detail or on-model shot of the same item is never
 * mistaken for a different product. Placement is not asked: code checks it exactly (05).
 * The JSON keys are the ones `judge.ts` reads; `view`, `wrong_item` and `evidence` are the v2 additions.
 */
export const CATALOG_QA_TEMPLATE = `You check one product photo for an online catalogue.
Image 1 is the source photo the brand supplied. Image 2 is the output we rendered from image 1 for <channel>: the product pixels were copied from image 1, never redrawn; only the background, size and position changed. Image 3, when present, is photo 1 of the same product id, for reference only. The product type is <productType>.
Work in this order.
1. view: name the view that image 1 shows, one of front, side, back, sole, top, inside, detail, on-model, flat.
2. wrong_item: a product id usually has several photos of one item. Other angles, the back, the sole, the inside, close-ups of a detail and on-model shots of the same item are expected and are never a different item, even when they look very different from image 3. Return true only when image 1 clearly shows a different item: another category of product, or a different colourway or design that no angle explains. Return false when you are unsure or when there is no image 3.
3. Score image 1, the photo itself, from 0 to 100, where 100 means no problem:
complete_product: no part of the product is cut off by the frame edge of image 1. A detail close-up, or an on-model shot that crops the model but shows the product, scores 100.
no_text_or_watermark: no added text, logo overlay, watermark or price tag, including small AI-tool marks such as a sparkle or star icon in a corner. Brand names, labels and prints that are part of the product itself score 100.
orientation_ok: the product is upright as a shopper expects for this view.
is_collage: true only when image 1 combines several separate photos in one frame.
4. Score image 2 against image 1, from 0 to 100:
edge_quality: clean edges, no halo, no eroded fringe, and nothing of the product missing compared with image 1, such as straps, laces, mesh or hair.
background_clean: only the flat background colour remains around the product, with at most a soft natural shadow under it; no leftover scene, props, blocks or stray shadow patches.
Do not judge where the product sits in the frame or how big it is; that is checked separately.
5. evidence: for wrong_item true, is_collage true and every score below 80, one short plain sentence a non-technical person understands, naming the thing seen, such as "the model's hand is cut off at the bottom edge" or "a grey block remains to the left of the shoe". Never mention model names or technical identifiers.
Return only this JSON object: {"view":"front","wrong_item":false,"complete_product":100,"no_text_or_watermark":100,"orientation_ok":100,"is_collage":false,"edge_quality":100,"background_clean":100,"evidence":{}}, where evidence maps a check name to its sentence.`;

/** Plain words for the product type line of the judge prompt. */
export const PRODUCT_TYPE_WORDS: Record<string, string> = {
  footwear: "footwear (shoes, boots or sandals)",
  apparel_model: "apparel worn on a model",
  apparel_flat: "apparel laid flat or shown without a model",
  bag_accessory: "a bag or accessory",
  other: "a general product",
  auto: "not known",
};

export const PRODUCT_TYPE_TEMPLATE = `Classify the product in this photo as one of:
footwear: shoes, boots or sandals;
apparel_model: apparel worn on a model;
apparel_flat: apparel laid flat or shown without a model;
bag_accessory: a bag or accessory;
other: anything else.
Return only {"type":"footwear|apparel_model|apparel_flat|bag_accessory|other","confidence":0.0,"transparent":false}, with confidence from 0 to 1. Set transparent true only when the product itself is glass, transparent packaging or transparent material.`;

export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/<([a-zA-Z_]+)>/g, (token, key: string) => vars[key] === undefined ? token : String(vars[key]));
}
